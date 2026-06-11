// Localhost HTTP endpoint that streams decoded RGBA video frames to the
// webview, for native video-preview playback with no transcode-to-file step.
//
// Preferred path: ONE persistent `lathe decode-server` per stream. Its stdout
// chunks ([u64 LE pts us][u32 LE len][RGBA], zero-len = seek marker) are
// forwarded verbatim to the response body, and its stdin is kept in a registry
// keyed by a stream id (returned in `X-Wavdesk-Stream-Id`) so the webview can
// drive playback with `POST /vcontrol?id=&op=seek|play|pause&sec=` — seeks are
// IN-PROCESS (av_seek_frame), no re-spawn, which is what makes scrubbing
// smooth. Falls back to the old `lathe stream-frames` pipe (headerless frames,
// seek = reconnect with start=) when decode-server is unavailable; the
// `X-Wavdesk-Proto: pts|raw` header tells the engine which dialect it got.
//
// Mirrors chip_bitmap_server's plain-stdlib HTTP approach (TcpListener + manual
// request parse, no async runtime, no HTTP crate). Why a socket and not Tauri
// IPC: binary frame data at video rates has no business going through the
// command pump. The webview reads it off Chromium's network stack via fetch()
// + a ReadableStream.
//
// The whole thing is bound to 127.0.0.1 on a kernel-assigned ephemeral port,
// never exposed beyond the host.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// 0 = server hasn't bound yet (start() hasn't completed, or failed).
static PORT: AtomicU16 = AtomicU16::new(0);

static NEXT_STREAM_ID: AtomicU64 = AtomicU64::new(1);

// Live persistent decoders: stream id -> (control stdin, child for kill). The
// pump loop and the disconnect watchdog race to remove an entry; HashMap::
// remove makes the cleanup idempotent.
struct StreamEntry {
    stdin: ChildStdin,
    child: Child,
}

fn registry() -> &'static Mutex<HashMap<u64, StreamEntry>> {
    static REG: OnceLock<Mutex<HashMap<u64, StreamEntry>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

// Remove + kill + reap a stream's decoder. Safe to call from both cleanup
// paths; whoever gets the entry does the kill.
fn kill_stream(id: u64) {
    let entry = registry().lock().ok().and_then(|mut m| m.remove(&id));
    if let Some(mut e) = entry {
        let _ = e.child.kill();
        let _ = e.child.wait();
    }
}

/// Port the frame server is listening on, or 0 before start() completes.
pub fn current_port() -> u16 {
    PORT.load(Ordering::SeqCst)
}

/// Base URL the JS side fetches frames from (it appends the query string), or
/// "" if the server isn't up. Mirrors drag_overlay::get_chip_bitmap_endpoint.
#[tauri::command]
pub fn video_stream_endpoint() -> String {
    let port = current_port();
    if port == 0 {
        return String::new();
    }
    format!("http://127.0.0.1:{port}/vstream")
}

/// Spawn the HTTP server on a dedicated thread. Called once at startup.
pub fn start() {
    thread::spawn(|| {
        let listener = match TcpListener::bind("127.0.0.1:0") {
            Ok(l) => l,
            Err(e) => {
                log::error!("video_stream_server: TcpListener::bind failed: {e}");
                return;
            }
        };
        let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
        PORT.store(port, Ordering::SeqCst);
        log::info!("video_stream_server: listening on 127.0.0.1:{port}");
        for conn in listener.incoming() {
            let Ok(conn) = conn else { continue };
            // Each /vstream is long-lived (runs for the whole playback), so a
            // thread per connection is the right shape — not a pool. /vcontrol
            // requests are short and cheap.
            thread::spawn(move || handle_connection(conn));
        }
    });
}

struct Geom {
    w: u32,
    h: u32,
    fps: u32,
    dur: f64,
    hdr: String,
}

