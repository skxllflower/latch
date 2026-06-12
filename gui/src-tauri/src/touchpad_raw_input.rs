// Trackpad pinch + pan + activity signal, lifted off raw HID.
//
// Why we're this far down the stack: precision touchpad gestures on
// Windows are consumed by DirectManipulation inside WebView2's renderer
// process. By the time anything surfaces as a JS event, pinch and
// two-finger drag have both been collapsed into the same generic
// `wheel` event stream — indistinguishable from a real mouse-wheel
// notch. The only working hook for clean per-device gesture data is
// the OS HID stack, exposed via the Win32 Raw Input API.
//
// Pipeline:
//   • RegisterRawInputDevices(usage 0x0D/0x05, RIDEV_INPUTSINK) — receive
//     touchpad HID reports even while the WebView2 renderer holds focus.
//   • Subclass the Tauri main HWND so WM_INPUT lands in our wndproc.
//   • Per-device, cache the HID preparsed data + the indexes of each
//     "finger" link-collection (one per contact slot).
//   • Per report, use HidP_GetUsages / HidP_GetUsageValue to extract the
//     active contacts (vendor-agnostic — never hand-parses report bytes,
//     so it survives different touchpad chipsets).
//   • Per frame with 2 contacts, compute BOTH the inter-finger distance
//     change (pinch) AND the centroid translation (pan). Both flow
//     through the same gating (only count when both fingers are
//     actually moving). Emit:
//       - wd-pinch-zoom   <factor: f32>     — multiplicative zoom delta
//       - wd-trackpad-pan <[dx, dy]: f32>   — pan in HID units (fronted
//                                             scales empirically)
//       - wd-trackpad-active <bool>         — true while ≥2 fingers are
//                                             tracked, false on lift-off.
//                                             The frontend uses this to
//                                             suppress wheel events that
//                                             DirectManipulation forwards
//                                             from the same gesture.

#![cfg(target_os = "windows")]

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

// Fork delta vs WAVdesk: events BROADCAST app-wide (app.emit) instead of
// targeting the main window — here the consumers (chop waveform + video)
// live in a satellite window while the subclassed HWND stays the
// always-alive main window (RIDEV_INPUTSINK delivers regardless of
// focus). Hover gates in the consumers filter cross-window noise.
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Devices::HumanInterfaceDevice::{
    HidP_GetCaps, HidP_GetLinkCollectionNodes, HidP_GetUsageValue, HidP_GetUsages, HidP_Input,
    HIDP_CAPS, HIDP_LINK_COLLECTION_NODE, PHIDP_PREPARSED_DATA,
};
use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::{
    GetRawInputData, GetRawInputDeviceInfoW, RegisterRawInputDevices, HRAWINPUT, RAWINPUT,
    RAWINPUTDEVICE, RAWINPUTHEADER, RIDEV_INPUTSINK, RIDI_PREPARSEDDATA, RID_INPUT, RIM_TYPEHID,
};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};

// HID usage codes from the standard HID Usage Tables.
const HID_USAGE_PAGE_GENERIC: u16          = 0x01;
const HID_USAGE_GENERIC_X: u16             = 0x30;
const HID_USAGE_GENERIC_Y: u16             = 0x31;
const HID_USAGE_PAGE_DIGITIZER: u16        = 0x0D;
const HID_USAGE_DIGITIZER_TOUCH_PAD: u16   = 0x05;
const HID_USAGE_DIGITIZER_FINGER: u16      = 0x22;
const HID_USAGE_DIGITIZER_TIP_SWITCH: u16  = 0x42;

const WM_INPUT: u32 = 0x00FF;

// Cached per-device parsing context. Built lazily on the first WM_INPUT
// for each touchpad and reused thereafter — HidP_* calls then just need
// the preparsed-data pointer + the link indexes we already discovered.
struct DeviceParser {
    preparsed: Vec<u8>,
    finger_links: Vec<u16>,
}

