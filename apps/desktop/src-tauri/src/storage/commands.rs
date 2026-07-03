use crate::storage::models::{
    AppDataSnapshot, AttachmentRecord, ChatConversationMetaRecord, ChatConversationRecord,
    ChatMessageAttachmentRecord, ChatMessageRecord, ChatMessageStateRecord, ComposerDraftRecord,
    ModelSettingsRecord, ProjectRecord, UiPreferencesRecord,
};
use crate::storage::{
    attachment_repository, chat_repository, composer_draft_repository, config_repository, now_ms,
    preferences_repository, project_repository, storage_error, StorageState,
};
use base64::Engine;
use rusqlite::Connection;
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager, State};

#[tauri::command]
pub fn load_app_data(
    state: State<'_, StorageState>,
    app_handle: AppHandle,
) -> Result<AppDataSnapshot, String> {
    let connection = state.connection()?;
    let attachment_root = attachment_root(&app_handle)?;
    let mut conversations = chat_repository::list_conversations(&connection).map_err(storage_error)?;
    attach_message_attachments(&connection, &attachment_root, &mut conversations)?;

    Ok(AppDataSnapshot {
        model_settings: config_repository::load_model_settings(&connection)
            .map_err(storage_error)?,
        projects: project_repository::list_projects(&connection).map_err(storage_error)?,
        conversations,
        composer_drafts: composer_draft_repository::list_composer_drafts(&connection)
            .map_err(storage_error)?,
        ui_preferences: preferences_repository::load_ui_preferences(&connection)
            .map_err(storage_error)?,
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
    app_handle: AppHandle,
) -> Result<Vec<ChatConversationRecord>, String> {
    let connection = state.connection()?;
    let attachment_root = attachment_root(&app_handle)?;
    let mut conversations = chat_repository::list_conversations(&connection).map_err(storage_error)?;
    attach_message_attachments(&connection, &attachment_root, &mut conversations)?;
    Ok(conversations)
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
pub fn save_conversation_meta(
    state: State<'_, StorageState>,
    conversation: ChatConversationMetaRecord,
) -> Result<ChatConversationMetaRecord, String> {
    let connection = state.connection()?;
    chat_repository::save_conversation_meta(&connection, &conversation)
        .map_err(storage_error)?;
    Ok(conversation)
}

#[tauri::command]
pub fn upsert_chat_messages(
    state: State<'_, StorageState>,
    conversation_id: String,
    messages: Vec<ChatMessageRecord>,
    position_offset: i64,
) -> Result<Vec<ChatMessageRecord>, String> {
    let mut connection = state.connection()?;
    chat_repository::upsert_messages(&mut connection, &conversation_id, &messages, position_offset)
        .map_err(storage_error)?;
    Ok(messages)
}

#[tauri::command]
pub fn delete_conversation(
    state: State<'_, StorageState>,
    conversation_id: String,
) -> Result<(), String> {
    let connection = state.connection()?;
    chat_repository::delete_conversation(&connection, &conversation_id).map_err(storage_error)
}

#[tauri::command]
pub fn save_chat_message_state(
    state: State<'_, StorageState>,
    conversation_id: String,
    message: ChatMessageStateRecord,
) -> Result<(), String> {
    let connection = state.connection()?;
    chat_repository::update_message_state(&connection, &conversation_id, &message)
        .map_err(storage_error)
}

#[tauri::command]
pub fn load_composer_drafts(
    state: State<'_, StorageState>,
) -> Result<Vec<ComposerDraftRecord>, String> {
    let connection = state.connection()?;
    composer_draft_repository::list_composer_drafts(&connection).map_err(storage_error)
}

#[tauri::command]
pub fn save_composer_draft(
    state: State<'_, StorageState>,
    draft: ComposerDraftRecord,
) -> Result<ComposerDraftRecord, String> {
    let connection = state.connection()?;
    composer_draft_repository::save_composer_draft(&connection, draft.clone())
        .map_err(storage_error)?;
    Ok(draft)
}

#[tauri::command]
pub fn delete_composer_draft(
    state: State<'_, StorageState>,
    scope_id: String,
) -> Result<(), String> {
    let connection = state.connection()?;
    composer_draft_repository::delete_composer_draft(&connection, &scope_id).map_err(storage_error)
}

#[tauri::command]
pub fn load_ui_preferences(state: State<'_, StorageState>) -> Result<UiPreferencesRecord, String> {
    let connection = state.connection()?;
    preferences_repository::load_ui_preferences(&connection).map_err(storage_error)
}

#[tauri::command]
pub fn save_ui_preferences(
    state: State<'_, StorageState>,
    preferences: UiPreferencesRecord,
) -> Result<UiPreferencesRecord, String> {
    let connection = state.connection()?;
    preferences_repository::save_ui_preferences(&connection, preferences).map_err(storage_error)
}

fn attachment_root(app_handle: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_handle
        .path()
        .app_data_dir()
        .map_err(|error| format!("获取应用数据目录失败：{error}"))?
        .join("attachments"))
}

fn attach_message_attachments(
    connection: &Connection,
    attachment_root: &Path,
    conversations: &mut [ChatConversationRecord],
) -> Result<(), String> {
    for conversation in conversations {
        let attachments = attachment_repository::list_conversation_attachments(
            connection,
            &conversation.id,
        )
        .map_err(storage_error)?;
        if attachments.is_empty() {
            continue;
        }

        let mut attachments_by_message_id: HashMap<String, Vec<ChatMessageAttachmentRecord>> =
            HashMap::new();
        for attachment in attachments {
            attachments_by_message_id
                .entry(attachment.message_id.clone())
                .or_default()
                .push(chat_message_attachment_record(attachment_root, attachment));
        }

        for message in &mut conversation.messages {
            if let Some(attachments) = attachments_by_message_id.remove(&message.id) {
                message.attachments = attachments;
            }
        }
    }

    Ok(())
}

fn chat_message_attachment_record(
    attachment_root: &Path,
    attachment: AttachmentRecord,
) -> ChatMessageAttachmentRecord {
    let preview_mime_type = image_preview_mime_type(&attachment);
    let preview_data = preview_mime_type
        .as_ref()
        .and_then(|_| read_attachment_preview_data(attachment_root, &attachment));

    ChatMessageAttachmentRecord {
        id: attachment.id,
        kind: attachment.kind,
        name: attachment.original_name,
        mime_type: attachment.mime_type,
        size_bytes: attachment.size_bytes,
        preview_data,
        preview_mime_type,
        created_at: attachment.created_at,
    }
}

fn image_preview_mime_type(attachment: &AttachmentRecord) -> Option<String> {
    if attachment.kind != "image" {
        return None;
    }

    attachment
        .mime_type
        .as_deref()
        .filter(|mime_type| mime_type.starts_with("image/"))
        .map(ToString::to_string)
}

fn read_attachment_preview_data(
    attachment_root: &Path,
    attachment: &AttachmentRecord,
) -> Option<String> {
    let storage_path = safe_attachment_storage_path(attachment_root, &attachment.storage_rel_path)?;
    let bytes = fs::read(storage_path).ok()?;
    Some(base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn safe_attachment_storage_path(attachment_root: &Path, storage_rel_path: &str) -> Option<PathBuf> {
    let relative_path = Path::new(storage_rel_path);
    if relative_path.is_absolute() {
        return None;
    }
    if relative_path
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return None;
    }

    Some(attachment_root.join(relative_path))
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
