use crate::storage::models::{
    AppDataSnapshot, ChatConversationRecord, ModelSettingsRecord, ProjectRecord,
};
use crate::storage::{
    chat_repository, config_repository, project_repository, storage_error, StorageState,
};
use tauri::State;

#[tauri::command]
pub fn load_app_data(state: State<'_, StorageState>) -> Result<AppDataSnapshot, String> {
    let connection = state.connection()?;

    Ok(AppDataSnapshot {
        model_settings: config_repository::load_model_settings(&connection)
            .map_err(storage_error)?,
        projects: project_repository::list_projects(&connection).map_err(storage_error)?,
        conversations: chat_repository::list_conversations(&connection).map_err(storage_error)?,
    })
}

#[tauri::command]
pub fn load_model_settings(
    state: State<'_, StorageState>,
) -> Result<Option<ModelSettingsRecord>, String> {
    let connection = state.connection()?;
    config_repository::load_model_settings(&connection).map_err(storage_error)
}

#[tauri::command]
pub fn save_model_settings(
    state: State<'_, StorageState>,
    settings: ModelSettingsRecord,
) -> Result<(), String> {
    let mut connection = state.connection()?;
    config_repository::save_model_settings(&mut connection, settings).map_err(storage_error)
}

#[tauri::command]
pub fn load_projects(state: State<'_, StorageState>) -> Result<Vec<ProjectRecord>, String> {
    let connection = state.connection()?;
    project_repository::list_projects(&connection).map_err(storage_error)
}

#[tauri::command]
pub fn save_project(
    state: State<'_, StorageState>,
    project: ProjectRecord,
) -> Result<ProjectRecord, String> {
    let connection = state.connection()?;
    project_repository::save_project(&connection, project.clone()).map_err(storage_error)?;
    Ok(project)
}

#[tauri::command]
pub fn delete_project(state: State<'_, StorageState>, project_id: String) -> Result<(), String> {
    let connection = state.connection()?;
    project_repository::delete_project(&connection, &project_id).map_err(storage_error)
}

#[tauri::command]
pub fn load_conversations(
    state: State<'_, StorageState>,
) -> Result<Vec<ChatConversationRecord>, String> {
    let connection = state.connection()?;
    chat_repository::list_conversations(&connection).map_err(storage_error)
}

#[tauri::command]
pub fn save_conversation(
    state: State<'_, StorageState>,
    conversation: ChatConversationRecord,
) -> Result<ChatConversationRecord, String> {
    let mut connection = state.connection()?;
    chat_repository::save_conversation(&mut connection, conversation.clone())
        .map_err(storage_error)?;
    Ok(conversation)
}