#[derive(Clone, Copy, Debug)]
struct Contact {
    x: i32,
    y: i32,
}

// Tracks one continuous 2-finger gesture. Computes pinch (inter-finger
// distance change) AND pan (centroid translation) from the same contact
// stream — they're orthogonal motions of the same fingers, no need for
// two parallel state machines. `last_distance` and `last_centroid` reset
// to None whenever fewer than 2 fingers are present (gesture boundary).
// Both accumulators batch frame-to-frame deltas so we don't emit at the
// full 125 Hz device rate — flushed every ~8ms.
struct GestureTracker {
    // Pinch state.
    last_distance: Option<f32>,
    pinch_accumulator: f32,
    // Pan state. Centroid is the mean (x, y) of the first two contacts;
    // its frame-to-frame delta IS the pan motion.
    last_centroid: Option<(f32, f32)>,
    pan_accumulator: (f32, f32),
    // Active signal. True while we're currently tracking ≥2 fingers.
    // Flipped on transitions only — emitted to the frontend so it can
    // ignore wheel events that DirectManipulation forwards from this
    // same gesture (otherwise we'd handle the pan twice).
    active: bool,
    last_emit: Instant,
    // Per-slot last positions for the per-finger movement check. Slot i
    // here corresponds to position i in the parsed contacts array, which
    // is stable during a continuous gesture (HID finger-link order is
    // deterministic per device). Cleared whenever fewer than 2 fingers
    // are present so a new gesture starts fresh.
    last_positions: Vec<(i32, i32)>,
}

// Per-frame movement (in HID units) below which we treat a finger as
// "resting". Tuned against precision-touchpad data: a still finger
// typically jitters 0–1 units between reports; a deliberately moving
// finger shows 3+ units even at slow speeds. Both fingers must clear
// this threshold for a frame's deltas to be applied.
const FINGER_MOVE_THRESHOLD: f32 = 2.0;
// Threshold below which an accumulated pan/pinch is considered noise
// and dropped at flush time. Keeps tiny finger jitter from generating
// spurious events while idle.
const PAN_NOISE_THRESHOLD: f32 = 0.5;

impl GestureTracker {
    fn new() -> Self {
        Self {
            last_distance: None,
            pinch_accumulator: 1.0,
            last_centroid: None,
            pan_accumulator: (0.0, 0.0),
            active: false,
            last_emit: Instant::now(),
            last_positions: Vec::new(),
        }
    }

