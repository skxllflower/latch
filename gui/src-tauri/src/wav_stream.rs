// Depth-preserving streaming WAV source for the audition engine. rodio's
// Decoder is hardwired to i16 (rodio 0.20.1 decoder/mod.rs: `type Item =
// i16` on every DecoderImpl arm, and decoder/symphonia.rs buffers into
// `SampleBuffer<i16>`), so 24/32-bit and float WAVs — the chop window's
// full-quality companions are pcm_s24le / pcm_f32le — lose depth at the
// decoder boundary even though the file is lossless. This source parses
// the RIFF header itself, streams the data chunk from disk through a
// BufReader (never whole-file into RAM), converts each sample to f32,
// and forwards try_seek as an exact frame-aligned byte seek — the Sink's
// wrapper stack (speed → track_position → pausable → amplify) forwards
// try_seek down to us, verified in the vendored rodio source.

use std::io::{BufReader, Read, Seek, SeekFrom};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleKind {
    U8,
    I16,
    I24,
    I32,
    F32,
    F64,
}

#[derive(Debug, Clone, Copy)]
pub struct WavLayout {
    pub channels: u16,
    pub sample_rate: u32,
    pub kind: SampleKind,
    pub bytes_per_sample: u16,
    pub block_align: u16,
    pub data_start: u64,
    pub data_len: u64,
}

impl WavLayout {
    pub fn total_frames(&self) -> u64 {
        self.data_len / self.block_align.max(1) as u64
    }

    /// Frame index for an absolute second, clamped into the data chunk.
    pub fn seek_frame(&self, sec: f64) -> u64 {
        let f = (sec.max(0.0) * self.sample_rate as f64) as u64;
        f.min(self.total_frames())
    }

    /// Absolute byte offset of a frame — always frame-aligned, so a seek
    /// can never land mid-sample or swap channels.
    pub fn frame_byte(&self, frame: u64) -> u64 {
        self.data_start + frame * self.block_align as u64
    }
}

/// Normalize signed 24-bit little-endian bytes to -1.0..1.0.
pub fn s24_to_f32(b0: u8, b1: u8, b2: u8) -> f32 {
    let v = (i32::from(b2 as i8) << 16) | (i32::from(b1) << 8) | i32::from(b0);
    v as f32 / 8_388_608.0
}

