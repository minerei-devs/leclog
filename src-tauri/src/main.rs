#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod models;
mod state;
mod storage;
mod system_audio;

use state::{SessionState, SystemAudioCaptureState};
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            let mut sessions = storage::load_sessions(app.handle())?;
            if storage::prepare_sessions_on_startup(app.handle(), &mut sessions)? {
                storage::persist_sessions(app.handle(), &sessions)?;
            }
            app.manage(SessionState::new(sessions));
            app.manage(SystemAudioCaptureState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::session_commands::create_session,
            commands::session_commands::list_sessions,
            commands::session_commands::get_session,
            commands::session_commands::append_segment,
            commands::session_commands::begin_audio_segment,
            commands::session_commands::append_audio_chunk,
            commands::session_commands::finish_audio_segment,
            commands::session_commands::initialize_live_preview,
            commands::session_commands::append_live_preview_chunk,
            commands::session_commands::refresh_live_transcript,
            commands::session_commands::set_session_status,
            commands::session_commands::start_session_recording,
            commands::session_commands::pause_session_recording,
            commands::session_commands::resume_session_recording,
            commands::session_commands::stop_session_recording,
            commands::session_commands::save_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running Leclog");
}
