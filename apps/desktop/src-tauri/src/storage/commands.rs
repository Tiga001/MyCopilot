use crate::storage::models::{
    AppDataSnapshot, ChatConversationRecord, ModelSettingsRecord, ProjectRecord,
};
use crate::storage::{
    chat_repository, config_repository, now_ms, project_repository, storage_error, StorageState,
};
use std::process::Command;
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
pub fn select_project_directory(
    state: State<'_, StorageState>,
) -> Result<Option<ProjectRecord>, String> {
    let Some(selected_path) = rfd::FileDialog::new().pick_folder() else {
        return Ok(None);
    };

    let canonical_path = selected_path
        .canonicalize()
        .map_err(|error| format!("workspace 路径不可访问：{error}"))?;
    if !canonical_path.is_dir() {
        return Err("workspace 路径不是目录。".to_string());
    }

    let path = canonical_path.to_string_lossy().to_string();
    let connection = state.connection()?;
    if let Some(existing_project) =
        project_repository::get_project_by_path(&connection, &path).map_err(storage_error)?
    {
        return Ok(Some(existing_project));
    }

    let name = canonical_path
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("Workspace")
        .to_string();
    let project = ProjectRecord {
        id: create_project_id(&name),
        name,
        path: Some(path),
        created_at: now_ms(),
        pinned_at: None,
    };

    project_repository::save_project(&connection, project.clone()).map_err(storage_error)?;
    Ok(Some(project))
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
pub fn show_project_in_folder(
    state: State<'_, StorageState>,
    project_id: String,
) -> Result<(), String> {
    let connection = state.connection()?;
    let project = project_repository::get_project(&connection, &project_id)
        .map_err(storage_error)?
        .ok_or_else(|| "项目不存在。".to_string())?;
    let path = project
        .path
        .ok_or_else(|| "该项目没有本地路径。".to_string())?;

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|error| format!("无法在文件夹中显示项目：{error}"))?;
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(|error| format!("无法在文件管理器中显示项目：{error}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|error| format!("无法在文件管理器中显示项目：{error}"))?;
    }

    Ok(())
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

#[tauri::command]
pub fn delete_conversation(
    state: State<'_, StorageState>,
    conversation_id: String,
) -> Result<(), String> {
    let connection = state.connection()?;
    chat_repository::delete_conversation(&connection, &conversation_id).map_err(storage_error)
}

fn create_project_id(name: &str) -> String {
    let mut normalized = String::new();
    let mut previous_was_separator = false;

    for character in name.trim().to_lowercase().chars() {
        let is_allowed =
            character.is_ascii_alphanumeric() || ('\u{4e00}'..='\u{9fa5}').contains(&character);

        if is_allowed {
            normalized.push(character);
            previous_was_separator = false;
        } else if !previous_was_separator && !normalized.is_empty() {
            normalized.push('-');
            previous_was_separator = true;
        }
    }

    while normalized.ends_with('-') {
        normalized.pop();
    }

    if normalized.is_empty() {
        normalized.push_str("local");
    }

    format!("project-{normalized}-{}", now_ms())
}