// "WAVDESK_GEOM w=406 h=720 fps=24 dur=248.570 pix_fmt=rgba hdr=pq" -> Geom.
// None if absent or zero-sized. dur/hdr default if an older lathe omits them.
fn parse_geom(line: &str) -> Option<Geom> {
    if !line.contains("WAVDESK_GEOM") {
        return None;
    }
    let (mut w, mut h, mut fps, mut dur) = (0u32, 0u32, 0u32, 0f64);
    let mut hdr = String::from("0");
    for tok in line.split_whitespace() {
        if let Some(v) = tok.strip_prefix("w=") {
            w = v.parse().unwrap_or(0);
        } else if let Some(v) = tok.strip_prefix("h=") {
            h = v.parse().unwrap_or(0);
        } else if let Some(v) = tok.strip_prefix("fps=") {
            fps = v.parse().unwrap_or(0);
        } else if let Some(v) = tok.strip_prefix("dur=") {
            dur = v.parse().unwrap_or(0.0);
        } else if let Some(v) = tok.strip_prefix("hdr=") {
            hdr = v.to_string();
        }
    }
    if w > 0 && h > 0 {
        Some(Geom { w, h, fps, dur, hdr })
    } else {
        None
    }
}

// Percent-decode a query-string value written by encodeURIComponent (so unicode
// paths survive as UTF-8 %XX). encodeURIComponent never emits '+' for space, so
// '+' is treated literally here.
fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hi = (b[i + 1] as char).to_digit(16);
            let lo = (b[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn write_simple(stream: &mut TcpStream, status: &str) {
    let resp = format!(
        "HTTP/1.1 {status}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Content-Length: 0\r\n\
         Connection: close\r\n\r\n"
    );
    let _ = stream.write_all(resp.as_bytes());
}

fn write_500(stream: &mut TcpStream, msg: &str) {
    let body = msg.as_bytes();
    let resp = format!(
        "HTTP/1.1 500 Internal Server Error\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Content-Type: text/plain\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.write_all(body);
}

// Spawn `lathe <args...>`, returning the child with stdout/stderr piped (and
// stdin piped when `with_stdin`).
fn spawn_lathe(lathe_bin: &std::path::Path, args: &[String], with_stdin: bool) -> Result<Child, String> {
    let mut cmd = Command::new(lathe_bin);
    cmd.args(args)
        .stdin(if with_stdin { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd.spawn().map_err(|e| format!("spawn lathe: {e}"))?;
    // Tie lathe (and any ffmpeg grandchild, via lathe's own job) to our
    // lifetime so a crash can't orphan it.
    crate::job_object::assign_child(&child);
    Ok(child)
}

// Drain the child's stderr on a worker thread: capture the first WAVDESK_GEOM
// line, then keep reading so the pipe never fills and stalls the decode.
// Returns the geometry, or None on EOF/timeout (child dead or not a decoder).
fn await_geom(child: &mut Child) -> Option<Geom> {
    let (geom_tx, geom_rx) = mpsc::channel::<Geom>();
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            let mut sent = false;
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if !sent {
                    if let Some(g) = parse_geom(&line) {
                        let _ = geom_tx.send(g);
                        sent = true;
                    }
                }
            }
        });
    }
    // Geometry arrives at decoder startup. If lathe dies first (e.g. no
    // decode-server subcommand) the sender drops and recv errors out fast; the
    // timeout only covers a genuine hang (or a first-run ffmpeg bootstrap).
    geom_rx.recv_timeout(Duration::from_secs(30)).ok()
}

fn handle_connection(mut stream: TcpStream) {
    // Parse the request line + headers in a scoped borrow so the stream is free
    // to write the response afterward. Neither route carries a request body, so
    // nothing is lost by dropping the BufReader's buffer.
    let (method, path_qs) = {
        let mut reader = BufReader::new(&mut stream);
        let mut request_line = String::new();
        if reader.read_line(&mut request_line).is_err() {
            return;
        }
        let parts: Vec<&str> = request_line.split_whitespace().collect();
        if parts.len() < 2 {
            return;
        }
        let method = parts[0].to_string();
        let path_qs = parts[1].to_string();
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() {
                return;
            }
            if line.trim_end_matches(['\r', '\n']).is_empty() {
                break;
            }
        }
        (method, path_qs)
    };

    if method == "OPTIONS" {
        let _ = stream.write_all(
            b"HTTP/1.1 204 No Content\r\n\
              Access-Control-Allow-Origin: *\r\n\
              Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
              Access-Control-Allow-Headers: *\r\n\
              Access-Control-Max-Age: 86400\r\n\
              Content-Length: 0\r\n\r\n",
        );
        return;
    }
    if method == "POST" && path_qs.starts_with("/vcontrol") {
        handle_vcontrol(&mut stream, &path_qs);
        return;
    }
    if method != "GET" || !path_qs.starts_with("/vstream") {
        write_simple(&mut stream, "404 Not Found");
        return;
    }

    // Query: path (required, percent-encoded), height, fps (raw fallback only),
    // start, lathe (the resolved lathe path the frontend got from latheStatus;
    // empty falls back to the env/dev resolution in find_tool_binary).
    let qs = path_qs.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut path = String::new();
    let mut height: u32 = 720;
    let mut fps: u32 = 24;
    let mut start: f64 = 0.0;
    let mut lathe = String::new();
    for kv in qs.split('&') {
        let Some((k, v)) = kv.split_once('=') else { continue };
        match k {
            "path" => path = pct_decode(v),
            "height" => height = pct_decode(v).parse().unwrap_or(720),
            "fps" => fps = pct_decode(v).parse().unwrap_or(24),
            "start" => start = pct_decode(v).parse().unwrap_or(0.0),
            "lathe" => lathe = pct_decode(v),
            _ => {}
        }
    }
    if path.is_empty() {
        write_simple(&mut stream, "400 Bad Request");
        return;
    }

    let lathe_bin = match crate::tools::find_tool_binary("lathe", &lathe) {
        Ok(p) => p,
        Err(e) => {
            write_500(&mut stream, &e);
            return;
        }
    };

    // Persistent decoder first; fall back to the stream-frames pipe when it
    // can't start (lathe built without libav, or the file defeats it).
    let mut persistent = true;
    let mut child;
    let mut geom;
    {
        let args = vec![
            "decode-server".to_string(),
            path.clone(),
            format!("--height={height}"),
            format!("--start={start}"),
        ];
        child = match spawn_lathe(&lathe_bin, &args, true) {
            Ok(c) => Some(c),
            Err(_) => None,
        };
        geom = child.as_mut().and_then(await_geom);
        if geom.is_none() {
            if let Some(mut c) = child.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
            persistent = false;
            let args = vec![
                "stream-frames".to_string(),
                path.clone(),
                format!("--height={height}"),
                format!("--fps={fps}"),
                format!("--start={start}"),
            ];
            child = match spawn_lathe(&lathe_bin, &args, false) {
                Ok(c) => Some(c),
                Err(e) => {
                    write_500(&mut stream, &e);
                    return;
                }
            };
            geom = child.as_mut().and_then(await_geom);
        }
    }
    let mut child = child.expect("child set on both paths");
    let Some(geom) = geom else {
        let _ = child.kill();
        let _ = child.wait();
        write_500(&mut stream, "lathe produced no video geometry");
        return;
    };

    let mut stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            write_500(&mut stream, "lathe stdout unavailable");
            return;
        }
    };

    // Register the persistent decoder so /vcontrol can reach its stdin, and
    // watch the socket for disconnect: a paused or end-of-file decoder writes
    // nothing, so the pump below would never see a write error and the decoder
    // would outlive its consumer. The client never sends bytes after the
    // headers, so a read returning 0/Err means it's gone.
    let stream_id = NEXT_STREAM_ID.fetch_add(1, Ordering::SeqCst);
    // Persistent: the child lives in the registry (cleanup = kill_stream).
    // Raw fallback: it stays local in raw_child.
    let mut raw_child = None;
    if persistent {
        let stdin = child.stdin.take();
        if let (Some(stdin), Ok(mut reg)) = (stdin, registry().lock()) {
            reg.insert(stream_id, StreamEntry { stdin, child });
        } else {
            let _ = child.kill();
            let _ = child.wait();
            write_500(&mut stream, "decoder registry unavailable");
            return;
        }
        if let Ok(mut watch) = stream.try_clone() {
            thread::spawn(move || {
                let mut b = [0u8; 16];
                loop {
                    match watch.read(&mut b) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {} // stray bytes — ignore
                    }
                }
                kill_stream(stream_id);
            });
        }
    } else {
        raw_child = Some(child);
    }

    // 200 + geometry/stream headers; body is the chunk stream until the decoder
    // exits (no Content-Length, Connection: close). Custom headers must be
    // CORS-exposed for the cross-origin (app -> 127.0.0.1) fetch to read them.
    let header = format!(
        "HTTP/1.1 200 OK\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Expose-Headers: X-Wavdesk-Geom, X-Wavdesk-Proto, X-Wavdesk-Stream-Id\r\n\
         X-Wavdesk-Geom: w={};h={};fps={};dur={};hdr={}\r\n\
         X-Wavdesk-Proto: {}\r\n\
         X-Wavdesk-Stream-Id: {}\r\n\
         Content-Type: application/octet-stream\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\r\n",
        geom.w,
        geom.h,
        geom.fps,
        geom.dur,
        geom.hdr,
        if persistent { "pts" } else { "raw" },
        stream_id
    );
    if stream.write_all(header.as_bytes()).is_err() {
        if persistent {
            kill_stream(stream_id);
        } else if let Some(mut c) = raw_child {
            let _ = c.kill();
            let _ = c.wait();
        }
        return;
    }

    // Pump frames to the socket until the decoder EOFs (exited / killed by the
    // watchdog) or the webview disconnects mid-write. Backpressure flows the
    // other way too: when the webview reads slowly the socket buffer fills,
    // this write blocks, the decoder's stdout fwrite blocks, and the decode
    // paces itself to ~1x.
    let mut buf = [0u8; 65536];
    loop {
        match stdout.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if stream.write_all(&buf[..n]).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    if persistent {
        kill_stream(stream_id);
    } else if let Some(mut c) = raw_child {
        let _ = c.kill();
        let _ = c.wait();
    }
}

