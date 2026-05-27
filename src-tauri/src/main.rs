#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod models;
mod state;
mod storage;
mod system_audio;

use state::{
    AudioMeterState, ModelDownloadState, SessionState, SessionStorageSizeState,
    SystemAudioCaptureState, TranscriptionTaskState,
};
use tauri::Manager;

#[cfg(target_os = "macos")]
fn configure_macos_window_chrome(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use objc2_app_kit::{NSColor, NSWindow};

    if let Some(window) = app.get_webview_window("main") {
        window.set_title_bar_style(tauri::TitleBarStyle::Transparent)?;
        let ns_window = window.ns_window()? as *mut NSWindow;
        unsafe {
            let background = NSColor::colorWithDeviceRed_green_blue_alpha(0.0, 0.0, 0.0, 1.0);
            ns_window
                .as_ref()
                .ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::Other,
                        "Failed to access the macOS NSWindow.",
                    )
                })?
                .setBackgroundColor(Some(&background));
        }
    }

    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn configure_macos_window_chrome(_app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            configure_macos_window_chrome(app)?;

            let mut sessions = storage::load_sessions(app.handle())?;
            if storage::prepare_sessions_on_startup(app.handle(), &mut sessions)? {
                storage::persist_sessions(app.handle(), &sessions)?;
            }
            app.manage(SessionState::new(sessions));
            app.manage(SystemAudioCaptureState::default());
            app.manage(AudioMeterState::default());
            app.manage(SessionStorageSizeState::default());
            app.manage(TranscriptionTaskState::default());
            app.manage(ModelDownloadState::default());

            let processing_sessions = app
                .state::<SessionState>()
                .clone_sessions()
                .unwrap_or_default()
                .into_iter()
                .filter(|session| {
                    session.status == models::SessionStatus::Processing
                        && !session.audio_file_paths.is_empty()
                })
                .collect::<Vec<_>>();
            for session in processing_sessions {
                let session_id = session.id.clone();
                let task = app
                    .state::<TranscriptionTaskState>()
                    .start_final_task(
                        &session_id,
                        format!("Resume transcription: {}", session.title),
                    )
                    .unwrap_or(None);
                if let Some(task) = task {
                    let settings = session.processing_settings.clone().unwrap_or_else(|| {
                        storage::load_processing_settings(app.handle()).unwrap_or_default()
                    });
                    commands::session_commands::spawn_final_transcription_job(
                        app.handle(),
                        &session_id,
                        session,
                        settings,
                        task,
                    );
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::session_commands::create_session,
            commands::session_commands::import_media_session,
            commands::session_commands::list_sessions,
            commands::session_commands::list_session_summaries,
            commands::session_commands::get_session,
            commands::session_commands::update_session_title,
            commands::session_commands::get_platform_capabilities,
            commands::session_commands::get_runtime_status,
            commands::session_commands::list_resources,
            commands::session_commands::delete_session,
            commands::session_commands::delete_resource,
            commands::session_commands::cleanup_session_intermediates,
            commands::session_commands::reveal_resource,
            commands::session_commands::list_background_tasks,
            commands::session_commands::cancel_background_task,
            commands::session_commands::retry_session_processing,
            commands::session_commands::get_processing_settings,
            commands::session_commands::patch_processing_settings,
            commands::session_commands::list_transcription_models,
            commands::session_commands::list_available_transcription_models,
            commands::session_commands::download_transcription_model,
            commands::session_commands::prepare_transcription_runtime,
            commands::session_commands::delete_transcription_model,
            commands::session_commands::append_segment,
            commands::session_commands::begin_audio_segment,
            commands::session_commands::append_audio_chunk,
            commands::session_commands::finish_audio_segment,
            commands::session_commands::initialize_live_preview,
            commands::session_commands::append_live_preview_chunk,
            commands::session_commands::queue_live_transcript_refresh,
            commands::session_commands::set_session_status,
            commands::session_commands::start_session_recording,
            commands::session_commands::pause_session_recording,
            commands::session_commands::resume_session_recording,
            commands::session_commands::stop_session_recording,
            commands::session_commands::polish_session_transcript,
            commands::session_commands::save_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running Leclog");
}
