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
            let attachment_root = app_data_dir.join("attachments");
            {
                let connection = storage
                    .connection()
                    .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
                match storage::commands::run_orphan_attachment_cleanup_once(
                    &connection,
                    &attachment_root,
                ) {
                    Ok(Some(summary)) if summary.files_removed > 0 => {
                        eprintln!(
                            "Cleaned up {} orphan attachment files ({} bytes).",
                            summary.files_removed, summary.bytes_removed
                        );
                    }
                    Ok(_) => {}
                    Err(error) => {
                        eprintln!("Failed to clean up orphan attachment files: {error}");
                    }
                }
            }
            app.manage(storage);
            app.manage(agent_actions::AgentActionState::default());
            app.manage(commands::agent::AgentRunCancellationState::default());
            app.manage(process::command_runner::CommandRunState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::agent::agent_start_conversation_turn,
            commands::agent::agent_cancel_run,
            commands::agent_attachments::select_agent_input_attachments,
            commands::agent_actions::agent_list_pending_actions,
            commands::agent_actions::agent_approve_action,
            commands::agent_actions::agent_reject_action,
            commands::agent_actions::agent_cancel_action,
            commands::system::open_external_url,
            storage::commands::load_app_data,
            storage::commands::load_model_settings,
            storage::commands::save_model_settings,
            storage::commands::load_agent_prompt_preferences,
            storage::commands::save_agent_prompt_preferences,
            storage::commands::load_projects,
            storage::commands::select_project_directory,
            storage::commands::save_project,
            storage::commands::delete_project,
            storage::commands::show_project_in_folder,
            storage::commands::load_conversations,
            storage::commands::save_conversation,
            storage::commands::save_conversation_meta,
            storage::commands::upsert_chat_messages,
            storage::commands::save_chat_message_state,
            storage::commands::delete_conversation,
            storage::commands::load_composer_drafts,
            storage::commands::save_composer_draft,
            storage::commands::delete_composer_draft,
            storage::commands::load_ui_preferences,
            storage::commands::save_ui_preferences,
            storage::commands::select_profile_avatar,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MyCopilot");
}
