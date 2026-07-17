mod audio;
mod audio_decode;
#[cfg(target_os = "windows")]
mod chip_bitmap_server;
mod chop;
mod cookie_prefs;
mod drag_overlay;
#[cfg(target_os = "windows")]
mod explorer_folder;
mod job_object;
mod logger;
mod mac_video;
mod mac_input;
#[cfg(target_os = "windows")]
mod native_drag_chip;
mod cursor;
mod os_drag;
mod peaks;
mod settings;
mod tools;
mod registry;
#[cfg(target_os = "windows")]
mod touchpad_raw_input;
mod video_stream_server;

use tauri::{WebviewUrl, WebviewWindowBuilder};

/// Force a runtime-created, borderless/transparent satellite window to register
/// as a real taskbar + alt-tab window on Windows. Undecorated windows spawned
/// hidden-then-shown can miss the shell's taskbar/alt-tab registration; setting
/// WS_EX_APPWINDOW (and clearing WS_EX_TOOLWINDOW), then (re)adding the taskbar
/// tab, makes them behave like the config-declared main window. No-op off
/// Windows. Called by the chop window (and any other real satellite) after it
/// shows itself.
#[tauri::command]
fn register_taskbar_window(app: tauri::AppHandle, label: String) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window(&label) else {
        return;
    };
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
        };
        if let Ok(hwnd) = window.hwnd() {
            unsafe {
                let cur = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
                let next = (cur & !WS_EX_TOOLWINDOW.0) | WS_EX_APPWINDOW.0;
                if next != cur {
                    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next as isize);
                }
            }
        }
    }
    // (Re)register the taskbar button now that the window is visible + flagged
    // as an app window. Harmless (idempotent AddTab) if already present.
    let _ = window.set_skip_taskbar(false);
}

/// Shell-open the standalone Latch log file (About window → Open Log File).
/// Ensures the file exists first so the OS always has something to open.
/// async + spawn_blocking: touches disk (exists probe, create_dir_all + write
/// of the seed file) before the launch. As a sync command Tauri v2 ran that
/// I/O INLINE on the main thread inside WebMessageReceived — a stalled disk
/// would freeze the pump. spawn_blocking keeps main flowing.
#[tauri::command]
async fn open_log_file() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let path = logger::log_path().ok_or_else(|| "log path unavailable".to_string())?;
        if !path.exists() {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&path, b"");
        }
        let p = path.to_string_lossy().to_string();
        #[cfg(target_os = "windows")]
        {
            // notepad opens any .log reliably (no file-association prompt).
            std::process::Command::new("notepad")
                .arg(&p)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("open log: {e}"))
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg(&p)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("open log: {e}"))
        }
        #[cfg(all(not(windows), not(target_os = "macos")))]
        {
            std::process::Command::new("xdg-open")
                .arg(&p)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("open log: {e}"))
        }
    })
    .await
    .map_err(|e| format!("open log join: {e}"))?
}

/// Frontend to file log bridge: route a diagnostic line from the webview into
/// latch.log so field failures have receipts. The native-video engine's mac
/// stall-watchdog / loop-overdue / EOF-replay warns previously reached only the
/// webview console (invisible after the fact). Rate-limited on the frontend.
/// async + spawn_blocking: logger::log touches disk, so it must not run inline
/// on the IPC pump (the sync-command main-thread-freeze rule).
#[tauri::command]
async fn log_frontend(level: String, source: String, message: String) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        logger::log(&format!("[{}] {}: {}", level.to_uppercase(), source, message));
    })
    .await;
}

