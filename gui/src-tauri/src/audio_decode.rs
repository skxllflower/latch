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

/// Frontend routing probe for the chop window: true when playing this file
/// source-direct would land in the whole-tail ffmpeg RAM-buffer lane
/// (see `prefers_ffmpeg`) instead of the engine's native streaming — the
/// chop window then derives a full-quality WAV companion for the audible
/// lane. Magic-byte sniff, so a mislabeled extension routes correctly.
#[tauri::command]
pub async fn audio_prefers_ffmpeg(path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || prefers_ffmpeg(&path))
        .await
        .map_err(|e| format!("sniff join: {e}"))
}

/// Depth-preserving routing for the audition engine's native (non-ffmpeg)
/// lane. rodio's Decoder is hardwired to i16 (rodio 0.20.1: every
/// DecoderImpl arm is `type Item = i16`; decoder/symphonia.rs buffers
/// into `SampleBuffer<i16>`), so lossless sources above 16 bits must
/// route AROUND it:
/// - WAV (any depth): the hand-rolled streaming f32 source (wav_stream).
///   Exact for 16-bit too, and its seeks are cheap byte seeks.
/// - FLAC over 16 bits: symphonia driven directly to f32 (flac_f32).
/// - Everything else (mp3, 16-bit flac, ...): rodio, where i16 is either
///   transparent (16-bit int) or the source is lossy anyway.
pub enum NativeRoute {
    WavF32,
    FlacF32,
    Rodio,
}

/// FLAC STREAMINFO bits-per-sample from the file's leading bytes (needs
/// at least 26). STREAMINFO is mandatory-first per spec; bps-1 lives in
/// the 5 bits below the 36-bit total-samples field.
pub fn flac_streaminfo_bits(head: &[u8]) -> Option<u32> {
    if head.len() < 26 || &head[0..4] != b"fLaC" {
        return None;
    }
    if head[4] & 0x7F != 0 {
        return None; // first metadata block is not STREAMINFO
    }
    let v = u64::from_be_bytes(head[18..26].try_into().ok()?);
    Some((((v >> 36) & 0x1F) as u32) + 1)
}

/// Byte length of a leading ID3v2 tag (10-byte header + syncsafe size +
/// optional footer), or None when `head` doesn't start with one.
pub fn id3v2_tag_len(head: &[u8]) -> Option<u64> {
    if head.len() < 10 || &head[0..3] != b"ID3" {
        return None;
    }
    // Syncsafe u28: 7 bits per byte, high bit must be clear.
    if head[6..10].iter().any(|b| b & 0x80 != 0) {
        return None;
    }
    let size = ((head[6] as u64) << 21)
        | ((head[7] as u64) << 14)
        | ((head[8] as u64) << 7)
        | (head[9] as u64);
    let footer = if head[5] & 0x10 != 0 { 10 } else { 0 };
    Some(10 + size + footer)
}

/// Magic-byte sniff for the native lane. Read failure = Rodio (its open
/// attempt surfaces the real error).
pub fn native_route(path: &str) -> NativeRoute {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else {
        return NativeRoute::Rodio;
    };
    let mut b = [0u8; 26];
    let mut n = f.read(&mut b).unwrap_or(0);
    if n >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WAVE" {
        return NativeRoute::WavF32;
    }
    // Some taggers prefix FLAC with an ID3v2 tag (nonstandard, but real
    // files exist): skip it and re-sniff, else a 24-bit file silently
    // rides rodio's i16 path. flac_f32's symphonia probe skips the tag
    // on its own, so routing there is safe.
    if let Some(skip) = id3v2_tag_len(&b[..n]) {
        match f.seek(SeekFrom::Start(skip)).and_then(|_| f.read(&mut b)) {
            Ok(m) => n = m,
            Err(_) => return NativeRoute::Rodio,
        }
    }
    if n >= 26 && &b[0..4] == b"fLaC" {
        if flac_streaminfo_bits(&b).is_some_and(|bits| bits > 16) {
            return NativeRoute::FlacF32;
        }
    }
    NativeRoute::Rodio
}

/// Probe an input's audio sample rate via ffprobe (provisioned into the
/// shared bin next to ffmpeg — see tools.rs). None = probe unavailable /
/// unparseable; the decode then falls back to forcing 48 kHz so the raw
/// stream stays interpretable.
fn ffprobe_sample_rate(path: &str) -> Option<u32> {
    let ff = resolve_ffmpeg();
    let probe_name = if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" };
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Some(p) = std::env::var_os("LATCH_FFPROBE") {
        cands.push(PathBuf::from(p));
    }
    if let Some(dir) = ff.parent().filter(|d| !d.as_os_str().is_empty()) {
        cands.push(dir.join(probe_name));
    }
    let probe = cands
        .into_iter()
        .find(|c| c.is_file())
        .unwrap_or_else(|| PathBuf::from(probe_name)); // PATH last resort
    let mut cmd = Command::new(&probe);
    cmd.arg("-v")
        .arg("error")
        .arg("-select_streams")
        .arg("a:0")
        .arg("-show_entries")
        .arg("stream=sample_rate")
        .arg("-of")
        .arg("csv=p=0")
        .arg(path)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW — no console flash
    }
    let out = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let rate: u32 = text.trim().lines().next()?.trim().parse().ok()?;
    // Sanity window: garbage rates would make the raw stream nonsense.
    (8_000..=384_000).contains(&rate).then_some(rate)
}

