mod job_object;
mod tools;

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
        .invoke_handler(tauri::generate_handler![
            tools::latch_extract,
            tools::latch_cancel,
            tools::latch_probe,
            tools::latch_expand_url,
            tools::latch_update_ytdlp,
            tools::latch_bootstrap,
            tools::tool_binary_probe,
            tools::os_reveal_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Latch");
}