/// Parse a plain RIFF/WAVE header from any seekable reader. Supports the
/// PCM (tag 1) and IEEE-float (tag 3) sample layouts latch and studio
/// tools write, plus WAVE_FORMAT_EXTENSIBLE (tag 0xFFFE) resolved via its
/// SubFormat GUID. Anything else (ADPCM, a-law, RF64...) is an Err — the
/// caller falls back to rodio, then ffmpeg.
pub fn parse_wav_header<R: Read + Seek>(r: &mut R) -> Result<WavLayout, String> {
    let mut hdr = [0u8; 12];
    r.read_exact(&mut hdr).map_err(|e| format!("riff header: {e}"))?;
    if &hdr[0..4] != b"RIFF" || &hdr[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE file".into());
    }

    let mut fmt: Option<(u16, u16, u32, u16, u16)> = None; // tag, ch, rate, block_align, bits
    let mut data: Option<(u64, u64)> = None; // start, len
    loop {
        let mut ch = [0u8; 8];
        if r.read_exact(&mut ch).is_err() {
            break;
        }
        let sz = u32::from_le_bytes([ch[4], ch[5], ch[6], ch[7]]) as u64;
        match &ch[0..4] {
            b"fmt " => {
                if sz < 16 {
                    return Err("fmt chunk too short".into());
                }
                let take = sz.min(40) as usize;
                let mut buf = vec![0u8; take];
                r.read_exact(&mut buf).map_err(|e| format!("fmt chunk: {e}"))?;
                let mut tag = u16::from_le_bytes([buf[0], buf[1]]);
                let channels = u16::from_le_bytes([buf[2], buf[3]]);
                let rate = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]);
                let block_align = u16::from_le_bytes([buf[12], buf[13]]);
                let bits = u16::from_le_bytes([buf[14], buf[15]]);
                if tag == 0xFFFE {
                    // Extensible: the real format lives in the SubFormat
                    // GUID's leading two bytes (1 = PCM, 3 = float).
                    if take < 26 {
                        return Err("extensible fmt chunk too short".into());
                    }
                    tag = u16::from_le_bytes([buf[24], buf[25]]);
                }
                fmt = Some((tag, channels, rate, block_align, bits));
                let rest = sz - take as u64;
                let skip = rest + (sz & 1);
                if skip > 0 {
                    r.seek(SeekFrom::Current(skip as i64)).map_err(|e| e.to_string())?;
                }
            }
            b"data" => {
                let start = r.stream_position().map_err(|e| e.to_string())?;
                // A 0 / 0xFFFFFFFF size (streamed writer) or a truncated
                // file: trust the bytes actually on disk instead.
                let end = r.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
                let remaining = end.saturating_sub(start);
                let len = if sz == 0 || sz == u32::MAX as u64 { remaining } else { sz.min(remaining) };
                data = Some((start, len));
                if fmt.is_some() {
                    break;
                }
                // fmt after data (nonstandard but legal): keep scanning.
                r.seek(SeekFrom::Start(start + sz + (sz & 1)))
                    .map_err(|e| e.to_string())?;
            }
            _ => {
                r.seek(SeekFrom::Current((sz + (sz & 1)) as i64))
                    .map_err(|e| e.to_string())?;
            }
        }
        if fmt.is_some() && data.is_some() {
            break;
        }
    }

    let (tag, channels, sample_rate, block_align, bits) = fmt.ok_or("no fmt chunk")?;
    let (data_start, data_len) = data.ok_or("no data chunk")?;
    if channels == 0 || sample_rate == 0 {
        return Err("bad fmt chunk (zero channels / rate)".into());
    }
    let kind = match (tag, bits) {
        (1, 8) => SampleKind::U8,
        (1, 16) => SampleKind::I16,
        (1, 24) => SampleKind::I24,
        (1, 32) => SampleKind::I32,
        (3, 32) => SampleKind::F32,
        (3, 64) => SampleKind::F64,
        _ => return Err(format!("unsupported wav format (tag {tag}, {bits}-bit)")),
    };
    let bytes_per_sample = bits / 8;
    let expect_align = channels
        .checked_mul(bytes_per_sample)
        .ok_or("bad fmt chunk (align overflow)")?;
    // A block_align that disagrees with ch*bytes means packed / padded
    // frames we don't model — reject rather than de-interleave garbage.
    if block_align != 0 && block_align != expect_align {
        return Err(format!(
            "unsupported wav frame layout (block align {block_align}, expected {expect_align})"
        ));
    }
    Ok(WavLayout {
        channels,
        sample_rate,
        kind,
        bytes_per_sample,
        block_align: expect_align,
        data_start,
        data_len,
    })
}

pub struct WavF32Source<R: Read + Seek> {
    reader: R,
    layout: WavLayout,
    emitted: u64, // samples handed out since data_start
    total_samples: u64,
}

impl WavF32Source<BufReader<std::fs::File>> {
    pub fn open(path: &str) -> Result<Self, String> {
        let file = std::fs::File::open(path).map_err(|e| format!("open {path}: {e}"))?;
        Self::from_reader(BufReader::with_capacity(1 << 16, file))
    }
}

impl<R: Read + Seek> WavF32Source<R> {
    pub fn from_reader(mut reader: R) -> Result<Self, String> {
        let layout = parse_wav_header(&mut reader)?;
        reader
            .seek(SeekFrom::Start(layout.data_start))
            .map_err(|e| format!("seek to data: {e}"))?;
        let total_samples = layout.total_frames() * layout.channels as u64;
        Ok(WavF32Source { reader, layout, emitted: 0, total_samples })
    }
}

