use std::path::Path;
#[cfg(target_os = "macos")]
use std::sync::mpsc;

use crate::models::{CaptureSource, LectureSession};

#[cfg(target_os = "macos")]
use screencapturekit::{
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
    pub async fn start(session: &LectureSession) -> Result<StartedSystemAudioCapture, String> {
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

        let stream = SCStream::new(&filter, &stream_config);
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
