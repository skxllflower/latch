// Localhost HTTP endpoint for chip-bitmap delivery from the drag-
// overlay webview to the native chip thread.
//
// Why this exists: the canonical Tauri IPC path (invoke + tauri::
// command) routes through main's UI thread for command dispatch.
// During a Windows file drag, DoDragDrop puts that thread into a
// modal pump that only processes a subset of messages until the
// drag releases — Tauri commands queue up behind the pump and only
// fire AFTER mouseup. That's fine for "user clicked something"
// flows but devastating for "stream chip bitmap updates 30Hz during
// a drag": the captured frames pile up in the IPC queue and only
// reach the native chip thread when the drag is already over.
//
// Bypass: a plain localhost HTTP server on a Rust thread. The drag-
// overlay's webview POSTs each frame's RGBA buffer to it via
// fetch(), which goes through Chromium's network stack (not Tauri's
// IPC pump), so it's NOT blocked by DoDragDrop. Same trick the
// chip-state delivery uses with cross-window localStorage events —
// just for binary data on a different transport.
//
// Tiny on purpose: stdlib only (TcpListener + BufReader), one
// endpoint (POST /bitmap?w=N&h=N), no async runtime, no pulled-in
// HTTP crate. ~120 lines total. Bound to 127.0.0.1 + a kernel-
// assigned ephemeral port — never exposed beyond the host. CORS
// permissive (Access-Control-Allow-Origin: *) since we're only
// listening on localhost anyway.

#![cfg(target_os = "windows")]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU16, Ordering};
use std::thread;

// 0 = server hasn't bound yet (start() hasn't completed).
// Non-zero = the kernel-assigned port the JS side should fetch().
static PORT: AtomicU16 = AtomicU16::new(0);

/// Port the chip-bitmap server is listening on, or 0 if start()
/// hasn't completed (or failed). Read by the get_chip_bitmap_
/// endpoint Tauri command at app startup; the JS side caches the
/// resulting URL so subsequent captures don't need another IPC
/// round-trip to find it.
pub fn current_port() -> u16 {
    PORT.load(Ordering::SeqCst)
}

/// Spawn the HTTP server on a dedicated thread. Idempotent isn't
/// needed — caller (lib.rs setup) only calls this once at startup.
pub fn start() {
    thread::spawn(|| {
        let listener = match TcpListener::bind("127.0.0.1:0") {
            Ok(l) => l,
            Err(e) => {
                log::error!("chip_bitmap_server: TcpListener::bind failed: {e}");
                return;
            }
        };
        let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
        PORT.store(port, Ordering::SeqCst);
        log::info!("chip_bitmap_server: listening on 127.0.0.1:{port}");
        // Each connection gets its own short-lived thread. Total
        // capture rate maxes around the chip's setTimeout(0) cadence
        // (~30 captures/sec on a fast drag) so we're not thread-
        // pool-bound — keep it simple.
        for conn in listener.incoming() {
            let conn = match conn {
                Ok(c) => c,
                Err(_) => continue,
            };
            thread::spawn(move || handle_connection(conn));
        }
    });
}

