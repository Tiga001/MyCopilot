mod commands;
mod storage;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            let database_path = app_data_dir.join("mycopilot.sqlite3");
            let storage = storage::StorageState::open(&database_path)?;
            app.manage(storage);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::agent::agent_send_chat,
            storage::commands::load_app_data,
            storage::commands::load_model_settings,
            storage::commands::save_model_settings,
            storage::commands::load_projects,
            storage::commands::save_project,
            storage::commands::delete_project,
            storage::commands::load_conversations,
            storage::commands::save_conversation,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MyCopilot");
}
