use crate::fs::{canonical_workspace_root, clean_relative_path};
use crate::storage::models::{
    AgentPromptPreferencesRecord, AppDataSnapshot, AttachmentRecord, ChatConversationMetaRecord,
    ChatConversationRecord, ChatMessageAttachmentRecord, ChatMessageRecord, ChatMessageStateRecord,
    ComposerDraftRecord, ModelSettingsRecord, ProjectRecord, UiPreferencesRecord,
};
use crate::storage::{
    agent_prompt_preferences_repository, attachment_repository, chat_repository,
    composer_draft_repository, config_repository, now_ms, preferences_repository,
    project_repository, storage_error, StorageState,
};
use base64::Engine;
use rusqlite::{params, Connection};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager, State};

const ORPHAN_ATTACHMENT_CLEANUP_TASK_ID: &str = "orphan_attachment_cleanup_20260704";

#[derive(Debug, Default, PartialEq, Eq)]
pub struct AttachmentCleanupSummary {
    pub files_removed: usize,
    pub directories_removed: usize,
    pub bytes_removed: u64,
}

pub fn run_orphan_attachment_cleanup_once(
    connection: &Connection,
    attachment_root: &Path,
) -> Result<Option<AttachmentCleanupSummary>, String> {
    if maintenance_task_completed(connection, ORPHAN_ATTACHMENT_CLEANUP_TASK_ID)
        .map_err(storage_error)?
    {
        return Ok(None);
    }

    let summary = cleanup_orphan_attachment_files(connection, attachment_root)?;
    mark_maintenance_task_completed(connection, ORPHAN_ATTACHMENT_CLEANUP_TASK_ID)
        .map_err(storage_error)?;
    Ok(Some(summary))
}