/// Decode any container / codec to interleaved f32 PCM, stereo, at the
/// SOURCE sample rate (probed first so the raw stream is interpretable;
/// 48 kHz only as the no-probe fallback). `start_sec` > 0 fast-seeks
/// before decoding. Returns (interleaved samples, channels = 2, rate).
/// Stereo stays forced (-ac 2) — the buffer-backed audition lane wants a
/// fixed channel layout, and a downmix is not a depth loss. f32 at
/// source rate roughly doubles RAM per second vs the old 48k s16le:
/// acceptable because this lane serves bounded downloads and last-resort
/// fallbacks only, never a policy route for large local files.
pub fn ffmpeg_decode_pcm(path: &str, start_sec: f64) -> Result<(Vec<f32>, u16, u32), String> {
    let ff = resolve_ffmpeg();
    let rate = ffprobe_sample_rate(path).unwrap_or(48_000);
    let mut cmd = Command::new(&ff);
    cmd.arg("-v").arg("error").arg("-nostdin");
    if start_sec > 0.0 {
        cmd.arg("-ss").arg(format!("{start_sec:.4}"));
    }
    cmd.arg("-i")
        .arg(path)
        // Decode the SAME stream ffprobe rated (a:0): ffmpeg's default
        // pick is the most-channels audio stream, which can differ on
        // multi-track containers and would hide a resample behind -ar.
        .arg("-map")
        .arg("0:a:0")
        .arg("-vn") // drop any cover-art video stream
        .arg("-ac")
        .arg("2")
        .arg("-ar")
        .arg(rate.to_string())
        .arg("-f")
        .arg("f32le")
        .arg("-acodec")
        .arg("pcm_f32le")
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
    if bytes.len() < 4 {
        return Err("ffmpeg produced no audio (no decodable audio stream?)".into());
    }
    let mut samples = Vec::with_capacity(bytes.len() / 4);
    for ch in bytes.chunks_exact(4) {
        samples.push(f32::from_le_bytes([ch[0], ch[1], ch[2], ch[3]]));
    }
    Ok((samples, 2, rate))
}

#[cfg(test)]
mod tests {
    use super::{flac_streaminfo_bits, id3v2_tag_len};

    // fLaC + STREAMINFO block header + 34-byte STREAMINFO body with the
    // packed sr/ch/bps/total field at body bytes 10..18.
    fn flac_head(sample_rate: u32, channels: u32, bits: u32) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"fLaC");
        v.push(0x00); // block type 0 = STREAMINFO, not last
        v.extend_from_slice(&[0, 0, 34]); // block length
        v.extend_from_slice(&[0u8; 10]); // block/frame size fields
        let packed: u64 = ((sample_rate as u64) << 44)
            | (((channels - 1) as u64) << 41)
            | (((bits - 1) as u64) << 36);
        v.extend_from_slice(&packed.to_be_bytes());
        v.extend_from_slice(&[0u8; 16]); // md5
        v
    }

    #[test]
    fn parses_streaminfo_bits() {
        assert_eq!(flac_streaminfo_bits(&flac_head(44_100, 2, 16)), Some(16));
        assert_eq!(flac_streaminfo_bits(&flac_head(96_000, 2, 24)), Some(24));
        assert_eq!(flac_streaminfo_bits(&flac_head(48_000, 1, 20)), Some(20));
    }

    #[test]
    fn rejects_non_flac() {
        assert_eq!(flac_streaminfo_bits(b"RIFFxxxxWAVEfmt padpadpadpad"), None);
        assert_eq!(flac_streaminfo_bits(b"fLaC"), None); // too short
    }

    #[test]
    fn parses_id3v2_len() {
        // "ID3", v2.4.0, no flags, syncsafe size 0x0201 = (2<<7)|1 = 257.
        let head = [b'I', b'D', b'3', 4, 0, 0x00, 0, 0, 2, 1];
        assert_eq!(id3v2_tag_len(&head), Some(10 + 257));
        // Footer flag (0x10) adds 10 bytes.
        let footed = [b'I', b'D', b'3', 4, 0, 0x10, 0, 0, 2, 1];
        assert_eq!(id3v2_tag_len(&footed), Some(10 + 257 + 10));
    }

    #[test]
    fn rejects_non_id3() {
        assert_eq!(id3v2_tag_len(b"fLaCxxxxxx"), None);
        assert_eq!(id3v2_tag_len(b"ID3\x04\x00"), None); // too short
        // Non-syncsafe size byte (high bit set) is not a valid tag.
        let bad = [b'I', b'D', b'3', 4, 0, 0, 0x80, 0, 0, 1];
        assert_eq!(id3v2_tag_len(&bad), None);
    }
}
