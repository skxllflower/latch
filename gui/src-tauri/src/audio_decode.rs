// Universal audio decode via the bundled ffmpeg — the fallback for containers /
// codecs this crate's rodio + symphonia build can't handle. Symphonia in
// rodio 0.20 has NO working Opus decoder (YouTube's default `bestaudio`, served
// as .webm / .opus) and PANICS during init on AAC/m4a (mp4 hits an
// `unreachable!("Seek errors should not occur during initialization")`). Latch
// downloads take whatever the source serves, so those formats are common — this
// routes them through ffmpeg (already bundled + provisioned into the shared bin)
// to raw PCM, so the audition fold-out's waveform + playback work for every
// output Latch produces, not just WAV / MP3 / FLAC.

use std::path::PathBuf;
use std::process::{Command, Stdio};

/// Resolve a usable ffmpeg. Order mirrors the C++/tools resolver: the shared
/// managed bin (ProgramData first, then LOCALAPPDATA — installs land in one or
/// the other), then next to this exe (coredist / sibling), then a bare `ffmpeg`
/// on PATH. `LATCH_FFMPEG` overrides everything (dev / testing).
pub fn resolve_ffmpeg() -> PathBuf {
    let exe = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };

    if let Some(p) = std::env::var_os("LATCH_FFMPEG") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return p;
        }
    }

    let mut cands: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    {
        for var in ["ProgramData", "LOCALAPPDATA"] {
            if let Some(base) = std::env::var_os(var) {
                cands.push(
                    PathBuf::from(base)
                        .join("Vacant Systems")
                        .join("Shared")
                        .join("bin")
                        .join(exe),
                );
            }
        }
        if let Ok(cur) = std::env::current_exe() {
            if let Some(dir) = cur.parent() {
                cands.push(dir.join("coredist").join(exe));
                cands.push(dir.join(exe));
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(h) = std::env::var_os("HOME") {
            cands.push(
                PathBuf::from(h)
                    .join("Library/Application Support/Vacant Systems/Shared/bin")
                    .join(exe),
            );
        }
    }
    for c in cands {
        if c.is_file() {
            return c;
        }
    }
    PathBuf::from(exe) // last resort: rely on PATH
}

/// True when the file's container is one rodio's symphonia build mishandles:
/// MP4 / m4a (panics on init), Matroska / WebM and Ogg (Opus fails to decode).
/// Sniffs magic bytes so the fast native rodio path still serves WAV / MP3 /
/// FLAC. A read failure returns false — the caller's rodio attempt then surfaces
/// the real open error.
pub fn prefers_ffmpeg(path: &str) -> bool {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut b = [0u8; 12];
    let n = f.read(&mut b).unwrap_or(0);
    if n < 12 {
        return false;
    }
    // ISO-BMFF (mp4 / m4a / mov): "ftyp" box at offset 4.
    if &b[4..8] == b"ftyp" {
        return true;
    }
    // Matroska / WebM: EBML header 1A 45 DF A3.
    if b[0..4] == [0x1A, 0x45, 0xDF, 0xA3] {
        return true;
    }
    // Ogg (Opus or Vorbis): "OggS". ffmpeg decodes both; symphonia only vorbis,
    // so route the whole container rather than sniff the inner codec.
    if &b[0..4] == b"OggS" {
        return true;
    }
    false
}

/// Decode any container / codec to interleaved i16 PCM at 48 kHz stereo via
/// ffmpeg. `start_sec` > 0 fast-seeks before decoding. Returns
/// (interleaved samples, channels = 2, sample_rate = 48000). A fixed output
/// layout keeps the caller trivial — 48k stereo is transparent for audition.
pub fn ffmpeg_decode_pcm(path: &str, start_sec: f64) -> Result<(Vec<i16>, u16, u32), String> {
    let ff = resolve_ffmpeg();
    let mut cmd = Command::new(&ff);
    cmd.arg("-v").arg("error").arg("-nostdin");
    if start_sec > 0.0 {
        cmd.arg("-ss").arg(format!("{start_sec:.4}"));
    }
    cmd.arg("-i")
        .arg(path)
        .arg("-vn") // drop any cover-art video stream
        .arg("-ac")
        .arg("2")
        .arg("-ar")
        .arg("48000")
        .arg("-f")
        .arg("s16le")
        .arg("-acodec")
        .arg("pcm_s16le")
        .arg("-")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW — no console flash
    }
    let out = cmd
        .output()
        .map_err(|e| format!("ffmpeg spawn ({}): {e}", ff.display()))?;
    if !out.status.success() {
        let tail = String::from_utf8_lossy(&out.stderr);
        let last = tail
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .trim();
        return Err(format!("ffmpeg decode failed: {last}"));
    }
    let bytes = out.stdout;
    if bytes.len() < 2 {
        return Err("ffmpeg produced no audio (no decodable audio stream?)".into());
    }
    let mut samples = Vec::with_capacity(bytes.len() / 2);
    for ch in bytes.chunks_exact(2) {
        samples.push(i16::from_le_bytes([ch[0], ch[1]]));
    }
    Ok((samples, 2, 48000))
}