#[tauri::command]
pub fn load_app_data(
    state: State<'_, StorageState>,
    app_handle: AppHandle,
) -> Result<AppDataSnapshot, String> {
    let connection = state.connection()?;
    let attachment_root = attachment_root(&app_handle)?;
    let mut conversations =
        chat_repository::list_conversations(&connection).map_err(storage_error)?;
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
        agent_prompt_preferences:
            agent_prompt_preferences_repository::load_agent_prompt_preferences(&connection)
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
pub fn load_agent_prompt_preferences(
    state: State<'_, StorageState>,
) -> Result<AgentPromptPreferencesRecord, String> {
    let connection = state.connection()?;
    agent_prompt_preferences_repository::load_agent_prompt_preferences(&connection)
        .map_err(storage_error)
}

#[tauri::command]
pub fn save_agent_prompt_preferences(
    state: State<'_, StorageState>,
    preferences: AgentPromptPreferencesRecord,
) -> Result<AgentPromptPreferencesRecord, String> {
    let connection = state.connection()?;
    agent_prompt_preferences_repository::save_agent_prompt_preferences(&connection, preferences)
        .map_err(storage_error)
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
pub fn delete_project(
    state: State<'_, StorageState>,
    app_handle: AppHandle,
    project_id: String,
) -> Result<(), String> {
    let attachment_root = attachment_root(&app_handle)?;
    let attachments = {
        let connection = state.connection()?;
        let attachments =
            attachment_repository::list_project_deletion_attachments(&connection, &project_id)
                .map_err(storage_error)?;
        project_repository::delete_project(&connection, &project_id).map_err(storage_error)?;
        attachments
    };

    cleanup_attachment_files(&attachment_root, attachments)
        .map_err(|error| format!("项目已删除，但清理附件文件失败：{error}"))
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
pub fn reveal_project_file(
    state: State<'_, StorageState>,
    project_id: Option<String>,
    file_path: String,
) -> Result<(), String> {
    let workspace_root = if let Some(project_id) = project_id {
        let connection = state.connection()?;
        let project = project_repository::get_project(&connection, &project_id)
            .map_err(storage_error)?
            .ok_or_else(|| "项目不存在。".to_string())?;
        let project_path = project
            .path
            .ok_or_else(|| "该项目没有本地路径。".to_string())?;
        Some(canonical_workspace_root(Path::new(&project_path))?)
    } else {
        None
    };
    let (target, select_target) =
        resolve_project_reveal_target(workspace_root.as_deref(), &file_path)?;

    reveal_in_file_manager(&target, select_target)
}

fn resolve_project_reveal_target(
    workspace_root: Option<&Path>,
    file_path: &str,
) -> Result<(PathBuf, bool), String> {
    let file_path = file_path.trim();
    if file_path.is_empty() {
        return Err("文件路径不能为空。".to_string());
    }

    let is_absolute = Path::new(file_path).is_absolute();
    let raw_target = if is_absolute {
        PathBuf::from(file_path)
    } else {
        workspace_root
            .ok_or_else(|| "相对文件路径需要绑定项目 workspace。".to_string())?
            .join(clean_relative_path(file_path)?)
    };

    if raw_target.exists() {
        let target = raw_target
            .canonicalize()
            .map_err(|error| format!("文件路径不可访问：{error}"))?;
        if !is_absolute && !target.starts_with(workspace_root.expect("relative path has workspace"))
        {
            return Err("不允许显示 workspace 外的文件。".to_string());
        }
        let select_target = target.is_file();
        return Ok((target, select_target));
    }

    let parent = raw_target
        .parent()
        .ok_or_else(|| "无法确定文件所在目录。".to_string())?
        .canonicalize()
        .map_err(|error| format!("文件所在目录不可访问：{error}"))?;
    if !is_absolute && !parent.starts_with(workspace_root.expect("relative path has workspace")) {
        return Err("不允许显示 workspace 外的目录。".to_string());
    }

    Ok((parent, false))
}

fn reveal_in_file_manager(target: &Path, select_target: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        if select_target {
            command.arg("-R");
        }
        command
            .arg(target)
            .spawn()
            .map_err(|error| format!("无法在 Finder 中显示文件：{error}"))?;
    }

    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("explorer");
        if select_target {
            command.arg("/select,");
        }
        command
            .arg(target)
            .spawn()
            .map_err(|error| format!("无法在文件管理器中显示文件：{error}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        let directory = if select_target {
            target.parent().unwrap_or(target)
        } else {
            target
        };
        Command::new("xdg-open")
            .arg(directory)
            .spawn()
            .map_err(|error| format!("无法在文件管理器中显示文件：{error}"))?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = (target, select_target);
        return Err("当前平台暂不支持在文件管理器中显示文件。".to_string());
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
    let mut conversations =
        chat_repository::list_conversations(&connection).map_err(storage_error)?;
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
    chat_repository::save_conversation_meta(&connection, &conversation).map_err(storage_error)?;
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
    chat_repository::upsert_messages(
        &mut connection,
        &conversation_id,
        &messages,
        position_offset,
    )
    .map_err(storage_error)?;
    Ok(messages)
}

#[tauri::command]
pub fn delete_conversation(
    state: State<'_, StorageState>,
    app_handle: AppHandle,
    conversation_id: String,
) -> Result<(), String> {
    let attachment_root = attachment_root(&app_handle)?;
    let attachments = {
        let connection = state.connection()?;
        let attachments =
            attachment_repository::list_conversation_attachments(&connection, &conversation_id)
                .map_err(storage_error)?;
        chat_repository::delete_conversation(&connection, &conversation_id)
            .map_err(storage_error)?;
        attachments
    };

    cleanup_attachment_files(&attachment_root, attachments)
        .map_err(|error| format!("对话已删除，但清理附件文件失败：{error}"))
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

#[tauri::command]
pub fn select_profile_avatar() -> Result<Option<String>, String> {
    const MAX_AVATAR_BYTES: u64 = 5 * 1024 * 1024;

    let Some(selected_path) = rfd::FileDialog::new()
        .add_filter(
            "Images",
            &["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"],
        )
        .pick_file()
    else {
        return Ok(None);
    };

    let metadata =
        fs::metadata(&selected_path).map_err(|error| format!("头像文件不可访问：{error}"))?;
    if !metadata.is_file() {
        return Err("请选择一个图片文件。".to_string());
    }
    if metadata.len() > MAX_AVATAR_BYTES {
        return Err("头像文件不能超过 5 MB。".to_string());
    }

    let mime_type = profile_avatar_mime_type(&selected_path)
        .ok_or_else(|| "请选择 png、jpg、webp、gif、bmp 或 avif 图片。".to_string())?;
    let bytes = fs::read(&selected_path).map_err(|error| format!("读取头像失败：{error}"))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);

    Ok(Some(format!("data:{mime_type};base64,{encoded}")))
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
        let attachments =
            attachment_repository::list_conversation_attachments(connection, &conversation.id)
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

fn cleanup_attachment_files(
    attachment_root: &Path,
    attachments: Vec<AttachmentRecord>,
) -> Result<(), String> {
    let mut errors = Vec::new();

    for attachment in attachments {
        let Some(storage_path) =
            safe_attachment_storage_path(attachment_root, &attachment.storage_rel_path)
        else {
            errors.push(format!("附件路径无效：{}", attachment.storage_rel_path));
            continue;
        };

        match fs::remove_file(&storage_path) {
            Ok(()) => {
                prune_empty_attachment_dirs(attachment_root, storage_path.parent(), &mut errors)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                prune_empty_attachment_dirs(attachment_root, storage_path.parent(), &mut errors);
            }
            Err(error) => errors.push(format!("{}: {error}", attachment.storage_rel_path)),
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn cleanup_orphan_attachment_files(
    connection: &Connection,
    attachment_root: &Path,
) -> Result<AttachmentCleanupSummary, String> {
    if !attachment_root.exists() {
        return Ok(AttachmentCleanupSummary::default());
    }

    let referenced_paths = attachment_repository::list_attachment_storage_rel_paths(connection)
        .map_err(storage_error)?
        .into_iter()
        .collect::<HashSet<_>>();
    let mut summary = AttachmentCleanupSummary::default();
    let mut errors = Vec::new();

    cleanup_orphan_attachment_dir(
        attachment_root,
        attachment_root,
        &referenced_paths,
        &mut summary,
        &mut errors,
    );

    if errors.is_empty() {
        Ok(summary)
    } else {
        Err(errors.join("; "))
    }
}

fn cleanup_orphan_attachment_dir(
    attachment_root: &Path,
    current_dir: &Path,
    referenced_paths: &HashSet<String>,
    summary: &mut AttachmentCleanupSummary,
    errors: &mut Vec<String>,
) {
    let entries = match fs::read_dir(current_dir) {
        Ok(entries) => entries,
        Err(error) => {
            errors.push(format!(
                "读取附件目录失败 {}: {error}",
                current_dir.display()
            ));
            return;
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                errors.push(format!(
                    "读取附件目录项失败 {}: {error}",
                    current_dir.display()
                ));
                continue;
            }
        };
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                errors.push(format!("读取附件路径失败 {}: {error}", path.display()));
                continue;
            }
        };
        let file_type = metadata.file_type();

        if file_type.is_dir() {
            cleanup_orphan_attachment_dir(
                attachment_root,
                &path,
                referenced_paths,
                summary,
                errors,
            );
            remove_empty_attachment_dir(attachment_root, &path, summary, errors);
            continue;
        }

        if !file_type.is_file() && !file_type.is_symlink() {
            continue;
        }

        let Some(relative_path) = orphan_scan_relative_path(attachment_root, &path) else {
            errors.push(format!("附件路径不在附件目录内：{}", path.display()));
            continue;
        };

        if referenced_paths.contains(&relative_path) {
            continue;
        }

        match fs::remove_file(&path) {
            Ok(()) => {
                summary.files_removed += 1;
                summary.bytes_removed += metadata.len();
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => errors.push(format!("删除孤儿附件失败 {relative_path}: {error}")),
        }
    }
}

fn remove_empty_attachment_dir(
    attachment_root: &Path,
    path: &Path,
    summary: &mut AttachmentCleanupSummary,
    errors: &mut Vec<String>,
) {
    if path == attachment_root {
        return;
    }

    match fs::remove_dir(path) {
        Ok(()) => summary.directories_removed += 1,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
            ) => {}
        Err(error) => errors.push(format!("删除空附件目录失败 {}: {error}", path.display())),
    }
}

fn orphan_scan_relative_path(attachment_root: &Path, path: &Path) -> Option<String> {
    let relative_path = path.strip_prefix(attachment_root).ok()?;
    let parts = relative_path
        .components()
        .map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    Some(parts.join("/"))
}

fn maintenance_task_completed(connection: &Connection, task_id: &str) -> rusqlite::Result<bool> {
    let count: i64 = connection.query_row(
        "
        SELECT COUNT(*)
        FROM maintenance_tasks
        WHERE id = ?1
        ",
        params![task_id],
        |row| row.get(0),
    )?;

    Ok(count > 0)
}

fn mark_maintenance_task_completed(connection: &Connection, task_id: &str) -> rusqlite::Result<()> {
    connection.execute(
        "
        INSERT INTO maintenance_tasks (id, completed_at)
        VALUES (?1, ?2)
        ON CONFLICT(id) DO UPDATE SET
            completed_at = excluded.completed_at
        ",
        params![task_id, now_ms()],
    )?;

    Ok(())
}

fn prune_empty_attachment_dirs(
    attachment_root: &Path,
    start: Option<&Path>,
    errors: &mut Vec<String>,
) {
    let Some(mut current) = start.map(Path::to_path_buf) else {
        return;
    };

    while current != attachment_root {
        match fs::remove_dir(&current) {
            Ok(()) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
                ) =>
            {
                break;
            }
            Err(error) => {
                errors.push(format!("{}: {error}", current.display()));
                break;
            }
        }

        if !current.pop() {
            break;
        }
    }
}

fn profile_avatar_mime_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "bmp" => Some("image/bmp"),
        "avif" => Some("image/avif"),
        _ => None,
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{attachment_repository, migrations};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_attachment_root(name: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be valid")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "my-copilot-attachment-cleanup-{name}-{}-{timestamp}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("test attachment root should be created");
        root
    }

    fn test_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("test database should open");
        migrations::run_migrations(&connection).expect("test database should migrate");
        connection
    }

    fn attachment_record(storage_rel_path: &str) -> AttachmentRecord {
        AttachmentRecord {
            id: "attachment-1".to_string(),
            conversation_id: "conversation-1".to_string(),
            message_id: "message-1".to_string(),
            project_id: Some("project-1".to_string()),
            kind: "file".to_string(),
            original_name: "note.txt".to_string(),
            mime_type: Some("text/plain".to_string()),
            size_bytes: 4,
            storage_rel_path: storage_rel_path.to_string(),
            created_at: 1,
        }
    }

    #[test]
    fn resolve_project_reveal_target_selects_existing_workspace_file() {
        let root = test_attachment_root("reveal-existing");
        let file = root.join("src/main.rs");
        fs::create_dir_all(file.parent().expect("file parent should exist")).unwrap();
        fs::write(&file, "fn main() {}\n").unwrap();
        let canonical_root = root.canonicalize().unwrap();

        let (target, select_target) =
            resolve_project_reveal_target(Some(&canonical_root), "src/main.rs").unwrap();

        assert_eq!(target, file.canonicalize().unwrap());
        assert!(select_target);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolve_project_reveal_target_opens_parent_for_missing_file() {
        let root = test_attachment_root("reveal-missing");
        let directory = root.join("src");
        fs::create_dir_all(&directory).unwrap();
        let canonical_root = root.canonicalize().unwrap();

        let (target, select_target) =
            resolve_project_reveal_target(Some(&canonical_root), "src/deleted.rs").unwrap();

        assert_eq!(target, directory.canonicalize().unwrap());
        assert!(!select_target);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolve_project_reveal_target_rejects_relative_workspace_escape() {
        let root = test_attachment_root("reveal-relative-escape");
        let canonical_root = root.canonicalize().unwrap();

        let result = resolve_project_reveal_target(Some(&canonical_root), "../outside.txt");

        assert!(result.is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolve_project_reveal_target_allows_explicit_absolute_path_outside_workspace() {
        let outside = test_attachment_root("reveal-absolute-outside");
        let file = outside.join("outside.txt");
        fs::write(&file, "outside\n").unwrap();

        let (target, select_target) =
            resolve_project_reveal_target(None, file.to_string_lossy().as_ref()).unwrap();

        assert_eq!(target, file.canonicalize().unwrap());
        assert!(select_target);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn cleanup_attachment_files_removes_file_and_empty_dirs() {
        let root = test_attachment_root("removes-file");
        let relative_path = "conversations/conversation-1/message-1/attachment-1/note.txt";
        let storage_path = root.join(relative_path);
        fs::create_dir_all(
            storage_path
                .parent()
                .expect("attachment parent should exist"),
        )
        .expect("attachment parent should be created");
        fs::write(&storage_path, b"test").expect("attachment file should be written");

        cleanup_attachment_files(&root, vec![attachment_record(relative_path)])
            .expect("attachment cleanup should succeed");

        assert!(!storage_path.exists());
        assert!(!root.join("conversations/conversation-1").exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cleanup_attachment_files_rejects_paths_outside_attachment_root() {
        let root = test_attachment_root("rejects-parent");

        let result = cleanup_attachment_files(&root, vec![attachment_record("../outside.txt")]);

        assert!(result.is_err());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cleanup_orphan_attachment_files_removes_unreferenced_files_only() {
        let connection = test_connection();
        let root = test_attachment_root("orphan-files");
        let referenced_path = "conversations/conversation-1/message-1/attachment-1/keep.txt";
        let orphan_path = "conversations/conversation-1/message-1/attachment-2/remove.txt";
        let referenced_storage_path = root.join(referenced_path);
        let orphan_storage_path = root.join(orphan_path);

        fs::create_dir_all(
            referenced_storage_path
                .parent()
                .expect("referenced parent should exist"),
        )
        .expect("referenced parent should be created");
        fs::write(&referenced_storage_path, b"keep").expect("referenced file should be written");
        fs::create_dir_all(
            orphan_storage_path
                .parent()
                .expect("orphan parent should exist"),
        )
        .expect("orphan parent should be created");
        fs::write(&orphan_storage_path, b"remove").expect("orphan file should be written");

        connection
            .execute(
                "
                INSERT INTO conversations (
                    id,
                    project_id,
                    model_id,
                    title,
                    created_at,
                    updated_at,
                    pinned_at,
                    archived_at,
                    unread_at
                )
                VALUES ('conversation-1', 'project-1', NULL, 'Test', 1, 1, NULL, NULL, NULL)
                ",
                [],
            )
            .expect("conversation should be inserted");
        attachment_repository::save_attachment(&connection, &attachment_record(referenced_path))
            .expect("referenced attachment should be saved");

        let summary = cleanup_orphan_attachment_files(&connection, &root)
            .expect("orphan attachment cleanup should succeed");

        assert_eq!(summary.files_removed, 1);
        assert_eq!(summary.bytes_removed, 6);
        assert!(referenced_storage_path.exists());
        assert!(!orphan_storage_path.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn run_orphan_attachment_cleanup_once_skips_after_success() {
        let connection = test_connection();
        let root = test_attachment_root("once");
        let orphan_path = root.join("conversations/conversation-1/message-1/attachment-1/old.txt");
        fs::create_dir_all(orphan_path.parent().expect("orphan parent should exist"))
            .expect("orphan parent should be created");
        fs::write(&orphan_path, b"old").expect("orphan file should be written");

        let first_summary = run_orphan_attachment_cleanup_once(&connection, &root)
            .expect("first cleanup run should succeed")
            .expect("first cleanup run should execute");

        assert_eq!(first_summary.files_removed, 1);
        assert!(!orphan_path.exists());

        let second_orphan_path =
            root.join("conversations/conversation-2/message-1/attachment-1/new.txt");
        fs::create_dir_all(
            second_orphan_path
                .parent()
                .expect("second orphan parent should exist"),
        )
        .expect("second orphan parent should be created");
        fs::write(&second_orphan_path, b"new").expect("second orphan file should be written");

        let second_summary = run_orphan_attachment_cleanup_once(&connection, &root)
            .expect("second cleanup run should succeed");

        assert!(second_summary.is_none());
        assert!(second_orphan_path.exists());

        let _ = fs::remove_dir_all(root);
    }
}
