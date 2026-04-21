#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod models;
mod state;
mod storage;

use state::SessionState;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            let sessions = storage::load_sessions(app.handle())?;
            app.manage(SessionState::new(sessions));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::session_commands::create_session,
            commands::session_commands::list_sessions,
            commands::session_commands::get_session,
            commands::session_commands::append_segment,
            commands::session_commands::set_session_status,
            commands::session_commands::save_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running Leclog");
}
