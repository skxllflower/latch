// Which device produced the scroll the webview is about to see (macOS).
//
// A WKWebView wheel event cannot say whether it came from a notched mouse wheel
// or a trackpad: WebKit hands both over as deltaMode 0 pixel deltas, and a slow
// mouse notch (AppKit's accelerated 0.1 line, x40 px) arrives as deltaY 4, the
// same number a trackpad emits. AppKit knows: a notched wheel is the only source
// with `hasPreciseScrollingDeltas == NO`, and a trackpad or Magic Mouse touch
// always carries a non-zero `phase` (fingers down) or `momentumPhase` (inertia).
//
// A local NSEvent monitor sees every scroll on the main thread before AppKit
// dispatches it to the WKWebView, classifies it, and only when the source CHANGES
// writes `window.__wdScrollSource` into every webview with evaluateJavaScript
// (no per-event IPC). Probed on WebKit (macOS 26): a script evaluated from the
// monitor always ran before the wheel event it precedes (scripts run straight
// away; WebKit queues and coalesces wheel events), so a device switch, which
// takes a human far longer than one event gap, is tagged before its first event.
// Magnify (pinch) also marks the source as touch, so a pinch WebKit may surface
// as ctrl+wheel can never inherit a mouse tag.

use serde::Serialize;
use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ScrollSource {
    /// Notched mouse wheel: imprecise line deltas.
    Wheel,
    /// Precise deltas with no touch phase: a mouse behind a smooth-scrolling
    /// utility (or a free-spinning hi-res wheel driver). Still a mouse.
    Smooth,
    /// Trackpad or Magic Mouse surface: a finger phase or momentum is present.
    Touch,
}

impl ScrollSource {
    pub fn as_str(self) -> &'static str {
        match self {
            ScrollSource::Wheel => "wheel",
            ScrollSource::Smooth => "smooth",
            ScrollSource::Touch => "touch",
        }
    }
    fn code(self) -> u8 {
        match self {
            ScrollSource::Wheel => 1,
            ScrollSource::Smooth => 2,
            ScrollSource::Touch => 3,
        }
    }
    fn from_code(c: u8) -> Option<Self> {
        match c {
            1 => Some(ScrollSource::Wheel),
            2 => Some(ScrollSource::Smooth),
            3 => Some(ScrollSource::Touch),
            _ => None,
        }
    }
}

/// Phase or momentum first: a Magic Mouse and a trackpad report precise deltas
/// AND phases, while a smoothing utility synthesizes precise deltas without
/// any finger phase.
pub fn classify(precise: bool, phase: u64, momentum_phase: u64) -> ScrollSource {
    if phase != 0 || momentum_phase != 0 {
        ScrollSource::Touch
    } else if !precise {
        ScrollSource::Wheel
    } else {
        ScrollSource::Smooth
    }
}

static CURRENT: AtomicU8 = AtomicU8::new(0);

/// Records `src` as the current source; true when it differs from the last one.
fn note(src: ScrollSource) -> bool {
    CURRENT.swap(src.code(), Ordering::Relaxed) != src.code()
}

pub fn current() -> Option<ScrollSource> {
    ScrollSource::from_code(CURRENT.load(Ordering::Relaxed))
}

/// The script each webview evaluates on a change. `dy` is the raw AppKit value
/// of the event that flipped the source, kept for the frontend's wheel receipt.
fn tag_script(src: ScrollSource, precise: bool, phase: u64, momentum: u64, dy: f64) -> String {
    let dy = if dy.is_finite() { dy } else { 0.0 };
    format!(
        "window.__wdScrollSource={{src:'{}',precise:{},phase:{},mom:{},dy:{:.4},at:Date.now()}}",
        src.as_str(), precise, phase, momentum, dy
    )
}

/// Seed for a webview created after the last change (the push only goes out on
/// a change, so a fresh pop-out would otherwise wait for the next device swap).
#[tauri::command]
pub fn mac_scroll_source() -> Option<ScrollSource> {
    current()
}

