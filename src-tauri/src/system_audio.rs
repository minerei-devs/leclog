use std::path::Path;
#[cfg(target_os = "macos")]
use std::sync::mpsc;

use crate::models::{CaptureSource, LectureSession};
#[cfg(target_os = "macos")]
use crate::storage;
#[cfg(target_os = "macos")]
use crate::state::AudioMeterState;
#[cfg(target_os = "macos")]
use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
use screencapturekit::{
    cm::CMSampleBuffer,
    content_sharing_picker::{
        SCContentSharingPicker, SCContentSharingPickerConfiguration,
        SCContentSharingPickerMode, SCPickedSource, SCPickerOutcome,
    },
    recording_output::{
        SCRecordingOutput, SCRecordingOutputCodec, SCRecordingOutputConfiguration,
        SCRecordingOutputFileType,
    },
    stream::{
        configuration::{
            audio::{AudioChannelCount, AudioSampleRate},
            SCStreamConfiguration,
        },
        output_type::SCStreamOutputType,
        sc_stream::SCStream,
    },
};

#[cfg(target_os = "macos")]
use screencapturekit::stream::content_filter::SCShareableContentStyle;

pub struct StartedSystemAudioCapture {
    pub capture: SystemAudioCapture,
    pub target_label: String,
}

#[cfg(target_os = "macos")]
pub struct SystemAudioCapture {
    stream: SCStream,
    recording: SCRecordingOutput,
}

#[cfg(not(target_os = "macos"))]
pub struct SystemAudioCapture;

#[cfg(target_os = "macos")]
impl SystemAudioCapture {
    pub async fn start(
        app: &AppHandle,
        session: &LectureSession,
    ) -> Result<StartedSystemAudioCapture, String> {
        if session.capture_source != CaptureSource::SystemAudio {
            return Err(String::from(
                "System audio capture can only be started for system-audio sessions.",
            ));
        }

        let output_path = session
            .active_audio_file_path
            .as_deref()
            .ok_or_else(|| String::from("The session is missing an active capture file path."))?;

        let mut picker_config = SCContentSharingPickerConfiguration::new();
        picker_config.set_allowed_picker_modes(&[
            SCContentSharingPickerMode::SingleWindow,
            SCContentSharingPickerMode::SingleDisplay,
            SCContentSharingPickerMode::SingleApplication,
        ]);
        picker_config.set_allows_changing_selected_content(false);

        let (sender, receiver) = mpsc::channel();
        SCContentSharingPicker::show(&picker_config, move |outcome| {
            let _ = sender.send(outcome);
        });
        let outcome = receiver
            .recv()
            .map_err(|_| String::from("The macOS screen sharing picker closed unexpectedly."))?;
        let result = match outcome {
            SCPickerOutcome::Picked(result) => result,
            SCPickerOutcome::Cancelled => {
                return Err(String::from("System audio capture selection was cancelled."));
            }
            SCPickerOutcome::Error(error) => {
                return Err(format!(
                    "Failed to open the macOS screen sharing picker: {error}"
                ));
            }
        };

        let (width, height) = result.pixel_size();
        let target_label = describe_picker_source(&result.source(), result.filter().style());
        let filter = result.filter();
        let stream_config = SCStreamConfiguration::new()
            .with_width(width.max(1))
            .with_height(height.max(1))
            .with_captures_audio(true)
            .with_captures_microphone(false)
            .with_sample_rate(AudioSampleRate::Rate48000)
            .with_channel_count(AudioChannelCount::Stereo)
            .with_excludes_current_process_audio(true);

        let recording_config = SCRecordingOutputConfiguration::new()
            .with_output_url(Path::new(output_path))
            .with_output_file_type(SCRecordingOutputFileType::MP4)
            .with_video_codec(SCRecordingOutputCodec::H264);
        let recording = SCRecordingOutput::new(&recording_config).ok_or_else(|| {
            String::from("Failed to create the macOS recording output for system audio capture.")
        })?;

        let preview_path = session.live_preview_audio_path.clone();
        let preview_sample_rate = session.live_preview_sample_rate.unwrap_or(48_000);
        let app_handle = app.clone();
        let meter_session_id = session.id.clone();

        let mut stream = SCStream::new(&filter, &stream_config);
        if let Some(preview_path) = preview_path {
            let handler_id = stream.add_output_handler(
                move |sample: CMSampleBuffer, of_type: SCStreamOutputType| {
                    if of_type != SCStreamOutputType::Audio {
                        return;
                    }

                    let Some(chunk) = sample_buffer_to_pcm16_mono(&sample) else {
                        return;
                    };
                    let _ = app_handle
                        .state::<AudioMeterState>()
                        .set(&meter_session_id, calculate_pcm16_level(&chunk));
                    let _ = storage::append_live_preview_chunk_to_path(
                        Path::new(&preview_path),
                        preview_sample_rate,
                        &chunk,
                    );
                },
                SCStreamOutputType::Audio,
            );
            if handler_id.is_none() {
                return Err(String::from(
                    "Failed to attach the macOS system audio sample handler.",
                ));
            }
        }

        stream
            .add_recording_output(&recording)
            .map_err(|error| format!("Failed to attach the recording output: {error}"))?;
        if let Err(error) = stream.start_capture() {
            let _ = stream.remove_recording_output(&recording);
            return Err(format!("Failed to start macOS system audio capture: {error}"));
        }

        Ok(StartedSystemAudioCapture {
            capture: Self { stream, recording },
            target_label,
        })
    }

