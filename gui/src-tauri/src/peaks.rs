// WAV peak bins + zero-crossing scan for the Chop window. Both walk the
// same minimal RIFF parser (PCM s16 + float32 — everything latch's own
// pipeline writes). Peaks are max-abs per bin over an optional
// [start_sec, end_sec) range, so the waveform re-fetches the visible
// window at zoom time and stays sharp at any scale.

use std::io::{Read, Seek, SeekFrom};

struct WavInfo {
    is_float: bool,
    channels: u16,
    sample_rate: u32,
    data_off: u64,
    total_frames: u64,
    frame_bytes: u64,
}

fn open_wav(path: &str) -> Result<(std::fs::File, WavInfo), String> {
    let mut f = std::fs::File::open(path).map_err(|e| format!("open {path}: {e}"))?;
    let mut hdr = [0u8; 12];
    f.read_exact(&mut hdr).map_err(|e| format!("riff header: {e}"))?;
    if &hdr[0..4] != b"RIFF" || &hdr[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE file".into());
    }
    let (mut fmt_tag, mut channels, mut sample_rate, mut bits) = (0u16, 0u16, 0u32, 0u16);
    let mut data_off = 0u64;
    let mut data_len = 0u64;
    loop {
        let mut ch = [0u8; 8];
        if f.read_exact(&mut ch).is_err() {
            break;
        }
        let id = [ch[0], ch[1], ch[2], ch[3]];
        let sz = u32::from_le_bytes([ch[4], ch[5], ch[6], ch[7]]) as u64;
        match &id {
            b"fmt " => {
                let mut buf = vec![0u8; sz as usize];
                f.read_exact(&mut buf).map_err(|e| format!("fmt chunk: {e}"))?;
                fmt_tag = u16::from_le_bytes([buf[0], buf[1]]);
                channels = u16::from_le_bytes([buf[2], buf[3]]);
                sample_rate = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]);
                bits = u16::from_le_bytes([buf[14], buf[15]]);
            }
            b"data" => {
                data_off = f.stream_position().map_err(|e| e.to_string())?;
                data_len = sz;
                break;
            }
            _ => {
                f.seek(SeekFrom::Current((sz + (sz & 1)) as i64))
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    if data_off == 0 || sample_rate == 0 || channels == 0 {
        return Err("no fmt/data chunk".into());
    }
    let is_float = fmt_tag == 3 || (fmt_tag == 0xFFFE && bits == 32);
    let is_s16 = (fmt_tag == 1 || fmt_tag == 0xFFFE) && bits == 16;
    if !is_float && !is_s16 {
        return Err(format!("unsupported wav format (tag {fmt_tag}, {bits}-bit)"));
    }
    let bytes_per_sample = (bits as u64) / 8;
    let frame_bytes = bytes_per_sample * channels as u64;
    let total_frames = data_len / frame_bytes;
    Ok((
        f,
        WavInfo { is_float, channels, sample_rate, data_off, total_frames, frame_bytes },
    ))
}

#[derive(serde::Serialize)]
pub struct WaveformData {
    pub success: bool,
    pub duration_sec: f64,
    pub points: Vec<f32>, // max-abs per bin, 0..1, channel-max
}

/// Max-abs peak bins over [start_sec, end_sec) (whole file when absent).
/// Streams the data chunk in 1 MB slabs — a long DJ-mix WAV never loads
/// whole into memory.
#[tauri::command]
pub async fn generate_waveform(
    path: String,
    points: u32,
    start_sec: Option<f64>,
    end_sec: Option<f64>,
) -> Result<WaveformData, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<WaveformData, String> {
        let (mut f, info) = open_wav(&path)?;
        let sr = info.sample_rate as f64;
        let duration_sec = info.total_frames as f64 / sr;
        let bins = points.clamp(1, 20_000) as usize;

        let lo_frame = ((start_sec.unwrap_or(0.0).max(0.0) * sr) as u64).min(info.total_frames);
        let hi_frame = match end_sec {
            Some(e) if e > 0.0 => (((e * sr) as u64).max(lo_frame)).min(info.total_frames),
            _ => info.total_frames,
        };
        let span = hi_frame.saturating_sub(lo_frame);
        let mut peaks = vec![0f32; bins];
        if span == 0 {
            return Ok(WaveformData { success: true, duration_sec, points: peaks });
        }

        f.seek(SeekFrom::Start(info.data_off + lo_frame * info.frame_bytes))
            .map_err(|e| e.to_string())?;
        let frame_bytes = info.frame_bytes as usize;
        let chans = info.channels as usize;
        const SLAB: usize = 1 << 20;
        let frames_per_slab = (SLAB / frame_bytes).max(1);
        let mut buf = vec![0u8; frames_per_slab * frame_bytes];
        let mut frame_idx: u64 = 0;
        while frame_idx < span {
            let want = ((span - frame_idx) as usize).min(frames_per_slab) * frame_bytes;
            let read = f.read(&mut buf[..want]).map_err(|e| e.to_string())?;
            if read == 0 {
                break;
            }
            let frames = read / frame_bytes;
            for i in 0..frames {
                let bin = (((frame_idx + i as u64) * bins as u64) / span) as usize;
                let bin = bin.min(bins - 1);
                let off = i * frame_bytes;
                let mut amp = 0f32;
                for c in 0..chans {
                    let s = if info.is_float {
                        let o = off + c * 4;
                        f32::from_le_bytes([buf[o], buf[o + 1], buf[o + 2], buf[o + 3]]).abs()
                    } else {
                        let o = off + c * 2;
                        (i16::from_le_bytes([buf[o], buf[o + 1]]) as f32 / 32768.0).abs()
                    };
                    if s > amp {
                        amp = s;
                    }
                }
                if amp > peaks[bin] {
                    peaks[bin] = amp;
                }
            }
            frame_idx += frames as u64;
        }
        Ok(WaveformData { success: true, duration_sec, points: peaks })
    })
    .await
    .map_err(|e| format!("waveform join: {e}"))?
}