pub fn run() {
    // Kill-on-close job from the very start, so latch.exe + its yt-dlp/
    // ffmpeg children (and the WebView2 tree) can never outlive a crash.
    job_object::assign_self();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        // The audio engine lives on a main-process thread — closing the
        // chop WINDOW doesn't touch it (and the webview's JS teardown is
        // not guaranteed to run its unmount cleanup). Kill both decks +
        // their decoder children whenever the chop window goes away.
        .on_window_event(|window, event| {
            use tauri::Manager;
            if matches!(event, tauri::WindowEvent::Destroyed) && window.label() == "chop" {
                audio::stop_everything(window.app_handle());
                // The webview's own close handler sweeps too, but it never
                // runs when the window is destroyed outright — this hook is
                // the guarantee that no chop temp tree outlives the window.
                chop::sweep_temp_root();
            }
        })
        .setup(|app| {
            use tauri::Manager;
            // Always-on file log (About → Open Log File). Init first so any
            // setup-phase failure below is captured.
            logger::init();
            // Startup sweep of the chop temp root: a crash or hard-kill never
            // runs the window-destroy / app-exit sweeps, so downloaded previews
            // and HD files can strand in %TEMP%\latch-chop across launches.
            // Safe to wipe wholesale here — single-instance means no other
            // session owns an in-flight dir at startup. Mirrors WAVdesk's
            // startup cache-sweep pattern.
            chop::sweep_temp_root();
            // Self-register our CLI core so WAVdesk can discover this install.
            registry::register_self();
            // Provision the bundled yt-dlp into the core's managed bin dir so a
            // fresh install works offline (no first-run GitHub download).
            if let Ok(rd) = app.path().resource_dir() {
                tools::provision_ytdlp(&rd);
                // Seed the bundled ffmpeg into the SHARED bin so the chop/clip
                // video features work standalone (no WAVdesk install required).
                tools::provision_ffmpeg(&rd);
            }
            // Pre-spawn the drag-overlay window hidden — it's both the OS
            // drag SOURCE (see os_drag.rs) and the chip's render surface.
            let overlay_url = WebviewUrl::App("/?wd=drag-overlay".into());
            let overlay_builder = WebviewWindowBuilder::new(app, "drag-overlay", overlay_url)
                .title("Latch Drag")
                .inner_size(1000.0, 200.0)
                .position(0.0, 0.0)
                .decorations(false)
                .transparent(true)
                .background_color(tauri::utils::config::Color(0, 0, 0, 0))
                .shadow(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .focused(false)
                .visible(false)
                .resizable(false)
                .closable(false)
                .minimizable(false)
                .maximizable(false);
            match overlay_builder.build() {
                Ok(overlay) => {
                    if let Err(e) = overlay.set_ignore_cursor_events(true) {
                        eprintln!("drag-overlay set_ignore_cursor_events failed: {e}");
                    }
                }
                Err(e) => eprintln!("drag-overlay creation failed: {e}"),
            }
            #[cfg(target_os = "windows")]
            chip_bitmap_server::start();
            // Precision-touchpad pinch/pan via raw HID (WebView2 eats the
            // gestures before any DOM event) — broadcast to the chop
            // window's waveform + video.
            #[cfg(target_os = "windows")]
            touchpad_raw_input::install(app.handle());
            video_stream_server::start();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tools::latch_extract,
            tools::latch_cancel,
            tools::latch_probe,
            tools::latch_expand_url,
            tools::latch_update_ytdlp,
            tools::latch_bootstrap,
            tools::tool_binary_probe,
            tools::resolve_tool_status,
            settings::settings_get,
            settings::settings_set,
            tools::os_reveal_path,
            tools::os_open_path,
            tools::os_open_url,
            tools::app_exit,
            cookie_prefs::cookie_prefs_get,
            cookie_prefs::cookie_prefs_set,
            cookie_prefs::detect_cookie_browsers,
            chop::latch_chop_alloc_dir,
            chop::latch_chop_cleanup_dir,
            chop::latch_clips_dir,
            chop::clip_path_exists,
            chop::latch_clip,
            audio::audio_cmd,
            mac_video::mac_video_open,
            mac_video::mac_video_command,
            mac_video::mac_video_state,
            mac_video::mac_video_frame,
            mac_video::mac_video_transform,
            mac_video::mac_video_stop,
            mac_video::mac_video_sample,
            peaks::generate_waveform,
            peaks::generate_waveform_any,
            peaks::wav_nearest_zero_cross,
            drag_overlay::drag_overlay_start,
            drag_overlay::drag_overlay_stop,
            drag_overlay::drag_overlay_last_cursor,
            drag_overlay::drag_overlay_modifier_state,
            drag_overlay::drag_chip_set_bitmap,
            drag_overlay::get_chip_bitmap_endpoint,
            os_drag::start_os_file_drag,
            video_stream_server::video_stream_endpoint,
            audio::start_video_audio,
            audio::pause_video_audio,
            audio::resume_video_audio,
            audio::stop_video_audio,
            audio::seek_video_audio,
            audio::set_video_audio_volume,
            audio::set_video_audio_rate,
            audio::set_video_audio_loop,
            tools::video_audio_peaks,
            cursor::set_native_cursor_position,
            register_taskbar_window,
            open_log_file,
            log_frontend,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Latch");
}
