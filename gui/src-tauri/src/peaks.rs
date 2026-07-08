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
    // Source channel count (1 = mono). Lets the GUI decide mono-single-lane
    // vs stereo-split without a second probe.
    pub channels: u16,
    // [min, max, rms] per bin (signed, -1..1; rms 0..1). min/max are the
    // channel-extreme signed samples in the bin, so the GUI can paint the
    // asymmetric min/max envelope (the DAW look) instead of a symmetric bar;
    // rms backs an optional crest line. Matches WAVdesk's peak-bin shape.
    // ALWAYS the combined (all-channels-folded) envelope for back-compat.
    pub points: Vec<[f32; 3]>,
    // Per-channel bins, same [min,max,rms] shape, outer index = channel.
    // Populated ONLY when `per_channel` is requested (additive — the combined
    // `points` above is unchanged); empty otherwise. Backs the Chop window's
    // two-lane channel-split view. Mirrors WAVdesk's `channel_points`.
    #[serde(default)]
    pub channel_points: Vec<Vec<[f32; 3]>>,
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
    // When true, ALSO emit per-channel bins in `channel_points` (the combined
    // `points` is unchanged). Off = combined-only, the original behavior.
    per_channel: Option<bool>,
) -> Result<WaveformData, String> {
    let want_channels = per_channel.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || -> Result<WaveformData, String> {
        let (mut f, info) = open_wav(&path)?;
        let sr = info.sample_rate as f64;
        let duration_sec = info.total_frames as f64 / sr;
        // Up to 200k bins: the GUI fetches the WHOLE file once at high density
        // and draws subsets (no per-zoom refetch = no gaps), so the bin budget
        // has to cover deep zoom on a long clip. One-time cost per file.
        let bins = points.clamp(1, 200_000) as usize;

        let lo_frame = ((start_sec.unwrap_or(0.0).max(0.0) * sr) as u64).min(info.total_frames);
        let hi_frame = match end_sec {
            Some(e) if e > 0.0 => (((e * sr) as u64).max(lo_frame)).min(info.total_frames),
            _ => info.total_frames,
        };
        let span = hi_frame.saturating_sub(lo_frame);
        if span == 0 {
            let channel_points = if want_channels {
                vec![vec![[0.0, 0.0, 0.0]; bins]; info.channels as usize]
            } else {
                Vec::new()
            };
            return Ok(WaveformData {
                success: true,
                duration_sec,
                channels: info.channels,
                points: vec![[0.0, 0.0, 0.0]; bins],
                channel_points,
            });
        }

        // Per-bin signed min / max + running sum-of-squares for RMS. min/max
        // start at the neutral extremes so an untouched bin (more bins than
        // frames, at deep zoom) reports flat zero rather than a spurious spike.
        let mut mins = vec![f32::INFINITY; bins];
        let mut maxs = vec![f32::NEG_INFINITY; bins];
        let mut sumsq = vec![0f64; bins];
        let mut counts = vec![0u64; bins];

        f.seek(SeekFrom::Start(info.data_off + lo_frame * info.frame_bytes))
            .map_err(|e| e.to_string())?;
        let frame_bytes = info.frame_bytes as usize;
        let chans = info.channels as usize;

        // Per-channel accumulators — only allocated when a split view is asked
        // for (a stereo whole-file scan at 200k bins is 2 extra Vecs; skip it
        // for the common combined path). Same neutral-extreme seeding.
        let mut ch_mins: Vec<Vec<f32>> = if want_channels { vec![vec![f32::INFINITY; bins]; chans] } else { Vec::new() };
        let mut ch_maxs: Vec<Vec<f32>> = if want_channels { vec![vec![f32::NEG_INFINITY; bins]; chans] } else { Vec::new() };
        let mut ch_sumsq: Vec<Vec<f64>> = if want_channels { vec![vec![0f64; bins]; chans] } else { Vec::new() };
        let mut ch_counts: Vec<Vec<u64>> = if want_channels { vec![vec![0u64; bins]; chans] } else { Vec::new() };
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
                for c in 0..chans {
                    // Signed sample (no abs) — min/max carry the polarity that
                    // makes the envelope asymmetric.
                    let s = if info.is_float {
                        let o = off + c * 4;
                        f32::from_le_bytes([buf[o], buf[o + 1], buf[o + 2], buf[o + 3]])
                    } else {
                        let o = off + c * 2;
                        i16::from_le_bytes([buf[o], buf[o + 1]]) as f32 / 32768.0
                    };
                    if s < mins[bin] { mins[bin] = s; }
                    if s > maxs[bin] { maxs[bin] = s; }
                    sumsq[bin] += (s as f64) * (s as f64);
                    counts[bin] += 1;
                    if want_channels {
                        if s < ch_mins[c][bin] { ch_mins[c][bin] = s; }
                        if s > ch_maxs[c][bin] { ch_maxs[c][bin] = s; }
                        ch_sumsq[c][bin] += (s as f64) * (s as f64);
                        ch_counts[c][bin] += 1;
                    }
                }
            }
            frame_idx += frames as u64;
        }
        let points: Vec<[f32; 3]> = (0..bins)
            .map(|b| {
                if counts[b] == 0 {
                    [0.0, 0.0, 0.0]
                } else {
                    [mins[b], maxs[b], (sumsq[b] / counts[b] as f64).sqrt() as f32]
                }
            })
            .collect();
        let channel_points: Vec<Vec<[f32; 3]>> = if want_channels {
            (0..chans)
                .map(|c| {
                    (0..bins)
                        .map(|b| {
                            if ch_counts[c][b] == 0 {
                                [0.0, 0.0, 0.0]
                            } else {
                                [
                                    ch_mins[c][b],
                                    ch_maxs[c][b],
                                    (ch_sumsq[c][b] / ch_counts[c][b] as f64).sqrt() as f32,
                                ]
                            }
                        })
                        .collect()
                })
                .collect()
        } else {
            Vec::new()
        };
        Ok(WaveformData { success: true, duration_sec, channels: info.channels, points, channel_points })
    })
    .await
    .map_err(|e| format!("waveform join: {e}"))?
}