    pub fn stop(self) -> Result<(), String> {
        self.stream
            .stop_capture()
            .map_err(|error| format!("Failed to stop macOS system audio capture: {error}"))?;
        self.stream
            .remove_recording_output(&self.recording)
            .map_err(|error| format!("Failed to finalize the macOS recording output: {error}"))?;
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
impl SystemAudioCapture {
    pub async fn start(_session: &LectureSession) -> Result<StartedSystemAudioCapture, String> {
        Err(String::from(
            "System audio capture is only available on macOS in this build.",
        ))
    }

    pub fn stop(self) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn describe_picker_source(
    source: &SCPickedSource,
    style: SCShareableContentStyle,
) -> String {
    match source {
        SCPickedSource::Window(title) => format!("Window: {title}"),
        SCPickedSource::Display(id) => format!("Display {id}"),
        SCPickedSource::Application(name) => format!("Application: {name}"),
        SCPickedSource::Unknown => format!("{style} capture"),
    }
}

#[cfg(target_os = "macos")]
fn sample_buffer_to_pcm16_mono(sample: &CMSampleBuffer) -> Option<Vec<u8>> {
    if !sample.is_valid() || sample.num_samples() == 0 {
        return None;
    }

    let format = sample.format_description()?;
    if !format.is_audio() || !format.is_pcm() {
        return None;
    }

    let channel_count = format.audio_channel_count().unwrap_or(1).max(1) as usize;
    let frame_count = sample.num_samples();
    let buffers = sample.audio_buffer_list()?;
    let mut output = Vec::with_capacity(frame_count * 2);

    if buffers.num_buffers() == 1 {
        let buffer = buffers.get(0)?;
        let raw = buffer.data();
        let buffer_channels = buffer.number_channels.max(1) as usize;
        let bytes_per_sample = raw.len() / frame_count.max(1) / buffer_channels.max(1);

        match bytes_per_sample {
            2 => {
                for frame_index in 0..frame_count {
                    let mut mixed = 0f32;
                    for channel_index in 0..buffer_channels {
                        let start = (frame_index * buffer_channels + channel_index) * 2;
                        let sample = i16::from_le_bytes([raw[start], raw[start + 1]]) as f32
                            / i16::MAX as f32;
                        mixed += sample;
                    }
                    let mono = (mixed / buffer_channels as f32).clamp(-1.0, 1.0);
                    output.extend_from_slice(&float_to_i16_sample(mono).to_le_bytes());
                }
            }
            4 => {
                for frame_index in 0..frame_count {
                    let mut mixed = 0f32;
                    for channel_index in 0..buffer_channels {
                        let start = (frame_index * buffer_channels + channel_index) * 4;
                        let sample = f32::from_le_bytes([
                            raw[start],
                            raw[start + 1],
                            raw[start + 2],
                            raw[start + 3],
                        ]);
                        mixed += sample;
                    }
                    let mono = (mixed / buffer_channels as f32).clamp(-1.0, 1.0);
                    output.extend_from_slice(&float_to_i16_sample(mono).to_le_bytes());
                }
            }
            _ => return None,
        }

        return Some(output);
    }

    let bytes_per_sample = buffers.get(0)?.data().len() / frame_count.max(1);
    match bytes_per_sample {
        2 => {
            for frame_index in 0..frame_count {
                let mut mixed = 0f32;
                let mut seen_channels = 0usize;
                for buffer in &buffers {
                    let raw = buffer.data();
                    let start = frame_index * 2;
                    if start + 2 > raw.len() {
                        continue;
                    }
                    let sample =
                        i16::from_le_bytes([raw[start], raw[start + 1]]) as f32 / i16::MAX as f32;
                    mixed += sample;
                    seen_channels += 1;
                }
                if seen_channels == 0 {
                    continue;
                }
                let mono = (mixed / seen_channels as f32).clamp(-1.0, 1.0);
                output.extend_from_slice(&float_to_i16_sample(mono).to_le_bytes());
            }
        }
        4 => {
            for frame_index in 0..frame_count {
                let mut mixed = 0f32;
                let mut seen_channels = 0usize;
                for buffer in &buffers {
                    let raw = buffer.data();
                    let start = frame_index * 4;
                    if start + 4 > raw.len() {
                        continue;
                    }
                    let sample = f32::from_le_bytes([
                        raw[start],
                        raw[start + 1],
                        raw[start + 2],
                        raw[start + 3],
                    ]);
                    mixed += sample;
                    seen_channels += 1;
                }
                if seen_channels == 0 {
                    continue;
                }
                let mono = (mixed / seen_channels as f32).clamp(-1.0, 1.0);
                output.extend_from_slice(&float_to_i16_sample(mono).to_le_bytes());
            }
        }
        _ => return None,
    }

    if output.is_empty() || channel_count == 0 {
        None
    } else {
        Some(output)
    }
}

#[cfg(target_os = "macos")]
fn float_to_i16_sample(sample: f32) -> i16 {
    let scaled = (sample * i16::MAX as f32).round();
    scaled.clamp(i16::MIN as f32, i16::MAX as f32) as i16
}

#[cfg(target_os = "macos")]
fn calculate_pcm16_level(chunk: &[u8]) -> f32 {
    if chunk.len() < 2 {
        return 0.0;
    }

    let mut sum = 0.0f32;
    let mut count = 0usize;
    for bytes in chunk.chunks_exact(2) {
        let sample = i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / i16::MAX as f32;
        sum += sample * sample;
        count += 1;
    }

    if count == 0 {
        return 0.0;
    }

    (sum / count as f32).sqrt().clamp(0.0, 1.0)
}
