mod agent_actions;
mod commands;
mod fs;
mod git;
mod process;
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
            app.manage(agent_actions::AgentActionState::default());
            app.manage(process::command_runner::CommandRunState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::agent::agent_start_conversation_turn,
            commands::agent_attachments::select_agent_input_attachments,
            commands::agent_actions::agent_list_pending_actions,
            commands::agent_actions::agent_approve_action,
            commands::agent_actions::agent_reject_action,
            commands::agent_actions::agent_cancel_action,
            storage::commands::load_app_data,
            storage::commands::load_model_settings,
            storage::commands::save_model_settings,
            storage::commands::load_projects,
            storage::commands::select_project_directory,
            storage::commands::save_project,
            storage::commands::delete_project,
            storage::commands::show_project_in_folder,
            storage::commands::load_conversations,
            storage::commands::save_conversation,
            storage::commands::delete_conversation,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MyCopilot");
}