/// Format-agnostic peaks for the Extract output audition fold-out. The
/// Chop window's `generate_waveform` above is a WAV-only RIFF parser (it
/// only ever sees latch's own WAV clips + wants range/zoom re-fetch); the
/// audition fold-out plays finished DOWNLOADS, which are mp3 / m4a / opus /
/// flac — anything but WAV. Decode the whole file through rodio's
/// symphonia decoder (so every format Latch outputs works) and fold it
/// into the same [min, max, rms] bins the shared chip renderer expects.
/// Whole-file, no range: the fold-out draws one fixed strip per open.
#[tauri::command]
pub async fn generate_waveform_any(path: String, points: u32) -> Result<WaveformData, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<WaveformData, String> {
        use rodio::Source;
        let file = std::fs::File::open(&path).map_err(|e| format!("open {path}: {e}"))?;
        let decoder = rodio::Decoder::new(std::io::BufReader::new(file))
            .map_err(|e| format!("decode {path}: {e}"))?;
        let ch = decoder.channels().max(1) as usize;
        let sr = decoder.sample_rate().max(1);
        let bins = points.clamp(1, 200_000) as usize;

        // rodio's Decoder yields interleaved i16 samples. Collect them (a
        // finished download track is a bounded one-shot cost on a blocking
        // thread), then fold into bins. Per-bin signed min / max carry the
        // asymmetric envelope; sum-of-squares backs the rms crest line.
        let samples: Vec<f32> = decoder.map(|s| s as f32 / 32768.0).collect();
        let total_frames = samples.len() / ch;
        let duration_sec = total_frames as f64 / sr as f64;

        let mut mins = vec![f32::INFINITY; bins];
        let mut maxs = vec![f32::NEG_INFINITY; bins];
        let mut sumsq = vec![0f64; bins];
        let mut counts = vec![0u64; bins];
        if total_frames > 0 {
            for f in 0..total_frames {
                let bin = ((f as u64 * bins as u64) / total_frames as u64) as usize;
                let bin = bin.min(bins - 1);
                for c in 0..ch {
                    let v = samples[f * ch + c];
                    if v < mins[bin] { mins[bin] = v; }
                    if v > maxs[bin] { maxs[bin] = v; }
                    sumsq[bin] += (v as f64) * (v as f64);
                    counts[bin] += 1;
                }
            }
        }
        let points_out: Vec<[f32; 3]> = (0..bins)
            .map(|b| {
                if counts[b] == 0 {
                    [0.0, 0.0, 0.0]
                } else {
                    [mins[b], maxs[b], (sumsq[b] / counts[b] as f64).sqrt() as f32]
                }
            })
            .collect();
        Ok(WaveformData {
            success: true,
            duration_sec,
            channels: ch as u16,
            points: points_out,
            channel_points: Vec::new(),
        })
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
