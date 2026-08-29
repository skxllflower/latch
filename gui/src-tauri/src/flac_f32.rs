// Depth-preserving FLAC audition source. rodio's Decoder buffers every
// format into `SampleBuffer<i16>` (rodio 0.20.1 decoder/symphonia.rs:31),
// so a 24-bit FLAC loses 8 bits at the decoder boundary. This drives the
// SAME symphonia crate rodio already pins (Cargo.lock: symphonia 0.5.5)
// directly, buffering into `SampleBuffer<f32>` instead — a mirror of
// rodio's SymphoniaDecoder (packet loop, decode-retry policy, accurate
// seek + sample-refine) with the i16 bottleneck removed. Streaming:
// symphonia reads packets through MediaSourceStream over the File; the
// track is never whole-file-decoded into RAM. Only >16-bit FLAC routes
// here (see audio_decode::native_route) — 16-bit FLAC is transparent
// through rodio's i16 path already.

use std::time::Duration;

use symphonia::{
    core::{
        audio::{AudioBufferRef, SampleBuffer, SignalSpec},
        codecs::{Decoder, DecoderOptions, CODEC_TYPE_NULL},
        errors::Error,
        formats::{FormatOptions, FormatReader, SeekMode, SeekTo, SeekedTo},
        io::MediaSourceStream,
        meta::MetadataOptions,
        probe::Hint,
        units::{self, Time},
    },
    default::get_probe,
};

// Same policy as rodio's SymphoniaDecoder: a decode error is not fatal
// unless it repeats across this many consecutive packets.
const MAX_DECODE_RETRIES: usize = 3;

pub struct FlacF32Source {
    decoder: Box<dyn Decoder>,
    format: Box<dyn FormatReader>,
    buffer: SampleBuffer<f32>,
    current_frame_offset: usize,
    spec: SignalSpec,
    total_duration: Option<Time>,
}

fn err_str(what: &str, e: impl std::fmt::Display) -> String {
    format!("flac {what}: {e}")
}

fn seek_err(e: impl std::fmt::Display) -> rodio::source::SeekError {
    rodio::source::SeekError::Other(Box::new(std::io::Error::new(
        std::io::ErrorKind::Other,
        format!("flac seek: {e}"),
    )))
}

impl FlacF32Source {
    pub fn open(path: &str) -> Result<Self, String> {
        let file = std::fs::File::open(path).map_err(|e| err_str("open", e))?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());
        let mut hint = Hint::new();
        hint.with_extension("flac");
        let format_opts = FormatOptions { enable_gapless: true, ..Default::default() };
        let metadata_opts: MetadataOptions = Default::default();
        let probed = get_probe()
            .format(&hint, mss, &format_opts, &metadata_opts)
            .map_err(|e| err_str("probe", e))?;
        let mut format = probed.format;

        let track = format
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or("flac: no decodable track")?;
        let track_id = track.id;
        let total_duration = track
            .codec_params
            .time_base
            .zip(track.codec_params.n_frames)
            .map(|(base, frames)| base.calc_time(frames));
        let mut decoder = symphonia::default::get_codecs()
            .make(&track.codec_params, &DecoderOptions::default())
            .map_err(|e| err_str("decoder", e))?;