/// Nearest zero crossing around `time_sec` (±window_ms, first channel).
/// Fork of WAVdesk's wav_nearest_zero_cross — backs snap-on-release.
/// Returns -1.0 when no crossing lies inside the window.
#[tauri::command]
pub async fn wav_nearest_zero_cross(
    path: String,
    time_sec: f64,
    window_ms: f64,
) -> Result<f64, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<f64, String> {
        let (mut f, info) = open_wav(&path)?;
        let sr = info.sample_rate as f64;
        let center = (time_sec * sr).round() as i64;
        let win = ((window_ms / 1000.0) * sr).ceil() as i64;
        let lo = (center - win).clamp(0, info.total_frames.saturating_sub(2) as i64) as u64;
        let hi = ((center + win) as u64).min(info.total_frames.saturating_sub(1));
        if hi <= lo {
            return Ok(-1.0);
        }
        let n = (hi - lo + 1) as usize;
        let frame_bytes = info.frame_bytes as usize;
        let mut buf = vec![0u8; n * frame_bytes];
        f.seek(SeekFrom::Start(info.data_off + lo * info.frame_bytes))
            .map_err(|e| e.to_string())?;
        let read = f.read(&mut buf).map_err(|e| e.to_string())?;
        let frames = read / frame_bytes;
        if frames < 2 {
            return Ok(-1.0);
        }
        let sample = |i: usize| -> f64 {
            let off = i * frame_bytes;
            if info.is_float {
                f32::from_le_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]]) as f64
            } else {
                i16::from_le_bytes([buf[off], buf[off + 1]]) as f64
            }
        };
        let mut best: Option<(f64, f64)> = None;
        for i in 0..frames - 1 {
            let a = sample(i);
            let b = sample(i + 1);
            if (a <= 0.0 && b > 0.0) || (a >= 0.0 && b < 0.0) || a == 0.0 {
                let frac = if (b - a).abs() > f64::EPSILON { -a / (b - a) } else { 0.0 };
                let cross = lo as f64 + i as f64 + frac.clamp(0.0, 1.0);
                let dist = (cross - center as f64).abs();
                if best.map_or(true, |(d, _)| dist < d) {
                    best = Some((dist, cross));
                }
            }
        }
        Ok(best.map_or(-1.0, |(_, c)| c / sr))
    })
    .await
    .map_err(|e| format!("zero-cross join: {e}"))?
}