fn handle_connection(mut stream: TcpStream) {
    // BufReader for line-oriented header parsing. After headers are
    // done we read the body via read_exact, which works correctly
    // through BufReader's internal buffer.
    let mut reader = BufReader::new(&mut stream);

    // Request line: "METHOD /path?qs HTTP/1.1\r\n"
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 3 {
        return;
    }
    let method = parts[0];
    let path_with_qs = parts[1].to_string();

    // Headers — read until empty line. We only care about
    // Content-Length for body sizing.
    let mut content_length: usize = 0;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() {
            return;
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some(rest) = trimmed
            .strip_prefix("Content-Length:")
            .or_else(|| trimmed.strip_prefix("content-length:"))
        {
            content_length = rest.trim().parse().unwrap_or(0);
        }
    }

    // CORS preflight — fetch() with non-simple Content-Type sends
    // an OPTIONS first. Reply with permissive CORS so the actual
    // POST clears.
    if method == "OPTIONS" {
        let _ = stream.write_all(
            b"HTTP/1.1 204 No Content\r\n\
              Access-Control-Allow-Origin: *\r\n\
              Access-Control-Allow-Methods: POST, OPTIONS\r\n\
              Access-Control-Allow-Headers: Content-Type\r\n\
              Access-Control-Max-Age: 86400\r\n\
              Content-Length: 0\r\n\r\n",
        );
        return;
    }

    // GET /target — JSON snapshot of the cross-process drop target
    // the native chip thread last resolved (process exe basename
    // under the cursor's top-level window). Polled by the drag
    // overlay's JS at ~10Hz to render a context-aware chip label.
    // Lives on the same localhost server as /bitmap so the JS side
    // doesn't need a second endpoint URL.
    if method == "GET" && path_with_qs.starts_with("/target") {
        let exe    = crate::native_drag_chip::current_external_exe();
        let folder = crate::native_drag_chip::current_external_folder();
        // Live modifier state — same atomics drag_overlay's poll
        // thread maintains, fresher than anything DoDragDrop's
        // modal pump would let through Tauri IPC.
        let ctrl   = crate::drag_overlay::is_ctrl_held();
        let shift  = crate::drag_overlay::is_shift_held();
        // Hand-rolled JSON. exe / folder values can contain backslashes
        // (Windows paths) and theoretically " (rare in practice) so
        // escape defensively. ctrl / shift serialize as bare booleans.
        let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
        let body = format!(
            "{{\"exe\":\"{}\",\"folder\":\"{}\",\"ctrl\":{},\"shift\":{}}}",
            esc(&exe), esc(&folder), ctrl, shift,
        );
        let resp = format!(
            "HTTP/1.1 200 OK\r\n\
             Access-Control-Allow-Origin: *\r\n\
             Content-Type: application/json\r\n\
             Content-Length: {}\r\n\
             Connection: close\r\n\r\n\
             {}",
            body.len(), body
        );
        let _ = stream.write_all(resp.as_bytes());
        return;
    }

    if method != "POST" {
        write_status(&mut stream, "405 Method Not Allowed");
        return;
    }
    if !path_with_qs.starts_with("/bitmap") {
        write_status(&mut stream, "404 Not Found");
        return;
    }

    // Parse w, h from query string.
    let qs = path_with_qs.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut w: u32 = 0;
    let mut h: u32 = 0;
    for kv in qs.split('&') {
        let Some((k, v)) = kv.split_once('=') else { continue };
        match k {
            "w" => w = v.parse().unwrap_or(0),
            "h" => h = v.parse().unwrap_or(0),
            _ => {}
        }
    }
    if w == 0 || h == 0 || content_length == 0 {
        write_status(&mut stream, "400 Bad Request");
        return;
    }

    // Read body — exactly Content-Length bytes of RGBA.
    let mut body = vec![0u8; content_length];
    if reader.read_exact(&mut body).is_err() {
        return;
    }
    let expected = (w as usize) * (h as usize) * 4;
    if body.len() != expected {
        log::warn!(
            "chip_bitmap_server: body size mismatch ({} vs {}x{}x4={})",
            body.len(), w, h, expected
        );
        write_status(&mut stream, "400 Bad Request");
        return;
    }

    // Hand off to the chip thread. update_bitmap is non-blocking —
    // copies the buffer into a Mutex slot and PostThreadMessage's
    // the chip thread, returns immediately.
    crate::native_drag_chip::update_bitmap(body, w, h);

    // 200 OK. JS doesn't await the response anyway (fire-and-forget
    // semantics) but writing a status keeps fetch happy.
    let _ = stream.write_all(
        b"HTTP/1.1 200 OK\r\n\
          Access-Control-Allow-Origin: *\r\n\
          Content-Length: 0\r\n\
          Connection: close\r\n\r\n",
    );
}

fn write_status(stream: &mut TcpStream, status: &str) {
    let resp = format!(
        "HTTP/1.1 {status}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Content-Length: 0\r\n\
         Connection: close\r\n\r\n"
    );
    let _ = stream.write_all(resp.as_bytes());
}