        // Decode the first packet so channel/rate are known up front.
        let mut decode_errors = 0usize;
        let decoded = loop {
            let packet = match format.next_packet() {
                Ok(p) => p,
                Err(Error::IoError(_)) => break decoder.last_decoded(),
                Err(e) => return Err(err_str("first packet", e)),
            };
            if packet.track_id() != track_id {
                continue;
            }
            match decoder.decode(&packet) {
                Ok(d) => break d,
                Err(Error::DecodeError(e)) => {
                    decode_errors += 1;
                    if decode_errors > MAX_DECODE_RETRIES {
                        return Err(err_str("decode", e));
                    }
                }
                Err(e) => return Err(err_str("decode", e)),
            }
        };
        let spec = decoded.spec().to_owned();
        let buffer = Self::get_buffer(decoded, &spec);
        Ok(FlacF32Source {
            decoder,
            format,
            buffer,
            current_frame_offset: 0,
            spec,
            total_duration,
        })
    }

    fn get_buffer(decoded: AudioBufferRef, spec: &SignalSpec) -> SampleBuffer<f32> {
        let duration = units::Duration::from(decoded.capacity() as u64);
        let mut buffer = SampleBuffer::<f32>::new(duration, *spec);
        buffer.copy_interleaved_ref(decoded);
        buffer
    }

    // Post-seek refinement (mirror of rodio's refine_position): the format
    // seek lands on the frame BEFORE the target, so decode forward and skip
    // the sample gap — loop wraps land sample-exact, not frame-coarse.
    fn refine_position(&mut self, seek_res: SeekedTo) -> Result<(), rodio::source::SeekError> {
        let mut samples_to_pass = seek_res.required_ts - seek_res.actual_ts;
        let packet = loop {
            let candidate = self.format.next_packet().map_err(seek_err)?;
            if candidate.dur() > samples_to_pass {
                break candidate;
            }
            samples_to_pass -= candidate.dur();
        };
        let mut decoded = self.decoder.decode(&packet);
        for _ in 0..MAX_DECODE_RETRIES {
            if decoded.is_err() {
                let packet = self.format.next_packet().map_err(seek_err)?;
                decoded = self.decoder.decode(&packet);
            }
        }
        let decoded = decoded.map_err(seek_err)?;
        decoded.spec().clone_into(&mut self.spec);
        self.buffer = Self::get_buffer(decoded, &self.spec);
        self.current_frame_offset = samples_to_pass as usize * self.spec.channels.count();
        Ok(())
    }
}

impl Iterator for FlacF32Source {
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        if self.current_frame_offset >= self.buffer.len() {
            let packet = self.format.next_packet().ok()?;
            let mut decoded = self.decoder.decode(&packet);
            for _ in 0..MAX_DECODE_RETRIES {
                if decoded.is_err() {
                    let packet = self.format.next_packet().ok()?;
                    decoded = self.decoder.decode(&packet);
                }
            }
            let decoded = decoded.ok()?;
            decoded.spec().clone_into(&mut self.spec);
            self.buffer = Self::get_buffer(decoded, &self.spec);
            self.current_frame_offset = 0;
        }
        let sample = *self.buffer.samples().get(self.current_frame_offset)?;
        self.current_frame_offset += 1;
        Some(sample)
    }
}

impl rodio::Source for FlacF32Source {
    #[inline]
    fn current_frame_len(&self) -> Option<usize> {
        Some(self.buffer.samples().len())
    }

    #[inline]
    fn channels(&self) -> u16 {
        self.spec.channels.count() as u16
    }

    #[inline]
    fn sample_rate(&self) -> u32 {
        self.spec.rate
    }

    #[inline]
    fn total_duration(&self) -> Option<Duration> {
        self.total_duration
            .map(|Time { seconds, frac }| Duration::from_secs_f64(seconds as f64 + frac))
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        // Seeking right at/past the end: back off a hair so the format
        // reader still has a frame to land on (rodio does the same).
        let mut target = pos.as_secs_f64();
        if let Some(total) = self.total_duration() {
            let cap = (total.as_secs_f64() - 0.0001).max(0.0);
            if target > cap {
                target = cap;
            }
        }
        // Keep the next sample on the same channel lane after the seek.
        let to_skip = self.current_frame_offset % self.channels().max(1) as usize;
        let seek_res = self
            .format
            .seek(SeekMode::Accurate, SeekTo::Time { time: target.into(), track_id: None })
            .map_err(seek_err)?;
        self.refine_position(seek_res)?;
        self.current_frame_offset += to_skip;
        Ok(())
    }
}