    fn update(&mut self, contacts: &[Contact], app: &AppHandle) {
        if contacts.len() < 2 {
            self.flush(app);
            if self.active {
                let _ = app.emit("wd-trackpad-active", false);
                self.active = false;
            }
            self.last_distance = None;
            self.last_centroid = None;
            self.last_positions.clear();
            return;
        }

        if !self.active {
            let _ = app.emit("wd-trackpad-active", true);
            self.active = true;
        }

        // Per-finger movement check: only count this frame's deltas
        // (pinch and pan both) if BOTH fingers actually moved. Lets a
        // user rest their thumb on the trackpad and use the other
        // finger as a cursor without triggering gestures.
        let mut both_moving = false;
        if self.last_positions.len() == contacts.len() {
            let mut all_moved = true;
            for (i, c) in contacts.iter().enumerate().take(2) {
                let (px, py) = self.last_positions[i];
                let dx = (c.x - px) as f32;
                let dy = (c.y - py) as f32;
                if (dx * dx + dy * dy).sqrt() < FINGER_MOVE_THRESHOLD {
                    all_moved = false;
                    break;
                }
            }
            both_moving = all_moved;
        }
        // Refresh stored positions for next frame's diff (do this even
        // when we skipped accumulation this frame — we want accurate
        // "previous" coordinates so the *next* frame's deltas are real).
        self.last_positions.clear();
        self.last_positions.extend(contacts.iter().map(|c| (c.x, c.y)));

        // Pinch — distance between the first two contacts. We don't try
        // to track contact identity across reports; for distance ratios
        // the slot→finger mapping doesn't matter.
        let dx = (contacts[0].x - contacts[1].x) as f32;
        let dy = (contacts[0].y - contacts[1].y) as f32;
        let dist = (dx * dx + dy * dy).sqrt();

        if let Some(prev) = self.last_distance {
            // Guard against degenerate cases (fingers atop each other —
            // happens at gesture boundaries) that would explode the ratio.
            // Apply the ratio only when both fingers moved this frame.
            if prev > 4.0 && dist > 4.0 && both_moving {
                self.pinch_accumulator *= dist / prev;
            }
        }
        self.last_distance = Some(dist);

        // Pan — centroid translation. cx/cy are the mean of the first
        // two contacts; their frame-to-frame delta is the pan motion in
        // HID units. Same both_moving gate as pinch so a resting thumb
        // doesn't generate phantom pan from the moving finger alone.
        let cx = (contacts[0].x as f32 + contacts[1].x as f32) * 0.5;
        let cy = (contacts[0].y as f32 + contacts[1].y as f32) * 0.5;
        if let Some((px, py)) = self.last_centroid {
            if both_moving {
                self.pan_accumulator.0 += cx - px;
                self.pan_accumulator.1 += cy - py;
            }
        }
        self.last_centroid = Some((cx, cy));

        if self.last_emit.elapsed().as_millis() >= 8 {
            self.flush(app);
        }
    }

    fn flush(&mut self, app: &AppHandle) {
        if (self.pinch_accumulator - 1.0).abs() > 1e-4 {
            let _ = app.emit("wd-pinch-zoom", self.pinch_accumulator);
        }
        self.pinch_accumulator = 1.0;

        let (pdx, pdy) = self.pan_accumulator;
        if pdx.abs() > PAN_NOISE_THRESHOLD || pdy.abs() > PAN_NOISE_THRESHOLD {
            let _ = app.emit("wd-trackpad-pan", (pdx, pdy));
        }
        self.pan_accumulator = (0.0, 0.0);

        self.last_emit = Instant::now();
    }
}

struct State {
    parsers: HashMap<isize, DeviceParser>,
    tracker: GestureTracker,
    app: AppHandle,
}

static STATE: OnceLock<Mutex<State>> = OnceLock::new();

pub fn install(app: &AppHandle) {
    let main_win = match app.get_webview_window("main") {
        Some(w) => w,
        None => {
            log::warn!("touchpad: no main window");
            return;
        }
    };
    let hwnd = match main_win.hwnd() {
        Ok(h) => h,
        Err(e) => {
            log::warn!("touchpad: hwnd() failed: {:?}", e);
            return;
        }
    };

    if STATE
        .set(Mutex::new(State {
            parsers: HashMap::new(),
            tracker: GestureTracker::new(),
            app: app.clone(),
        }))
        .is_err()
    {
        log::warn!("touchpad: STATE already initialized");
        return;
    }

    unsafe {
        if !SetWindowSubclass(hwnd, Some(rawinput_subclass), 1, 0).as_bool() {
            log::warn!("touchpad: SetWindowSubclass failed");
            return;
        }
        let dev = RAWINPUTDEVICE {
            usUsagePage: HID_USAGE_PAGE_DIGITIZER,
            usUsage: HID_USAGE_DIGITIZER_TOUCH_PAD,
            // RIDEV_INPUTSINK: deliver WM_INPUT regardless of focus —
            // required because WebView2's renderer normally holds focus.
            dwFlags: RIDEV_INPUTSINK,
            hwndTarget: hwnd,
        };
        match RegisterRawInputDevices(&[dev], std::mem::size_of::<RAWINPUTDEVICE>() as u32) {
            Ok(()) => log::info!("touchpad: ready (HID 0x0D/0x05 on {:?})", hwnd.0),
            Err(e) => log::warn!("touchpad: RegisterRawInputDevices failed: {:?}", e),
        }
    }
}