// POST /vcontrol?id=<stream id>&op=seek|play|pause[&sec=<t>] — write the
// matching JSON command line to the decoder's stdin. 204 on success, 404 for
// an unknown/finished stream.
fn handle_vcontrol(stream: &mut TcpStream, path_qs: &str) {
    let qs = path_qs.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut id: u64 = 0;
    let mut op = String::new();
    let mut sec: f64 = 0.0;
    let mut dir: i32 = 1;
    let mut lin: f64 = 0.0;
    let mut lout: f64 = 0.0;
    let mut on: i32 = 1;
    for kv in qs.split('&') {
        let Some((k, v)) = kv.split_once('=') else { continue };
        match k {
            "id" => id = v.parse().unwrap_or(0),
            "op" => op = pct_decode(v),
            "sec" => sec = pct_decode(v).parse().unwrap_or(0.0),
            "dir" => dir = if pct_decode(v).starts_with('-') { -1 } else { 1 },
            "in" => lin = pct_decode(v).parse().unwrap_or(0.0),
            "out" => lout = pct_decode(v).parse().unwrap_or(0.0),
            "on" => on = pct_decode(v).parse().unwrap_or(1),
            _ => {}
        }
    }
    let line = match op.as_str() {
        "seek" => format!("{{\"op\":\"seek\",\"sec\":{sec:.6},\"dir\":{dir}}}\n"),
        "play" => "{\"op\":\"play\"}\n".to_string(),
        "pause" => "{\"op\":\"pause\"}\n".to_string(),
        // Gapless loop region; out <= in clears it.
        "loop" => format!("{{\"op\":\"loop\",\"in\":{lin:.6},\"out\":{lout:.6}}}\n"),
        // HDR→SDR tone-mapping (video decoder only).
        "tonemap" => format!("{{\"op\":\"tonemap\",\"on\":{on}}}\n"),
        _ => {
            write_simple(stream, "400 Bad Request");
            return;
        }
    };
    let ok = registry()
        .lock()
        .ok()
        .and_then(|mut reg| reg.get_mut(&id).map(|e| e.stdin.write_all(line.as_bytes()).is_ok()))
        .unwrap_or(false);
    if ok {
        write_simple(stream, "204 No Content");
    } else {
        write_simple(stream, "404 Not Found");
    }
}
