use serde::Serialize;

#[derive(Serialize)]
pub struct MacVideoState {
    pub active: bool,
    pub sec: f64,
    pub duration: f64,
    pub width: f64,
    pub height: f64,
    pub playing: bool,
    pub recovered_loop: bool,
}

#[cfg(target_os = "macos")]
mod imp {
    use super::MacVideoState;
    use objc2::{class, msg_send, sel};
    use objc2::encode::{Encode, Encoding, RefEncode};
    use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Sel};
    use std::collections::{HashMap, HashSet};
    use std::sync::{Mutex, OnceLock};
    use tauri::Manager;

    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}
    #[link(name = "QuartzCore", kind = "framework")]
    extern "C" {}
    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" { fn CGImageRelease(image: *const std::ffi::c_void); }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CMTime { value: i64, timescale: i32, flags: u32, epoch: i64 }
    unsafe impl Encode for CMTime {
        const ENCODING: Encoding = Encoding::Struct("CMTime", &[i64::ENCODING, i32::ENCODING, u32::ENCODING, i64::ENCODING]);
    }
    unsafe impl RefEncode for CMTime {
        const ENCODING_REF: Encoding = Encoding::Pointer(&Self::ENCODING);
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CMTimeRange { start: CMTime, duration: CMTime }
    unsafe impl Encode for CMTimeRange {
        const ENCODING: Encoding = Encoding::Struct("CMTimeRange", &[CMTime::ENCODING, CMTime::ENCODING]);
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint { x: f64, y: f64 }
    unsafe impl Encode for CGPoint {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGSize { width: f64, height: f64 }
    unsafe impl Encode for CGSize {
        const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGRect { origin: CGPoint, size: CGSize }
    unsafe impl Encode for CGRect {
        const ENCODING: Encoding = Encoding::Struct("CGRect", &[CGPoint::ENCODING, CGSize::ENCODING]);
    }

    fn time(sec: f64) -> CMTime {
        CMTime { value: (sec.max(0.0) * 600.0).round() as i64, timescale: 600, flags: 1, epoch: 0 }
    }

    struct Session {
        player: usize, layer: usize, view: usize, looper: usize, item: usize,
        snapshot: usize, desired_rate: f32, loop_start: f64, loop_end: f64,
        wants_playing: bool,
    }
    unsafe impl Send for Session {}
    static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    fn sessions() -> &'static Mutex<HashMap<String, Session>> {
        SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
    }
    type Transform = (f64, f64, f64, f64, f64);
    static PENDING_TRANSFORMS: OnceLock<Mutex<HashMap<String, Transform>>> = OnceLock::new();
    static SCHEDULED_TRANSFORMS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    fn pending_transforms() -> &'static Mutex<HashMap<String, Transform>> {
        PENDING_TRANSFORMS.get_or_init(|| Mutex::new(HashMap::new()))
    }
    fn scheduled_transforms() -> &'static Mutex<HashSet<String>> {
        SCHEDULED_TRANSFORMS.get_or_init(|| Mutex::new(HashSet::new()))
    }

    // A normal child NSView steals wheel/drag/tap input from WKWebView. This
    // tiny subclass displays the native layer but deliberately never wins hit
    // testing, so the existing React canvas gesture system remains in charge.
    unsafe extern "C-unwind" fn passthrough_hit_test(
        _this: &AnyObject,
        _cmd: Sel,
        _point: CGPoint,
    ) -> *mut AnyObject {
        std::ptr::null_mut()
    }
    fn overlay_class() -> &'static AnyClass {
        static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
        CLASS.get_or_init(|| {
            if let Some(c) = AnyClass::get(c"LatchVideoOverlay") { return c; }
            let mut b = ClassBuilder::new(c"LatchVideoOverlay", class!(NSView)).expect("overlay class");
            unsafe {
                b.add_method(sel!(hitTest:), passthrough_hit_test as unsafe extern "C-unwind" fn(_, _, _) -> _);
            }
            b.register()
        })
    }

    unsafe fn release(p: usize) { if p != 0 { let _: () = msg_send![p as *mut AnyObject, release]; } }
    unsafe fn destroy(s: Session) {
        let player = s.player as *mut AnyObject;
        let view = s.view as *mut AnyObject;
        let _: () = msg_send![player, pause];
        let _: () = msg_send![view, removeFromSuperview];
        release(s.snapshot); release(s.looper); release(s.view); release(s.layer); release(s.player); release(s.item);
    }

    pub fn open(app: tauri::AppHandle, label: String, path: String, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
        let window = app.get_webview_window(&label).ok_or("window not found")?;
        let ns_view = window.ns_view().map_err(|e| e.to_string())? as usize;
        window.run_on_main_thread(move || unsafe {
            if let Some(old) = sessions().lock().unwrap().remove(&label) { destroy(old); }
            let c_path = std::ffi::CString::new(path).unwrap_or_default();
            let ns_path: *mut AnyObject = msg_send![class!(NSString), stringWithUTF8String: c_path.as_ptr()];
            let url: *mut AnyObject = msg_send![class!(NSURL), fileURLWithPath: ns_path];
            let item: *mut AnyObject = msg_send![class!(AVPlayerItem), playerItemWithURL: url];
            let _: *mut AnyObject = msg_send![item, retain];
            let player: *mut AnyObject = msg_send![class!(AVQueuePlayer), alloc];
            let player: *mut AnyObject = msg_send![player, init];
            let _: () = msg_send![player, insertItem: item, afterItem: std::ptr::null_mut::<AnyObject>()];
            let layer: *mut AnyObject = msg_send![class!(AVPlayerLayer), playerLayerWithPlayer: player];
            let _: *mut AnyObject = msg_send![layer, retain];
            let view = ns_view as *mut AnyObject;
            let frame = CGRect { origin: CGPoint { x, y }, size: CGSize { width: w, height: h } };
            let overlay: *mut AnyObject = msg_send![overlay_class(), alloc];
            let overlay: *mut AnyObject = msg_send![overlay, initWithFrame: frame];
            let _: () = msg_send![overlay, setWantsLayer: true];
            let root: *mut AnyObject = msg_send![overlay, layer];
            let _: () = msg_send![root, setMasksToBounds: true];
            let _: () = msg_send![root, setZPosition: 10000.0f64];
            let _: () = msg_send![layer, setZPosition: 10001.0f64];
            let _: () = msg_send![layer, setFrame: CGRect { origin: CGPoint { x: 0.0, y: 0.0 }, size: CGSize { width: w, height: h } }];
            let _: () = msg_send![root, addSublayer: layer];
            let _: () = msg_send![view, addSubview: overlay, positioned: 1i64, relativeTo: std::ptr::null_mut::<AnyObject>()];
            let _: () = msg_send![player, setActionAtItemEnd: 2i64];
            // Keep the currently presented frame up until AVFoundation has the
            // destination frame ready. Local files preroll quickly, while the
            // eager setting produced a one-frame black clear on starts/seeks.
            let _: () = msg_send![player, setAutomaticallyWaitsToMinimizeStalling: true];
            sessions().lock().unwrap().insert(label, Session {
                player: player as usize, layer: layer as usize, view: overlay as usize, looper: 0, item: item as usize,
                snapshot: 0, desired_rate: 1.0, loop_start: -1.0, loop_end: -1.0,
                wants_playing: false,
            });
        }).map_err(|e| e.to_string())
    }

    fn command_now(label: String, action: String, sec: f64, end: f64) {
        let mut map = sessions().lock().unwrap();
        let Some(s) = map.get_mut(&label) else { return; };
        unsafe {
            let player = s.player as *mut AnyObject;
            match action.as_str() {
                "play" => {
                    s.wants_playing = true;
                    let current: CMTime = msg_send![player, currentTime];
                    let duration: CMTime = msg_send![s.item as *mut AnyObject, duration];
                    let cur_s = if current.timescale > 0 { current.value as f64 / current.timescale as f64 } else { 0.0 };
                    let dur_s = if duration.timescale > 0 { duration.value as f64 / duration.timescale as f64 } else { 0.0 };
                    if dur_s > 0.0 && cur_s >= dur_s - 1.0 / 120.0 {
                        let current_item: *mut AnyObject = msg_send![player, currentItem];
                        if !current_item.is_null() {
                            let tolerance = time(1.0 / 120.0);
                            let _: () = msg_send![current_item, seekToTime: time(0.0), toleranceBefore: tolerance, toleranceAfter: tolerance];
                        }
                    }
                    let _: () = msg_send![player, playImmediatelyAtRate: s.desired_rate];
                }
                "pause" => { s.wants_playing = false; let _: () = msg_send![player, pause]; }
                "seek" => {
                    // A sub-frame tolerance still lands at the requested visual
                    // frame, but lets AVFoundation retain its decode pipeline
                    // instead of flushing the player layer to black.
                    let tolerance = time(1.0 / 120.0);
                    // Seek the currently presented item, not AVQueuePlayer.
                    // Queue-level seeks flush AVPlayerLayer's presentation
                    // pipeline (a visible black frame) even for local media.
                    let current_item: *mut AnyObject = msg_send![player, currentItem];
                    if !current_item.is_null() {
                        let _: () = msg_send![current_item, seekToTime: time(sec), toleranceBefore: tolerance, toleranceAfter: tolerance];
                    }
                }
                "rate" => {
                    s.desired_rate = (sec as f32).clamp(0.25, 4.0);
                    let current: f32 = msg_send![player, rate];
                    if s.wants_playing || current != 0.0 { let _: () = msg_send![player, playImmediatelyAtRate: s.desired_rate]; }
                }
                "volume" => { let _: () = msg_send![player, setVolume: sec.clamp(0.0, 1.0) as f32]; }
                "reveal" => {
                    if s.snapshot != 0 {
                        let snap = s.snapshot as *mut AnyObject;
                        let _: () = msg_send![snap, removeFromSuperlayer];
                        release(s.snapshot); s.snapshot = 0;
                    }
                }
                "loop" => {
                    if (s.loop_start - sec).abs() < 1.0 / 600.0 && (s.loop_end - end).abs() < 1.0 / 600.0 {
                        return;
                    }
                    s.loop_start = sec; s.loop_end = end;
                    let old_rate: f32 = msg_send![player, rate];
                    let _: () = msg_send![player, pause];
                    // AVQueuePlayer clears AVPlayerLayer while its looper queue
                    // is rebuilt. Hold the currently displayed source frame in
                    // a plain CALayer until the replacement item has rendered.
                    if s.snapshot != 0 { let _: () = msg_send![s.snapshot as *mut AnyObject, removeFromSuperlayer]; release(s.snapshot); s.snapshot = 0; }
                    let asset: *mut AnyObject = msg_send![s.item as *mut AnyObject, asset];
                    let generator: *mut AnyObject = msg_send![class!(AVAssetImageGenerator), assetImageGeneratorWithAsset: asset];
                    let _: () = msg_send![generator, setAppliesPreferredTrackTransform: true];
                    let now: CMTime = msg_send![player, currentTime];
                    let image: *mut std::ffi::c_void = msg_send![generator, copyCGImageAtTime: now, actualTime: std::ptr::null_mut::<CMTime>(), error: std::ptr::null_mut::<*mut AnyObject>()];
                    if !image.is_null() {
                        let snap: *mut AnyObject = msg_send![class!(CALayer), layer];
                        let _: *mut AnyObject = msg_send![snap, retain];
                        let frame: CGRect = msg_send![s.layer as *mut AnyObject, frame];
                        let gravity: *mut AnyObject = msg_send![class!(NSString), stringWithUTF8String: c"resizeAspect".as_ptr()];
                        let _: () = msg_send![snap, setFrame: frame];
                        let _: () = msg_send![snap, setContentsGravity: gravity];
                        let _: () = msg_send![snap, setContents: image as *mut AnyObject];
                        let parent: *mut AnyObject = msg_send![s.layer as *mut AnyObject, superlayer];
                        let _: () = msg_send![parent, addSublayer: snap];
                        s.snapshot = snap as usize;
                        CGImageRelease(image);
                    }
                    if s.looper != 0 { let _: () = msg_send![s.looper as *mut AnyObject, disableLooping]; release(s.looper); s.looper = 0; }
                    let _: () = msg_send![player, removeAllItems];
                    if end > sec {
                        // AVPlayerLooper fills AVQueuePlayer with replicas and
                        // relies on the queue advancing at each item boundary.
                        // `None` (2), used for ordinary EOF frame retention,
                        // intermittently stranded a valid looper on its first
                        // replica. Region mode must use `Advance` (0).
                        let _: () = msg_send![player, setActionAtItemEnd: 0i64];
                        // Local media does not benefit from AVPlayer's
                        // conservative network-style transition waiting. It
                        // can otherwise pause one replica while the next one
                        // prerolls, then remain seamless once the queue fills.
                        let _: () = msg_send![player, setAutomaticallyWaitsToMinimizeStalling: false];
                        let range = CMTimeRange { start: time(sec), duration: time(end - sec) };
                        // Never recycle the originally presented item as a
                        // looper template after it has travelled through an
                        // old queue. A fresh item gives every looper a clean
                        // replica/preroll state while sharing the same asset.
                        let asset: *mut AnyObject = msg_send![s.item as *mut AnyObject, asset];
                        let template: *mut AnyObject = msg_send![class!(AVPlayerItem), playerItemWithAsset: asset];
                        let looper: *mut AnyObject = msg_send![class!(AVPlayerLooper), playerLooperWithPlayer: player, templateItem: template, timeRange: range];
                        let _: *mut AnyObject = msg_send![looper, retain];
                        s.looper = looper as usize;
                        let tolerance = time(1.0 / 120.0);
                        let _: () = msg_send![player, seekToTime: time(sec), toleranceBefore: tolerance, toleranceAfter: tolerance];
                    } else {
                        // Whole-file playback keeps its terminal frame rather
                        // than removing the sole queue item at EOF.
                        let _: () = msg_send![player, setActionAtItemEnd: 2i64];
                        let _: () = msg_send![player, setAutomaticallyWaitsToMinimizeStalling: true];
                        let _: () = msg_send![player, insertItem: s.item as *mut AnyObject, afterItem: std::ptr::null_mut::<AnyObject>()];
                    }
                    if s.wants_playing || old_rate != 0.0 {
                        let _: () = msg_send![player, playImmediatelyAtRate: s.desired_rate];
                    }
                }
                _ => {}
            }
        }
    }

    pub fn command(app: tauri::AppHandle, label: String, action: String, sec: f64, end: f64) -> Result<(), String> {
        let window = app.get_webview_window(&label).ok_or("window not found")?;
        window.run_on_main_thread(move || command_now(label, action, sec, end)).map_err(|e| e.to_string())
    }

    fn frame_now(label: String, x: f64, y: f64, w: f64, h: f64) {
        let map = sessions().lock().unwrap();
        let Some(s) = map.get(&label) else { return; };
        unsafe { let _: () = msg_send![s.view as *mut AnyObject, setFrame: CGRect { origin: CGPoint { x, y }, size: CGSize { width: w, height: h } }]; }
    }
    pub fn frame(app: tauri::AppHandle, label: String, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
        let window = app.get_webview_window(&label).ok_or("window not found")?;
        window.run_on_main_thread(move || frame_now(label, x, y, w, h)).map_err(|e| e.to_string())
    }

    fn transform_now(label: String, ox: f64, oy: f64, w: f64, h: f64, picture_h: f64) {
        let map = sessions().lock().unwrap();
        let Some(s) = map.get(&label) else { return; };
        // Web/canvas coordinates grow downward; Core Animation coordinates
        // grow upward inside the clipped host view.
        let y = picture_h - oy - h;
        unsafe {
            let _: () = msg_send![class!(CATransaction), begin];
            let _: () = msg_send![class!(CATransaction), setDisableActions: true];
            let _: () = msg_send![s.layer as *mut AnyObject, setFrame: CGRect { origin: CGPoint { x: ox, y }, size: CGSize { width: w, height: h } }];
            if s.snapshot != 0 {
                let _: () = msg_send![s.snapshot as *mut AnyObject, setFrame: CGRect { origin: CGPoint { x: ox, y }, size: CGSize { width: w, height: h } }];
            }
            let _: () = msg_send![class!(CATransaction), commit];
        }
    }
    pub fn transform(app: tauri::AppHandle, label: String, ox: f64, oy: f64, w: f64, h: f64, picture_h: f64) -> Result<(), String> {
        pending_transforms().lock().unwrap().insert(label.clone(), (ox, oy, w, h, picture_h));
        if !scheduled_transforms().lock().unwrap().insert(label.clone()) { return Ok(()); }
        let window = app.get_webview_window(&label).ok_or("window not found")?;
        let scheduled_label = label.clone();
        window.run_on_main_thread(move || {
            scheduled_transforms().lock().unwrap().remove(&label);
            if let Some((ox, oy, w, h, picture_h)) = pending_transforms().lock().unwrap().remove(&label) {
                transform_now(label.clone(), ox, oy, w, h, picture_h);
            }
        }).map_err(|e| {
            scheduled_transforms().lock().unwrap().remove(&scheduled_label);
            e.to_string()
        })
    }

    pub fn state(label: String) -> MacVideoState {
        let mut map = sessions().lock().unwrap();
        let Some(s) = map.get_mut(&label) else { return MacVideoState { active: false, sec: 0.0, duration: 0.0, width: 0.0, height: 0.0, playing: false, recovered_loop: false }; };
        unsafe {
            let player = s.player as *mut AnyObject;
            let t: CMTime = msg_send![player, currentTime];
            let mut rate: f32 = msg_send![player, rate];
            let mut sec = if t.timescale > 0 { t.value as f64 / t.timescale as f64 } else { 0.0 };
            let mut recovered_loop = false;

            // AVPlayerLooper can remain non-null while its queue fails to
            // advance (especially after rapid region swaps). The selected
            // region is a transport invariant, not merely a hint to Looper:
            // once it is genuinely overdue, force the current item back into
            // the cage. Successful gapless wraps never reach this threshold,
            // and whole-file/pass-through playback has cleared loop_start.
            const LOOP_ESCAPE_GRACE_SEC: f64 = 0.050;
            // A valid AVPlayerLooper occasionally enters a momentary waiting
            // state while swapping replicas (time remains inside the range,
            // so the escape watchdog cannot see it). Transport intent is
            // authoritative: kick local playback immediately instead of
            // allowing AVFoundation's transient rate=0 to become an audible
            // pause. User pauses clear wants_playing and are untouched.
            if s.wants_playing && s.loop_end > s.loop_start && rate == 0.0 {
                crate::logger::log(&format!(
                    "mac video: looper transition stalled at {sec:.3}s (loop {:.3}-{:.3}); immediate resume",
                    s.loop_start, s.loop_end,
                ));
                let _: () = msg_send![player, playImmediatelyAtRate: s.desired_rate];
                rate = s.desired_rate;
            }
            if s.loop_end > s.loop_start && sec >= s.loop_end + LOOP_ESCAPE_GRACE_SEC {
                crate::logger::log(&format!(
                    "mac video: AVPlayerLooper escape at {sec:.3}s (loop {:.3}-{:.3}); watchdog recovery",
                    s.loop_start, s.loop_end,
                ));
                let current_item: *mut AnyObject = msg_send![player, currentItem];
                if !current_item.is_null() {
                    let tolerance = time(1.0 / 600.0);
                    let _: () = msg_send![current_item,
                        seekToTime: time(s.loop_start),
                        toleranceBefore: tolerance,
                        toleranceAfter: tolerance
                    ];
                    let _: () = msg_send![player, playImmediatelyAtRate: s.desired_rate];
                    sec = s.loop_start;
                    rate = s.desired_rate;
                    recovered_loop = true;
                }
            }
            let item = s.item as *mut AnyObject;
            let d: CMTime = msg_send![item, duration];
            let sz: CGSize = msg_send![item, presentationSize];
            MacVideoState {
                active: true,
                sec,
                duration: if d.timescale > 0 { d.value as f64 / d.timescale as f64 } else { 0.0 },
                width: sz.width,
                height: sz.height,
                playing: rate != 0.0,
                recovered_loop,
            }
        }
    }

    fn stop_now(label: String) {
        pending_transforms().lock().unwrap().remove(&label);
        scheduled_transforms().lock().unwrap().remove(&label);
        if let Some(s) = sessions().lock().unwrap().remove(&label) { unsafe { destroy(s); } }
    }
    pub fn stop(app: tauri::AppHandle, label: String) -> Result<(), String> {
        let window = app.get_webview_window(&label).ok_or("window not found")?;
        window.run_on_main_thread(move || stop_now(label)).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn mac_video_open(app: tauri::AppHandle, label: String, path: String, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")] { return imp::open(app, label, path, x, y, width, height); }
    #[cfg(not(target_os = "macos"))] { let _ = (app, label, path, x, y, width, height); Ok(()) }
}
#[tauri::command]
pub async fn mac_video_command(app: tauri::AppHandle, label: String, action: String, sec: f64, end: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")] { return imp::command(app, label, action, sec, end); }
    #[cfg(not(target_os = "macos"))] { let _ = (app, label, action, sec, end); Ok(()) }
}
#[tauri::command]
pub fn mac_video_state(label: String) -> MacVideoState {
    #[cfg(target_os = "macos")] { return imp::state(label); }
    #[cfg(not(target_os = "macos"))] { let _ = label; MacVideoState { active: false, sec: 0.0, duration: 0.0, width: 0.0, height: 0.0, playing: false, recovered_loop: false } }
}
#[tauri::command]
pub fn mac_video_frame(app: tauri::AppHandle, label: String, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")] { return imp::frame(app, label, x, y, width, height); }
    #[cfg(not(target_os = "macos"))] { let _ = (app, label, x, y, width, height); Ok(()) }
}
#[tauri::command]
pub fn mac_video_transform(app: tauri::AppHandle, label: String, ox: f64, oy: f64, width: f64, height: f64, picture_height: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")] { return imp::transform(app, label, ox, oy, width, height, picture_height); }
    #[cfg(not(target_os = "macos"))] { let _ = (app, label, ox, oy, width, height, picture_height); Ok(()) }
}
#[tauri::command]
pub fn mac_video_stop(app: tauri::AppHandle, label: String) -> Result<(), String> {
    #[cfg(target_os = "macos")] { return imp::stop(app, label); }
    #[cfg(not(target_os = "macos"))] { let _ = (app, label); Ok(()) }
}