unsafe extern "system" fn rawinput_subclass(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _uid: usize,
    _data: usize,
) -> LRESULT {
    if msg == WM_INPUT {
        unsafe {
            // SAFETY: lParam of WM_INPUT is documented as a valid HRAWINPUT
            // for the duration of the dispatch.
            handle_wm_input(HRAWINPUT(lparam.0 as *mut _));
        }
    }
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

unsafe fn handle_wm_input(h: HRAWINPUT) {
    let header_size = std::mem::size_of::<RAWINPUTHEADER>() as u32;

    // Two-call pattern to size the buffer.
    let mut cb: u32 = 0;
    if unsafe { GetRawInputData(h, RID_INPUT, None, &mut cb, header_size) } == u32::MAX {
        return;
    }
    if cb == 0 {
        return;
    }
    let mut buf = vec![0u8; cb as usize];
    let n = unsafe {
        GetRawInputData(
            h,
            RID_INPUT,
            Some(buf.as_mut_ptr() as *mut _),
            &mut cb,
            header_size,
        )
    };
    if n == u32::MAX || n == 0 {
        return;
    }

    // SAFETY: GetRawInputData wrote a complete RAWINPUT structure starting
    // at buf.as_ptr().
    let raw = unsafe { &*(buf.as_ptr() as *const RAWINPUT) };
    if raw.header.dwType != RIM_TYPEHID.0 {
        return;
    }

    let device_handle = raw.header.hDevice.0 as isize;
    let hid = unsafe { &raw.data.hid };
    let report_size = hid.dwSizeHid as usize;
    let report_count = hid.dwCount as usize;
    if report_size == 0 || report_count == 0 {
        return;
    }

    // SAFETY: bRawData is a flexible array of `dwSizeHid * dwCount` bytes,
    // immediately following the RAWHID header in the same allocation.
    let report_buf = unsafe {
        std::slice::from_raw_parts(hid.bRawData.as_ptr(), report_size * report_count)
    };

    let state_mutex = match STATE.get() {
        Some(s) => s,
        None => return,
    };
    let mut state = match state_mutex.lock() {
        Ok(s) => s,
        Err(_) => return,
    };

    if !state.parsers.contains_key(&device_handle) {
        match build_parser(raw.header.hDevice) {
            Some(parser) => {
                log::info!(
                    "touchpad: parsed device {:?} — {} contact slots",
                    raw.header.hDevice.0,
                    parser.finger_links.len()
                );
                state.parsers.insert(device_handle, parser);
            }
            None => {
                log::warn!(
                    "touchpad: failed to build parser for {:?}",
                    raw.header.hDevice.0
                );
                return;
            }
        }
    }

    // WM_INPUT can deliver multiple back-to-back reports in one dispatch;
    // walk them sequentially so we don't drop intermediate samples (those
    // matter for distance smoothing).
    let mut contacts: Vec<Contact> = Vec::with_capacity(8);
    for r in 0..report_count {
        let one_report = &report_buf[r * report_size..(r + 1) * report_size];
        contacts.clear();
        let parser = state.parsers.get(&device_handle).expect("just inserted");
        for &link in &parser.finger_links {
            if let Some(c) = parse_contact(parser, link, one_report) {
                contacts.push(c);
            }
        }
        let app = state.app.clone();
        state.tracker.update(&contacts, &app);
    }
}

// Build a DeviceParser by walking the HID descriptor: find the input
// link-collection nodes whose Usage is "Finger" (one per contact slot).
// Each finger collection contains its own X, Y, and Tip Switch usages,
// which the HidP_* APIs will then resolve correctly per-collection.
fn build_parser(device: HANDLE) -> Option<DeviceParser> {
    unsafe {
        let mut size: u32 = 0;
        if GetRawInputDeviceInfoW(Some(device), RIDI_PREPARSEDDATA, None, &mut size) == u32::MAX
            || size == 0
        {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        if GetRawInputDeviceInfoW(
            Some(device),
            RIDI_PREPARSEDDATA,
            Some(buf.as_mut_ptr() as *mut _),
            &mut size,
        ) == u32::MAX
        {
            return None;
        }

        let preparsed = PHIDP_PREPARSED_DATA(buf.as_ptr() as isize);

        let mut caps = HIDP_CAPS::default();
        if !HidP_GetCaps(preparsed, &mut caps).is_ok() {
            return None;
        }

        let node_count = caps.NumberLinkCollectionNodes as u32;
        if node_count == 0 {
            return None;
        }
        let mut nodes = vec![HIDP_LINK_COLLECTION_NODE::default(); node_count as usize];
        let mut returned = node_count;
        if !HidP_GetLinkCollectionNodes(nodes.as_mut_ptr(), &mut returned, preparsed).is_ok() {
            return None;
        }

        let mut finger_links = Vec::new();
        for (i, node) in nodes.iter().enumerate().take(returned as usize) {
            if node.LinkUsagePage == HID_USAGE_PAGE_DIGITIZER
                && node.LinkUsage == HID_USAGE_DIGITIZER_FINGER
            {
                finger_links.push(i as u16);
            }
        }
        if finger_links.is_empty() {
            return None;
        }

        Some(DeviceParser {
            preparsed: buf,
            finger_links,
        })
    }
}

// Extract a single contact (X, Y) from one report at the given finger
// link-collection index. Returns None if the tip switch is off (finger
// not actually touching) or any HID lookup fails.
//
// HidP_GetUsages takes &mut [u8] so we copy the report locally — the
// outer report buffer is shared across all finger-link queries within a
// dispatch and we don't want any of these calls accidentally clobbering
// it (the API does in fact only read in practice, but signature is &mut).
fn parse_contact(parser: &DeviceParser, link: u16, report: &[u8]) -> Option<Contact> {
    unsafe {
        let preparsed = PHIDP_PREPARSED_DATA(parser.preparsed.as_ptr() as isize);
        let mut report_local: Vec<u8> = report.to_vec();

        // Tip switch check — HidP_GetUsages returns the list of buttons
        // currently pressed within the (page, link). On the digitizer
        // page, the tip switch usage (0x42) being present means the
        // contact is actually touching the surface.
        let mut usage_buf = [0u16; 16];
        let mut usage_len: u32 = usage_buf.len() as u32;
        if !HidP_GetUsages(
            HidP_Input,
            HID_USAGE_PAGE_DIGITIZER,
            Some(link),
            usage_buf.as_mut_ptr(),
            &mut usage_len,
            preparsed,
            &mut report_local,
        )
        .is_ok()
        {
            return None;
        }
        let tip_on = usage_buf[..usage_len as usize]
            .iter()
            .any(|&u| u == HID_USAGE_DIGITIZER_TIP_SWITCH);
        if !tip_on {
            return None;
        }

        let mut x: u32 = 0;
        let mut y: u32 = 0;
        if !HidP_GetUsageValue(
            HidP_Input,
            HID_USAGE_PAGE_GENERIC,
            Some(link),
            HID_USAGE_GENERIC_X,
            &mut x,
            preparsed,
            &report_local,
        )
        .is_ok()
        {
            return None;
        }
        if !HidP_GetUsageValue(
            HidP_Input,
            HID_USAGE_PAGE_GENERIC,
            Some(link),
            HID_USAGE_GENERIC_Y,
            &mut y,
            preparsed,
            &report_local,
        )
        .is_ok()
        {
            return None;
        }

        Some(Contact {
            x: x as i32,
            y: y as i32,
        })
    }
}
