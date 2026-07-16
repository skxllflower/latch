use serde::Serialize;

#[derive(Serialize)]
pub struct MacVideoState {
    pub active: bool,
    pub sec: f64,
    pub duration: f64,
    pub width: f64,
    pub height: f64,
    pub playing: bool,
    // latch-specific: true on the poll where an armed loop's playback had
    // escaped (rate hit 0) and was re-kicked. ChopApp re-cues its companion
    // audio decoder off this flag so picture and sound can't stay split.
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
    extern "C" {
        fn CGImageRelease(image: *const std::ffi::c_void);
        fn CGColorCreateGenericRGB(r: f64, g: f64, b: f64, a: f64) -> *mut std::ffi::c_void;
        fn CGColorRelease(color: *mut std::ffi::c_void);
        fn CGPathCreateWithRoundedRect(rect: CGRect, cw: f64, ch: f64, transform: *const std::ffi::c_void) -> *mut std::ffi::c_void;
        fn CGPathRelease(path: *mut std::ffi::c_void);
    }
    #[link(name = "CoreVideo", kind = "framework")]
    extern "C" {
        static kCVPixelBufferPixelFormatTypeKey: *mut AnyObject;
        fn CVPixelBufferLockBaseAddress(pb: *mut std::ffi::c_void, flags: u64) -> i32;
        fn CVPixelBufferUnlockBaseAddress(pb: *mut std::ffi::c_void, flags: u64) -> i32;
        fn CVPixelBufferGetWidth(pb: *mut std::ffi::c_void) -> usize;
        fn CVPixelBufferGetHeight(pb: *mut std::ffi::c_void) -> usize;
        fn CVPixelBufferGetBytesPerRow(pb: *mut std::ffi::c_void) -> usize;
        fn CVPixelBufferGetBaseAddress(pb: *mut std::ffi::c_void) -> *const u8;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const std::ffi::c_void);
    }
    #[link(name = "CoreImage", kind = "framework")]
    extern "C" {}

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

    // The host view extends past the DOM rect on every side so a one-frame
    // DOM/native desync during pane animation shows black, never the desktop
    // (the window background is fully transparent).
    const BLEED: f64 = 8.0;

    struct Session {
        player: usize, layer: usize, host: usize, parent: usize, webview: usize, looper: usize, item: usize,
        snapshot: usize, desired_rate: f32, loop_start: f64, loop_end: f64,
        wants_playing: bool,
        // One-shot log latch: the first Ready/Failed item status gets a
        // diagnostics receipt, then this flips so the 30Hz poll stays silent.
        status_logged: bool,
        // AVPlayerItemVideoOutput for the scopes (histogram/palette) sampler,
        // plus the RETAINED item it is currently attached to. The looper swaps
        // AVPlayerItems out from under us, so the sampler re-attaches lazily
        // to player.currentItem at copy time; the retain keeps removeOutput on
        // the outgoing item from touching a dead pointer.
        output: usize,
        output_item: usize,
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

    unsafe fn class_name(obj: *mut AnyObject) -> String {
        if obj.is_null() { return "<null>".into(); }
        let cls: *mut AnyObject = msg_send![obj, className];
        let utf8: *const std::ffi::c_char = msg_send![cls, UTF8String];
        if utf8.is_null() { return "<?>".into(); }
        std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned()
    }

    // The DOM rect maps into the coordinate space of the webview's box, not
    // the raw parent bounds: when the webview is inset within its superview
    // the video must follow the webview, so the reference box is the
    // webview's frame whenever one is known.
    unsafe fn dom_frame(parent: usize, webview: usize, x: f64, top: f64, w: f64, h: f64) -> CGRect {
        let p = parent as *mut AnyObject;
        let flipped: bool = msg_send![p, isFlipped];
        let (bx, by, bh);
        if webview != 0 && webview != parent {
            let f: CGRect = msg_send![webview as *mut AnyObject, frame];
            bx = f.origin.x; by = f.origin.y; bh = f.size.height;
        } else {
            let b: CGRect = msg_send![p, bounds];
            bx = 0.0; by = 0.0; bh = b.size.height;
        }
        CGRect {
            origin: CGPoint { x: bx + x, y: if flipped { by + top } else { by + bh - top - h } },
            size: CGSize { width: w, height: h },
        }
    }

    unsafe fn apply_channel(layer: usize, channel: usize) {
        let layer = layer as *mut AnyObject;
        if channel == 0 { let _: () = msg_send![layer, setFilters: std::ptr::null_mut::<AnyObject>()]; return; }
        let name: *mut AnyObject = msg_send![class!(NSString), stringWithUTF8String: c"CIColorMatrix".as_ptr()];
        let filter: *mut AnyObject = msg_send![class!(CIFilter), filterWithName: name];
        let vectors = [
            (1.0, 0.0, 0.0, 0.0), (0.0, 1.0, 0.0, 0.0), (0.0, 0.0, 1.0, 0.0),
            (0.0, 0.0, 0.0, 1.0), (0.2126, 0.7152, 0.0722, 0.0),
        ];
        let v = vectors[(channel - 1).min(4)];
        let vec: *mut AnyObject = msg_send![class!(CIVector), vectorWithX: v.0, Y: v.1, Z: v.2, W: v.3];
        for key in [c"inputRVector", c"inputGVector", c"inputBVector"] {
            let k: *mut AnyObject = msg_send![class!(NSString), stringWithUTF8String: key.as_ptr()];
            let _: () = msg_send![filter, setValue: vec, forKey: k];
        }
        let arr: *mut AnyObject = msg_send![class!(NSMutableArray), array];
        let _: () = msg_send![arr, addObject: filter];
        let _: () = msg_send![layer, setFilters: arr];
    }

    unsafe extern "C-unwind" fn passthrough_hit_test(
        _this: &AnyObject,
        _cmd: Sel,
        _point: CGPoint,
    ) -> *mut AnyObject {
        std::ptr::null_mut()
    }
    fn video_class() -> &'static AnyClass {
        static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
        CLASS.get_or_init(|| {
            if let Some(c) = AnyClass::get(c"WavdeskVideoHost") { return c; }
            let mut b = ClassBuilder::new(c"WavdeskVideoHost", class!(NSView)).expect("video host class");
            unsafe { b.add_method(sel!(hitTest:), passthrough_hit_test as unsafe extern "C-unwind" fn(_, _, _) -> _); }
            b.register()
        })
    }

    unsafe fn find_webview(view: *mut AnyObject) -> *mut AnyObject {
        let Some(wk) = AnyClass::get(c"WKWebView") else { return std::ptr::null_mut(); };
        let is_wk: bool = msg_send![view, isKindOfClass: wk];
        if is_wk { return view; }
        let subviews: *mut AnyObject = msg_send![view, subviews];
        let count: usize = msg_send![subviews, count];
        for i in 0..count {
            let v: *mut AnyObject = msg_send![subviews, objectAtIndex: i];
            let is: bool = msg_send![v, isKindOfClass: wk];
            if is { return v; }
        }
        std::ptr::null_mut()
    }

    // The CSS shell rounding (html.wd-mac, 10px) clips the DOM, but the video
    // host is a sibling NSView — when its rect (or 8px bleed) reaches a window
    // corner it paints a SQUARE corner over the rounded shell ("corners get
    // sharp once the video lands"). Mask the host's layer to the window's
    // rounded rect, expressed in host coordinates; re-applied on every frame
    // move since the intersection shifts with the host.
    unsafe fn apply_corner_mask(host: *mut AnyObject) {
        let window: *mut AnyObject = msg_send![host, window];
        if window.is_null() { return; }
        let content: *mut AnyObject = msg_send![window, contentView];
        if content.is_null() { return; }
        let cb: CGRect = msg_send![content, bounds];
        let in_host: CGRect = msg_send![host, convertRect: cb, fromView: content];
        let path = CGPathCreateWithRoundedRect(in_host, 10.0, 10.0, std::ptr::null());
        let mask: *mut AnyObject = msg_send![class!(CAShapeLayer), layer];
        let _: () = msg_send![mask, setPath: path];
        CGPathRelease(path);
        let layer: *mut AnyObject = msg_send![host, layer];
        let _: () = msg_send![layer, setMask: mask];
    }

    unsafe fn release(p: usize) { if p != 0 { let _: () = msg_send![p as *mut AnyObject, release]; } }
    unsafe fn destroy(s: Session) {
        let player = s.player as *mut AnyObject;
        let host = s.host as *mut AnyObject;
        let _: () = msg_send![player, pause];
        let _: () = msg_send![host, removeFromSuperview];
        if s.output != 0 && s.output_item != 0 {
            let _: () = msg_send![s.output_item as *mut AnyObject, removeOutput: s.output as *mut AnyObject];
        }
        release(s.output_item); release(s.output);
        release(s.snapshot); release(s.looper); release(s.host); release(s.layer); release(s.player); release(s.item);
    }

    pub fn open(app: tauri::AppHandle, label: String, path: String, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
        let window = app.get_webview_window(&label).ok_or("window not found")?;
        let ns_view = window.ns_view().map_err(|e| e.to_string())? as usize;
        window.run_on_main_thread(move || unsafe {
            if let Some(old) = sessions().lock().unwrap().remove(&label) { destroy(old); }
            let handle = ns_view as *mut AnyObject;
            // The picture must composite BELOW the WKWebView so the DOM
            // transport draws on top. A subview of the webview always renders
            // above web content regardless of ordering, so the host must be a
            // sibling: when the handle IS the webview, insert into its
            // superview; otherwise find the webview among the handle's
            // subviews and order the host below it.
            let webview = find_webview(handle);
            let (parent, sibling) = if !webview.is_null() && webview == handle {
                let sup: *mut AnyObject = msg_send![handle, superview];
                if sup.is_null() { (handle, std::ptr::null_mut()) } else { (sup, webview) }
            } else {
                (handle, webview)
            };
            {
                let flipped: bool = msg_send![parent, isFlipped];
                let pb: CGRect = msg_send![parent, bounds];
                let wf: CGRect = if webview.is_null() { pb } else { msg_send![webview, frame] };
                log::info!("[mac-video] {}", &format!(
                        "[attach] handle={} parent={} (flipped={} bounds {}x{}) webview={} frame=({}, {}, {}x{}) dom=({}, {}, {}x{})",
                        class_name(handle), class_name(parent), flipped,
                        pb.size.width, pb.size.height,
                        class_name(webview),
                        wf.origin.x, wf.origin.y, wf.size.width, wf.size.height,
                        x, y, w, h
                    ));
            }
            if webview.is_null() {
                log::warn!("[mac-video] {}", "[attach] WKWebView not found; inserting at bottom of sibling order");
            }

            // wry makes the webview transparent when the window is; verify and
            // force it if a wry update drops that (private API, sanctioned by
            // macOSPrivateApi in tauri.conf).
            if !webview.is_null() {
                let key: *mut AnyObject = msg_send![class!(NSString), stringWithUTF8String: c"drawsBackground".as_ptr()];
                let draws: *mut AnyObject = msg_send![webview, valueForKey: key];
                let opaque = if draws.is_null() { false } else { msg_send![draws, boolValue] };
                if opaque {
                    eprintln!("[mac_video] webview drawsBackground=YES; forcing transparent");
                    let no: *mut AnyObject = msg_send![class!(NSNumber), numberWithBool: false];
                    let _: () = msg_send![webview, setValue: no, forKey: key];
                    let responds: bool = msg_send![webview, respondsToSelector: sel!(setUnderPageBackgroundColor:)];
                    if responds {
                        let clear: *mut AnyObject = msg_send![class!(NSColor), clearColor];
                        let _: () = msg_send![webview, setUnderPageBackgroundColor: clear];
                    }
                }
            }

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
            let frame = dom_frame(parent as usize, webview as usize, x - BLEED, y - BLEED, w + 2.0 * BLEED, h + 2.0 * BLEED);
            log::info!("[mac-video] {}", &format!(
                    "[attach] host frame=({}, {}, {}x{})",
                    frame.origin.x, frame.origin.y, frame.size.width, frame.size.height
                ));
            let host: *mut AnyObject = msg_send![video_class(), alloc];
            let host: *mut AnyObject = msg_send![host, initWithFrame: frame];
            let _: () = msg_send![host, setWantsLayer: true];
            let root: *mut AnyObject = msg_send![host, layer];
            let _: () = msg_send![root, setMasksToBounds: true];
            let black = CGColorCreateGenericRGB(0.0, 0.0, 0.0, 1.0);
            let _: () = msg_send![root, setBackgroundColor: black];
            CGColorRelease(black);
            let _: () = msg_send![layer, setFrame: CGRect { origin: CGPoint { x: BLEED, y: BLEED }, size: CGSize { width: w, height: h } }];
            let _: () = msg_send![root, addSublayer: layer];
            if !sibling.is_null() {
                let _: () = msg_send![parent, addSubview: host, positioned: -1i64, relativeTo: sibling];
            } else {
                let _: () = msg_send![parent, addSubview: host, positioned: -1i64, relativeTo: std::ptr::null_mut::<AnyObject>()];
            }
            apply_corner_mask(host);
            let _: () = msg_send![player, setActionAtItemEnd: 2i64];
            // Keep the currently presented frame up until AVFoundation has the
            // destination frame ready. Local files preroll quickly, while the
            // eager setting produced a one-frame black clear on starts/seeks.
            let _: () = msg_send![player, setAutomaticallyWaitsToMinimizeStalling: true];
            // Scopes sampler: BGRA pixel-buffer taps for histogram/palette.
            // The webview cannot read pixels composited beneath it, so the
            // sample command is the only pixel source in macAv mode.
            let fmt: *mut AnyObject = msg_send![class!(NSNumber), numberWithUnsignedInt: 0x42475241u32];
            let attrs: *mut AnyObject = msg_send![class!(NSDictionary), dictionaryWithObject: fmt, forKey: kCVPixelBufferPixelFormatTypeKey];
            let output: *mut AnyObject = msg_send![class!(AVPlayerItemVideoOutput), alloc];
            let output: *mut AnyObject = msg_send![output, initWithPixelBufferAttributes: attrs];
            let _: () = msg_send![item, addOutput: output];
            let _: *mut AnyObject = msg_send![item, retain];   // output_item retain
            sessions().lock().unwrap().insert(label, Session {
                player: player as usize, layer: layer as usize, host: host as usize,
                parent: parent as usize, webview: webview as usize, looper: 0, item: item as usize,
                snapshot: 0, desired_rate: 1.0, loop_start: -1.0, loop_end: -1.0,
                wants_playing: false,
                status_logged: false,
                output: output as usize,
                output_item: item as usize,
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
                "channel" => { apply_channel(s.layer, (sec.max(0.0) as usize).min(5)); }
                "reveal" => {
                    if s.snapshot != 0 {
                        let snap = s.snapshot as *mut AnyObject;
                        let _: () = msg_send![snap, removeFromSuperlayer];
                        release(s.snapshot); s.snapshot = 0;
                    }
                }
                "loop" => {
                    let enabling = end > sec;
                    if (enabling && (s.loop_start - sec).abs() < 1.0 / 600.0 && (s.loop_end - end).abs() < 1.0 / 600.0)
                        || (!enabling && s.loop_start < 0.0 && s.loop_end < 0.0) {
                        return;
                    }
                    if end > sec { s.loop_start = sec; s.loop_end = end; }
                    else { s.loop_start = -1.0; s.loop_end = -1.0; }
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
                        // AVPlayerLooper's replica queue must advance between
                        // items. `None` is reserved for whole-file EOF hold.
                        let _: () = msg_send![player, setActionAtItemEnd: 0i64];
                        let _: () = msg_send![player, setAutomaticallyWaitsToMinimizeStalling: false];
                        let range = CMTimeRange { start: time(sec), duration: time(end - sec) };
                        let asset: *mut AnyObject = msg_send![s.item as *mut AnyObject, asset];
                        let template: *mut AnyObject = msg_send![class!(AVPlayerItem), playerItemWithAsset: asset];
                        let looper: *mut AnyObject = msg_send![class!(AVPlayerLooper), playerLooperWithPlayer: player, templateItem: template, timeRange: range];
                        let _: *mut AnyObject = msg_send![looper, retain];
                        s.looper = looper as usize;
                        let tolerance = time(1.0 / 120.0);
                        let _: () = msg_send![player, seekToTime: time(sec), toleranceBefore: tolerance, toleranceAfter: tolerance];
                    } else {
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
        unsafe {
            let frame = dom_frame(s.parent, s.webview, x - BLEED, y - BLEED, w + 2.0 * BLEED, h + 2.0 * BLEED);
            // The JS side only sends changed rects, so this stays quiet.
            log::info!("[mac-video] {}", &format!(
                    "[frame] dom=({x}, {y}, {w}x{h}) -> host=({}, {}, {}x{})",
                    frame.origin.x, frame.origin.y, frame.size.width, frame.size.height
                ));
            let _: () = msg_send![s.host as *mut AnyObject, setFrame: frame];
            apply_corner_mask(s.host as *mut AnyObject);
        }
    }
    pub fn frame(app: tauri::AppHandle, label: String, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
        let window = app.get_webview_window(&label).ok_or("window not found")?;
        window.run_on_main_thread(move || frame_now(label, x, y, w, h)).map_err(|e| e.to_string())
    }

    // First-N transform receipts per session; a zoom drag would otherwise spam
    // the log at rAF rate.
    static TRANSFORM_LOGS: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    fn transform_logs() -> &'static Mutex<HashMap<String, u32>> {
        TRANSFORM_LOGS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn transform_now(label: String, ox: f64, oy: f64, w: f64, h: f64, picture_h: f64) {
        let map = sessions().lock().unwrap();
        let Some(s) = map.get(&label) else { return; };
        // Web/canvas coordinates grow downward; Core Animation coordinates
        // grow upward inside the clipped host view.
        let y = BLEED + picture_h - oy - h;
        let x = BLEED + ox;
        {
            let mut counts = transform_logs().lock().unwrap();
            let n = counts.entry(label.clone()).or_insert(0);
            if *n < 4 {
                *n += 1;
                log::info!("[mac-video] {}", &format!("[transform] view=({ox}, {oy}, {w}x{h}) pictureH={picture_h} -> layer=({x}, {y})"));
            }
        }
        unsafe {
            let _: () = msg_send![class!(CATransaction), begin];
            let _: () = msg_send![class!(CATransaction), setDisableActions: true];
            let _: () = msg_send![s.layer as *mut AnyObject, setFrame: CGRect { origin: CGPoint { x, y }, size: CGSize { width: w, height: h } }];
            if s.snapshot != 0 {
                let _: () = msg_send![s.snapshot as *mut AnyObject, setFrame: CGRect { origin: CGPoint { x, y }, size: CGSize { width: w, height: h } }];
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
            let mut recovered_loop = false;
            if s.wants_playing && s.loop_end > s.loop_start && rate == 0.0 {
                let _: () = msg_send![player, playImmediatelyAtRate: s.desired_rate];
                rate = s.desired_rate;
                recovered_loop = true;
            }
            let item = s.item as *mut AnyObject;
            let d: CMTime = msg_send![item, duration];
            let sz: CGSize = msg_send![item, presentationSize];
            if !s.status_logged {
                // 1 = ReadyToPlay, 2 = Failed. Unknown (0) keeps polling.
                let status: i64 = msg_send![item, status];
                if status == 2 {
                    s.status_logged = true;
                    let err: *mut AnyObject = msg_send![item, error];
                    let desc = if err.is_null() { "<no NSError>".to_string() } else {
                        let d: *mut AnyObject = msg_send![err, localizedDescription];
                        let utf8: *const std::ffi::c_char = msg_send![d, UTF8String];
                        if utf8.is_null() { "<?>".to_string() } else { std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned() }
                    };
                    log::warn!("[mac-video] {}", &format!("[item] status=FAILED: {desc}"));
                } else if status == 1 {
                    s.status_logged = true;
                    log::info!("[mac-video] {}", &format!("[item] status=READY {}x{} rate={rate}", sz.width, sz.height));
                }
            }
            MacVideoState {
                active: true,
                sec: if t.timescale > 0 { t.value as f64 / t.timescale as f64 } else { 0.0 },
                duration: if d.timescale > 0 { d.value as f64 / d.timescale as f64 } else { 0.0 },
                width: sz.width,
                height: sz.height,
                playing: rate != 0.0,
                recovered_loop,
            }
        }
    }

    // Copy the currently displayed frame as a downscaled RGBA buffer, or None
    // when no new buffer is available (paused + already sampled, or preroll).
    // Main-thread only (AVPlayerItemVideoOutput attachment mutates the item).
    fn sample_now(label: &str, max_dim: u32) -> Option<(u32, u32, Vec<u8>)> {
        let mut map = sessions().lock().unwrap();
        let s = map.get_mut(label)?;
        if s.output == 0 { return None; }
        unsafe {
            let player = s.player as *mut AnyObject;
            let output = s.output as *mut AnyObject;
            // The looper swaps items; keep the output attached to whatever is
            // presenting right now. output_item is retained across the swap so
            // removeOutput never runs on a deallocated item.
            let current: *mut AnyObject = msg_send![player, currentItem];
            if !current.is_null() && current as usize != s.output_item {
                if s.output_item != 0 {
                    let _: () = msg_send![s.output_item as *mut AnyObject, removeOutput: output];
                    release(s.output_item);
                }
                let _: () = msg_send![current, addOutput: output];
                let _: *mut AnyObject = msg_send![current, retain];
                s.output_item = current as usize;
            }
            let t: CMTime = msg_send![player, currentTime];
            let pb: *mut std::ffi::c_void = msg_send![output, copyPixelBufferForItemTime: t, itemTimeForDisplay: std::ptr::null_mut::<CMTime>()];
            if pb.is_null() { return None; }
            // kCVPixelBufferLock_ReadOnly
            if CVPixelBufferLockBaseAddress(pb, 1) != 0 { CFRelease(pb); return None; }
            let w = CVPixelBufferGetWidth(pb);
            let h = CVPixelBufferGetHeight(pb);
            let stride = CVPixelBufferGetBytesPerRow(pb);
            let base = CVPixelBufferGetBaseAddress(pb);
            let out = if base.is_null() || w == 0 || h == 0 {
                None
            } else {
                // Nearest-neighbor decimation: scopes need distribution, not
                // fidelity, and this keeps the IPC payload ~256KB at most.
                let step = (w.max(h) as u32).div_ceil(max_dim.max(1)).max(1) as usize;
                let ow = w.div_ceil(step);
                let oh = h.div_ceil(step);
                let mut rgba = Vec::with_capacity(ow * oh * 4);
                for y in (0..h).step_by(step) {
                    let row = base.add(y * stride);
                    for x in (0..w).step_by(step) {
                        let px = row.add(x * 4); // BGRA
                        rgba.push(*px.add(2));
                        rgba.push(*px.add(1));
                        rgba.push(*px);
                        rgba.push(*px.add(3));
                    }
                }
                Some((ow as u32, oh as u32, rgba))
            };
            CVPixelBufferUnlockBaseAddress(pb, 1);
            CFRelease(pb);
            out
        }
    }

    pub fn sample(app: tauri::AppHandle, label: String, max_dim: u32) -> Result<Vec<u8>, String> {
        let window = app.get_webview_window(&label).ok_or("window not found")?;
        let (tx, rx) = std::sync::mpsc::channel();
        window
            .run_on_main_thread(move || {
                let _ = tx.send(sample_now(&label, max_dim));
            })
            .map_err(|e| e.to_string())?;
        let got = rx
            .recv_timeout(std::time::Duration::from_millis(300))
            .map_err(|_| "sample timeout".to_string())?;
        // Empty payload = "no new frame" (paused + unchanged); the frontend
        // keeps its last sample. [w u32 LE][h u32 LE][rgba…] otherwise.
        let Some((w, h, rgba)) = got else { return Ok(Vec::new()); };
        let mut payload = Vec::with_capacity(8 + rgba.len());
        payload.extend_from_slice(&w.to_le_bytes());
        payload.extend_from_slice(&h.to_le_bytes());
        payload.extend_from_slice(&rgba);
        Ok(payload)
    }

    fn stop_now(label: String) {
        pending_transforms().lock().unwrap().remove(&label);
        scheduled_transforms().lock().unwrap().remove(&label);
        transform_logs().lock().unwrap().remove(&label);
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
/// Downscaled RGBA copy of the frame on screen, as raw bytes:
/// [w u32 LE][h u32 LE][rgba…]; empty = no new frame, keep the last sample.
/// Raw Response (not JSON) — a 250KB frame as a JSON number array would cost
/// more to serialize than to decode.
#[tauri::command]
pub async fn mac_video_sample(app: tauri::AppHandle, label: String, max_dim: u32) -> Result<tauri::ipc::Response, String> {
    #[cfg(target_os = "macos")]
    {
        let bytes = tauri::async_runtime::spawn_blocking(move || imp::sample(app, label, max_dim))
            .await
            .map_err(|e| format!("sample join: {e}"))??;
        Ok(tauri::ipc::Response::new(bytes))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, label, max_dim);
        Ok(tauri::ipc::Response::new(Vec::new()))
    }
}