#[cfg(target_os = "macos")]
pub fn install(app: &tauri::AppHandle) {
    let _ = app.run_on_main_thread(|| unsafe { imp::install() });
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{classify, note, tag_script, ScrollSource};
    use block2::{Block, RcBlock};
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;
    use std::sync::Mutex;
    use std::time::Instant;

    const NS_EVENT_TYPE_SCROLL_WHEEL: usize = 22;
    const NS_EVENT_TYPE_MAGNIFY: usize = 30;
    const MASK: u64 = (1u64 << NS_EVENT_TYPE_SCROLL_WHEEL) | (1u64 << NS_EVENT_TYPE_MAGNIFY);

    pub unsafe fn install() {
        let handler = RcBlock::new(|ev: *mut AnyObject| -> *mut AnyObject {
            if !ev.is_null() {
                unsafe { on_event(ev) };
            }
            ev
        });
        let monitor: *mut AnyObject = msg_send![
            class!(NSEvent),
            addLocalMonitorForEventsMatchingMask: MASK,
            handler: &*handler
        ];
        if monitor.is_null() {
            log::warn!("[scroll-source] NSEvent local monitor refused; wheel falls back to the webview heuristic");
            return;
        }
        // Never removed: the monitor lives for the app's lifetime.
        let _: *mut AnyObject = msg_send![monitor, retain];
        log::info!("[scroll-source] NSEvent scroll monitor installed");
    }

    unsafe fn on_event(ev: *mut AnyObject) {
        let ty: usize = msg_send![ev, type];
        let (src, precise, phase, momentum, dy) = if ty == NS_EVENT_TYPE_MAGNIFY {
            (ScrollSource::Touch, true, 0, 0, 0.0)
        } else if ty == NS_EVENT_TYPE_SCROLL_WHEEL {
            let precise: bool = msg_send![ev, hasPreciseScrollingDeltas];
            let phase: usize = msg_send![ev, phase];
            let momentum: usize = msg_send![ev, momentumPhase];
            let dy: f64 = msg_send![ev, scrollingDeltaY];
            (classify(precise, phase as u64, momentum as u64), precise, phase as u64, momentum as u64, dy)
        } else {
            return;
        };
        if !note(src) {
            return;
        }
        publish(&tag_script(src, precise, phase, momentum, dy));
        receipt(src, precise, phase, momentum, dy, ty == NS_EVENT_TYPE_MAGNIFY);
    }

    unsafe fn publish(script: &str) {
        let Some(wk) = AnyClass::get(c"WKWebView") else { return };
        let js = NSString::from_str(script);
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        if app.is_null() {
            return;
        }
        let windows: *mut AnyObject = msg_send![app, windows];
        if windows.is_null() {
            return;
        }
        let count: usize = msg_send![windows, count];
        for i in 0..count {
            let w: *mut AnyObject = msg_send![windows, objectAtIndex: i];
            let content: *mut AnyObject = msg_send![w, contentView];
            if !content.is_null() {
                eval_in_tree(content, wk, &js, 0);
            }
        }
    }

    unsafe fn eval_in_tree(view: *mut AnyObject, wk: &AnyClass, js: &NSString, depth: u32) {
        let is_wk: bool = msg_send![view, isKindOfClass: wk];
        if is_wk {
            let _: () = msg_send![
                view,
                evaluateJavaScript: js,
                completionHandler: None::<&Block<dyn Fn(*mut AnyObject, *mut AnyObject)>>
            ];
            return;
        }
        if depth >= 6 {
            return;
        }
        let subviews: *mut AnyObject = msg_send![view, subviews];
        if subviews.is_null() {
            return;
        }
        let n: usize = msg_send![subviews, count];
        for i in 0..n {
            let v: *mut AnyObject = msg_send![subviews, objectAtIndex: i];
            if !v.is_null() {
                eval_in_tree(v, wk, js, depth + 1);
            }
        }
    }

    // A few lines a minute at most: a trackpad flick's momentum interleaved with
    // a mouse spin can flip the source on every event.
    fn receipt(src: ScrollSource, precise: bool, phase: u64, momentum: u64, dy: f64, magnify: bool) {
        static BUDGET: Mutex<Option<(Instant, u32)>> = Mutex::new(None);
        let mut g = match BUDGET.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let now = Instant::now();
        let (start, used) = g.get_or_insert((now, 0));
        if now.duration_since(*start).as_secs() >= 60 {
            *start = now;
            *used = 0;
        }
        if *used >= 8 {
            return;
        }
        *used += 1;
        drop(g);
        log::warn!(
            "[scroll-source] source -> {} ({}precise={precise} phase={phase} momentum={momentum} scrollingDeltaY={dy:.4})",
            src.as_str(),
            if magnify { "magnify " } else { "" },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // NSEventPhase bits: Began 1, Stationary 2, Changed 4, Ended 8, Cancelled 16, MayBegin 32.
    #[test]
    fn notched_wheel_is_wheel() {
        assert_eq!(classify(false, 0, 0), ScrollSource::Wheel);
    }

    #[test]
    fn trackpad_phases_are_touch() {
        for phase in [1, 2, 4, 8, 16, 32] {
            assert_eq!(classify(true, phase, 0), ScrollSource::Touch, "phase {phase}");
        }
    }

    #[test]
    fn momentum_tail_is_touch() {
        for mom in [1, 4, 8] {
            assert_eq!(classify(true, 0, mom), ScrollSource::Touch, "momentum {mom}");
        }
    }

    #[test]
    fn magic_mouse_is_touch() {
        assert_eq!(classify(true, 4, 0), ScrollSource::Touch);
        assert_eq!(classify(true, 0, 4), ScrollSource::Touch);
    }

    #[test]
    fn smooth_scroll_utility_is_smooth() {
        assert_eq!(classify(true, 0, 0), ScrollSource::Smooth);
    }

    #[test]
    fn imprecise_with_phase_still_touch() {
        assert_eq!(classify(false, 4, 0), ScrollSource::Touch);
    }

    #[test]
    fn change_detection_and_codes_round_trip() {
        for s in [ScrollSource::Wheel, ScrollSource::Smooth, ScrollSource::Touch] {
            assert_eq!(ScrollSource::from_code(s.code()), Some(s));
        }
        assert_eq!(ScrollSource::from_code(0), None);
        note(ScrollSource::Touch);
        assert!(!note(ScrollSource::Touch));
        assert!(note(ScrollSource::Wheel));
        assert!(!note(ScrollSource::Wheel));
        assert_eq!(current(), Some(ScrollSource::Wheel));
    }

    #[test]
    fn tag_script_shape() {
        let s = tag_script(ScrollSource::Wheel, false, 0, 0, -0.1);
        assert_eq!(s, "window.__wdScrollSource={src:'wheel',precise:false,phase:0,mom:0,dy:-0.1000,at:Date.now()}");
        let nan = tag_script(ScrollSource::Touch, true, 4, 0, f64::NAN);
        assert!(nan.contains("dy:0.0000"));
    }
}
