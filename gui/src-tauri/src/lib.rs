mod audio;
#[cfg(target_os = "windows")]
mod chip_bitmap_server;
mod chop;
mod drag_overlay;
#[cfg(target_os = "windows")]
mod explorer_folder;
mod job_object;
#[cfg(target_os = "windows")]
mod native_drag_chip;
mod cursor;
mod os_drag;
mod peaks;
mod tools;
mod video_stream_server;

use tauri::{WebviewUrl, WebviewWindowBuilder};

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
            }
        })
        .setup(|app| {
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
            tools::os_reveal_path,
            tools::os_open_path,
            tools::app_exit,
            chop::latch_chop_alloc_dir,
            chop::latch_chop_cleanup_dir,
            chop::latch_clips_dir,
            chop::latch_clip,
            audio::audio_cmd,
            peaks::generate_waveform,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Latch");
}