impl<R: Read + Seek> Iterator for WavF32Source<R> {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if self.emitted >= self.total_samples {
            return None;
        }
        let n = self.layout.bytes_per_sample as usize;
        let mut b = [0u8; 8];
        if self.reader.read_exact(&mut b[..n]).is_err() {
            self.emitted = self.total_samples; // truncated file: end cleanly
            return None;
        }
        self.emitted += 1;
        Some(match self.layout.kind {
            SampleKind::U8 => (b[0] as f32 - 128.0) / 128.0,
            SampleKind::I16 => i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0,
            SampleKind::I24 => s24_to_f32(b[0], b[1], b[2]),
            SampleKind::I32 => {
                i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 / 2_147_483_648.0
            }
            SampleKind::F32 => f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
            SampleKind::F64 => f64::from_le_bytes(b) as f32,
        })
    }
}

impl<R: Read + Seek> rodio::Source for WavF32Source<R> {
    fn current_frame_len(&self) -> Option<usize> {
        None
    }

    fn channels(&self) -> u16 {
        self.layout.channels
    }

    fn sample_rate(&self) -> u32 {
        self.layout.sample_rate
    }

    fn total_duration(&self) -> Option<Duration> {
        Some(Duration::from_secs_f64(
            self.layout.total_frames() as f64 / self.layout.sample_rate as f64,
        ))
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        let frame = self.layout.seek_frame(pos.as_secs_f64());
        self.reader
            .seek(SeekFrom::Start(self.layout.frame_byte(frame)))
            .map_err(|e| rodio::source::SeekError::Other(Box::new(e)))?;
        self.emitted = frame * self.layout.channels as u64;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    // Minimal WAV builder: 44-byte canonical header + data.
    fn wav_bytes(tag: u16, bits: u16, channels: u16, rate: u32, data: &[u8]) -> Vec<u8> {
        let block = channels * bits / 8;
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        v.extend_from_slice(b"WAVE");
        v.extend_from_slice(b"fmt ");
        v.extend_from_slice(&16u32.to_le_bytes());
        v.extend_from_slice(&tag.to_le_bytes());
        v.extend_from_slice(&channels.to_le_bytes());
        v.extend_from_slice(&rate.to_le_bytes());
        v.extend_from_slice(&(rate * block as u32).to_le_bytes());
        v.extend_from_slice(&block.to_le_bytes());
        v.extend_from_slice(&bits.to_le_bytes());
        v.extend_from_slice(b"data");
        v.extend_from_slice(&(data.len() as u32).to_le_bytes());
        v.extend_from_slice(data);
        v
    }

    #[test]
    fn parses_s24_header() {
        let data = vec![0u8; 6 * 4]; // 4 stereo s24 frames
        let bytes = wav_bytes(1, 24, 2, 48_000, &data);
        let l = parse_wav_header(&mut Cursor::new(bytes)).unwrap();
        assert_eq!(l.kind, SampleKind::I24);
        assert_eq!(l.channels, 2);
        assert_eq!(l.sample_rate, 48_000);
        assert_eq!(l.block_align, 6);
        assert_eq!(l.data_start, 44);
        assert_eq!(l.data_len, 24);
        assert_eq!(l.total_frames(), 4);
    }

    #[test]
    fn parses_float_header_and_skips_extra_chunk() {
        // A LIST chunk between fmt and data must be skipped (odd size padded).
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&0u32.to_le_bytes());
        v.extend_from_slice(b"WAVE");
        v.extend_from_slice(b"fmt ");
        v.extend_from_slice(&16u32.to_le_bytes());
        v.extend_from_slice(&3u16.to_le_bytes()); // IEEE float
        v.extend_from_slice(&1u16.to_le_bytes());
        v.extend_from_slice(&44_100u32.to_le_bytes());
        v.extend_from_slice(&(44_100u32 * 4).to_le_bytes());
        v.extend_from_slice(&4u16.to_le_bytes());
        v.extend_from_slice(&32u16.to_le_bytes());
        v.extend_from_slice(b"LIST");
        v.extend_from_slice(&3u32.to_le_bytes());
        v.extend_from_slice(&[1, 2, 3, 0]); // 3 bytes + pad
        v.extend_from_slice(b"data");
        v.extend_from_slice(&8u32.to_le_bytes());
        v.extend_from_slice(&1.0f32.to_le_bytes());
        v.extend_from_slice(&(-0.5f32).to_le_bytes());
        let l = parse_wav_header(&mut Cursor::new(v)).unwrap();
        assert_eq!(l.kind, SampleKind::F32);
        assert_eq!(l.total_frames(), 2);
    }

    #[test]
    fn parses_extensible_pcm_subformat() {
        let mut fmt = Vec::new();
        fmt.extend_from_slice(&0xFFFEu16.to_le_bytes());
        fmt.extend_from_slice(&2u16.to_le_bytes());
        fmt.extend_from_slice(&96_000u32.to_le_bytes());
        fmt.extend_from_slice(&(96_000u32 * 6).to_le_bytes());
        fmt.extend_from_slice(&6u16.to_le_bytes());
        fmt.extend_from_slice(&24u16.to_le_bytes());
        fmt.extend_from_slice(&22u16.to_le_bytes()); // cbSize
        fmt.extend_from_slice(&24u16.to_le_bytes()); // valid bits
        fmt.extend_from_slice(&3u32.to_le_bytes()); // channel mask
        fmt.extend_from_slice(&1u16.to_le_bytes()); // SubFormat: PCM
        fmt.extend_from_slice(&[0u8; 14]); // rest of the GUID
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&0u32.to_le_bytes());
        v.extend_from_slice(b"WAVE");
        v.extend_from_slice(b"fmt ");
        v.extend_from_slice(&(fmt.len() as u32).to_le_bytes());
        v.extend_from_slice(&fmt);
        v.extend_from_slice(b"data");
        v.extend_from_slice(&6u32.to_le_bytes());
        v.extend_from_slice(&[0u8; 6]);
        let l = parse_wav_header(&mut Cursor::new(v)).unwrap();
        assert_eq!(l.kind, SampleKind::I24);
        assert_eq!(l.sample_rate, 96_000);
        assert_eq!(l.channels, 2);
    }

    #[test]
    fn rejects_compressed_wav() {
        let bytes = wav_bytes(2, 4, 2, 22_050, &[0u8; 8]); // ADPCM
        assert!(parse_wav_header(&mut Cursor::new(bytes)).is_err());
    }

    #[test]
    fn s24_conversion_edges() {
        assert_eq!(s24_to_f32(0, 0, 0), 0.0);
        assert!((s24_to_f32(0xFF, 0xFF, 0x7F) - (8_388_607.0 / 8_388_608.0)).abs() < 1e-9);
        assert_eq!(s24_to_f32(0, 0, 0x80), -1.0);
        // -1 (all bits set) is the smallest step below zero.
        assert!((s24_to_f32(0xFF, 0xFF, 0xFF) + 1.0 / 8_388_608.0).abs() < 1e-9);
    }

    #[test]
    fn seek_math_is_frame_aligned_and_clamped() {
        let l = WavLayout {
            channels: 2,
            sample_rate: 48_000,
            kind: SampleKind::I24,
            bytes_per_sample: 3,
            block_align: 6,
            data_start: 44,
            data_len: 6 * 480_000, // 10 seconds
        };
        assert_eq!(l.seek_frame(1.0), 48_000);
        assert_eq!(l.frame_byte(l.seek_frame(1.0)), 44 + 48_000 * 6);
        assert_eq!(l.seek_frame(-5.0), 0);
        assert_eq!(l.seek_frame(99.0), l.total_frames()); // clamped to end
    }

    #[test]
    fn streams_and_seeks_f32_data() {
        use rodio::Source;
        // 4 mono float frames: 0.0, 0.25, 0.5, 0.75.
        let mut data = Vec::new();
        for i in 0..4 {
            data.extend_from_slice(&(i as f32 * 0.25).to_le_bytes());
        }
        let bytes = wav_bytes(3, 32, 1, 4, &data); // 4 Hz: 1 frame per 0.25s
        let mut src = WavF32Source::from_reader(Cursor::new(bytes)).unwrap();
        assert_eq!(src.next(), Some(0.0));
        assert_eq!(src.next(), Some(0.25));
        src.try_seek(Duration::from_secs_f64(0.75)).unwrap();
        assert_eq!(src.next(), Some(0.75));
        assert_eq!(src.next(), None); // data chunk end, exactly
        src.try_seek(Duration::from_secs_f64(0.25)).unwrap();
        assert_eq!(src.next(), Some(0.25));
    }
}
