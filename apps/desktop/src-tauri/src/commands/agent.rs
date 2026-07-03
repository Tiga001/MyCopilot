use crate::agent_actions::pending::action_id;
use crate::agent_actions::AgentActionState;
use crate::fs::canonical_workspace_root;
use crate::storage::models::{
    AgentPromptPreferencesRecord, AttachmentRecord, ChatConversationRecord,
    ChatMessageAttachmentRecord, ChatMessageRecord, ProjectRecord,
};
use crate::storage::{
    agent_prompt_preferences_repository, attachment_repository, chat_repository, config_repository,
    now_ms, project_repository, storage_error, StorageState,
};
use base64::Engine;
use my_copilot_agent::{
    next_run_id, send_chat_with_events, AgentAttachmentLibraryContext, AgentAttachmentReference,
    AgentChatInput, AgentChatMessage, AgentEvent, AgentEventEmitter, AgentInputAttachment,
    AgentInputAttachmentEncoding, AgentInputAttachmentKind, AgentPromptDetailLevel,
    AgentPromptPreferences, AgentPromptTone, AgentPromptWorkMode, AgentRunContext, AgentRunMode,
    AgentRunStatus, AgentSearchConfig, AgentSearchMode, AgentWorkspaceContext,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State, Window};

pub const AGENT_EVENT_NAME: &str = "agent_event";

static ID_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversationTurnInput {
    pub conversation_id: Option<String>,
    pub project_id: Option<String>,
    pub model_id: String,
    pub content: String,
    #[serde(default)]
    pub attachments: Vec<AgentInputAttachment>,
    pub title: Option<String>,
    pub user_message_id: Option<String>,
    pub assistant_message_id: Option<String>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub mode: Option<AgentRunMode>,
    pub prompt_preferences: Option<AgentPromptPreferences>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversationTurnOutput {
    pub run_id: String,
    pub event_name: String,
    pub conversation_id: String,
    pub user_message_id: String,
    pub assistant_message_id: String,
    pub user_message: ChatMessageRecord,
    pub assistant_message: ChatMessageRecord,
}

struct PreparedConversationTurn {
    output: AgentConversationTurnOutput,
    agent_input: AgentChatInput,
}

#[tauri::command]
pub async fn agent_start_conversation_turn(
    input: AgentConversationTurnInput,
    storage_state: State<'_, StorageState>,
    window: Window,
) -> Result<AgentConversationTurnOutput, String> {
    let run_id = next_run_id();
    let attachment_root = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|error| format!("获取应用数据目录失败：{error}"))?
        .join("attachments");
    let prepared = prepare_conversation_turn(&storage_state, input, &run_id, &attachment_root)?;
    let output = prepared.output.clone();
    let worker_input = prepared.agent_input.clone();
    let worker_run_id = run_id.clone();
    let worker_window = window.clone();
    let app_handle = window.app_handle().clone();
    let conversation_id = output.conversation_id.clone();
    let assistant_message_id = output.assistant_message_id.clone();

    tauri::async_runtime::spawn(async move {
        let event_window = worker_window.clone();
        let event_input = worker_input.clone();
        let event_app_handle = app_handle.clone();
        let event_conversation_id = conversation_id.clone();
        let event_assistant_message_id = assistant_message_id.clone();
        let event_tool_calls = Arc::new(Mutex::new(HashMap::<String, String>::new()));
        let event_tool_calls_for_emitter = event_tool_calls.clone();
        let emitter: AgentEventEmitter = Arc::new(move |event| {
            store_pending_action_from_event(
                &event_app_handle,
                &event_input,
                &event,
                &event_tool_calls_for_emitter,
                Some(&event_conversation_id),
                Some(&event_assistant_message_id),
            );
            let _ = event_window.emit(AGENT_EVENT_NAME, event);
        });

        match send_chat_with_events(worker_input.clone(), worker_run_id.clone(), emitter).await {
            Ok(agent_output) => {
                persist_assistant_output(
                    &app_handle,
                    &conversation_id,
                    &assistant_message_id,
                    &agent_output.content,
                    status_for_run(agent_output.status),
                );

                let action_state = app_handle.state::<AgentActionState>();
                action_state.store_output_actions_with_message(
                    &worker_input,
                    &agent_output,
                    Some(conversation_id.clone()),
                    Some(assistant_message_id.clone()),
                );
            }
            Err(error) => {
                let message = error.to_string();
                persist_assistant_output(
                    &app_handle,
                    &conversation_id,
                    &assistant_message_id,
                    &message,
                    Some("error"),
                );
                emit_agent_error(&worker_window, &worker_run_id, message);
            }
        }
    });

    Ok(output)
}

fn prepare_conversation_turn(
    state: &StorageState,
    input: AgentConversationTurnInput,
    run_id: &str,
    attachment_root: &Path,
) -> Result<PreparedConversationTurn, String> {
    let content = input.content.trim().to_string();
    if content.is_empty() {
        return Err("消息内容不能为空。".to_string());
    }
    let model_id = input.model_id.trim().to_string();
    if model_id.is_empty() {
        return Err("modelId 不能为空。".to_string());
    }

    let mut connection = state.connection()?;
    let settings = config_repository::load_model_settings(&connection).map_err(storage_error)?;
    let settings = settings.ok_or_else(|| "请先配置模型 API。".to_string())?;
    let model = settings
        .models
        .iter()
        .find(|model| model.id == model_id)
        .ok_or_else(|| format!("未找到模型配置：{model_id}"))?;
    if !model.enabled {
        return Err(format!("模型未启用：{model_id}"));
    }
    let prompt_preferences = if let Some(preferences) = input.prompt_preferences.clone() {
        preferences
    } else {
        let preferences =
            agent_prompt_preferences_repository::load_agent_prompt_preferences(&connection)
                .map_err(storage_error)?;
        agent_prompt_preferences_from_record(preferences)
    };

    let timestamp = now_ms();
    let conversation_id = input
        .conversation_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| create_id("conversation"));
    let user_message_id = input
        .user_message_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| create_id("message"));
    let assistant_message_id = input
        .assistant_message_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| create_id("message"));

    let existing =
        chat_repository::get_conversation(&connection, &conversation_id).map_err(storage_error)?;
    let input_project_id = normalize_optional_string(input.project_id.as_deref());
    let resolved_project_id = input_project_id.or_else(|| {
        existing
            .as_ref()
            .and_then(|conversation| normalize_optional_string(conversation.project_id.as_deref()))
    });
    let project = resolve_project_context(&connection, resolved_project_id.as_deref())?;
    let mut conversation = existing.unwrap_or_else(|| ChatConversationRecord {
        id: conversation_id.clone(),
        project_id: resolved_project_id.clone(),
        model_id: Some(model_id.clone()),
        title: input
            .title
            .clone()
            .map(|title| title.trim().to_string())
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| create_conversation_title(&content)),
        messages: Vec::new(),
        created_at: timestamp,
        updated_at: timestamp,
        pinned_at: None,
        archived_at: None,
        unread_at: None,
    });

    conversation.project_id = resolved_project_id.clone();
    conversation.model_id = Some(model_id.clone());
    conversation.updated_at = timestamp;

    let history_messages = conversation
        .messages
        .iter()
        .filter(|message| message.id != user_message_id && message.id != assistant_message_id)
        .filter(|message| message.status.as_deref() != Some("pending"))
        .filter(|message| message.status.as_deref() != Some("error"))
        .filter(|message| matches!(message.role.as_str(), "user" | "assistant"))
        .filter(|message| !message.content.trim().is_empty())
        .map(|message| AgentChatMessage {
            role: message.role.clone(),
            content: message.content.clone(),
        })
        .collect::<Vec<_>>();

    let user_message = ChatMessageRecord {
        id: user_message_id.clone(),
        role: "user".to_string(),
        content: content.clone(),
        created_at: timestamp,
        status: Some("sent".to_string()),
        attachments: conversation_message_attachments_from_input(&input.attachments, timestamp),
        agent_run_json: None,
        ui_state_json: None,
    };
    let assistant_message = ChatMessageRecord {
        id: assistant_message_id.clone(),
        role: "assistant".to_string(),
        content: "正在思考...".to_string(),
        created_at: timestamp + 1,
        status: Some("pending".to_string()),
        attachments: Vec::new(),
        agent_run_json: None,
        ui_state_json: None,
    };

    upsert_message(&mut conversation.messages, user_message.clone());
    upsert_message(&mut conversation.messages, assistant_message.clone());
    chat_repository::save_conversation(&mut connection, conversation).map_err(storage_error)?;
    persist_turn_attachments(
        &connection,
        attachment_root,
        &conversation_id,
        &user_message_id,
        resolved_project_id.as_deref(),
        &input.attachments,
        timestamp,
    )?;
    let attachment_library = build_attachment_library_context(
        &connection,
        attachment_root,
        &conversation_id,
        resolved_project_id.as_deref(),
    )?;

    let mut agent_messages = history_messages;
    agent_messages.push(AgentChatMessage {
        role: "user".to_string(),
        content,
    });

    let agent_input = AgentChatInput {
        api_url: settings.api_url.trim().to_string(),
        api_token: settings.api_token.trim().to_string(),
        model: model
            .provider_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(model.id.as_str())
            .to_string(),
        api_style: None,
        max_tokens: input.max_tokens,
        temperature: input.temperature,
        mode: input.mode,
        stream: Some(true),
        context: Some(AgentRunContext {
            conversation_id: Some(conversation_id.clone()),
            project_id: resolved_project_id.clone(),
            workspace: project.as_ref().map(|project| AgentWorkspaceContext {
                project_id: Some(project.id.clone()),
                display_name: Some(project.name.clone()),
                root_path: project.path.clone(),
            }),
            attachment_library: Some(attachment_library),
        }),
        search_config: Some(AgentSearchConfig {
            mode: match settings.search_mode.as_str() {
                "disabled" => AgentSearchMode::Disabled,
                "tavily" => AgentSearchMode::Tavily,
                _ => AgentSearchMode::Auto,
            },
            tavily_api_key: non_empty(settings.tavily_api_key),
        }),
        prompt_preferences: Some(prompt_preferences),
        approval_decision: None,
        attachments: input.attachments,
        messages: agent_messages,
    };

    Ok(PreparedConversationTurn {
        output: AgentConversationTurnOutput {
            run_id: run_id.to_string(),
            event_name: AGENT_EVENT_NAME.to_string(),
            conversation_id,
            user_message_id,
            assistant_message_id,
            user_message,
            assistant_message,
        },
        agent_input,
    })
}

fn persist_turn_attachments(
    connection: &Connection,
    attachment_root: &Path,
    conversation_id: &str,
    message_id: &str,
    project_id: Option<&str>,
    attachments: &[AgentInputAttachment],
    created_at: i64,
) -> Result<(), String> {
    if attachments.is_empty() {
        return Ok(());
    }

    fs::create_dir_all(attachment_root).map_err(|error| format!("创建附件库目录失败：{error}"))?;

    for attachment in attachments {
        let bytes = input_attachment_bytes(attachment)?;
        let attachment_id = safe_path_component(&attachment.id, "attachment");
        let storage_rel_path = attachment_storage_rel_path(
            conversation_id,
            message_id,
            &attachment_id,
            &attachment.name,
        );
        let storage_path = attachment_root.join(&storage_rel_path);
        let parent = storage_path
            .parent()
            .ok_or_else(|| "附件存储路径无效。".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("创建附件目录失败：{error}"))?;
        fs::write(&storage_path, &bytes).map_err(|error| format!("写入附件失败：{error}"))?;

        let record = AttachmentRecord {
            id: attachment_id,
            conversation_id: conversation_id.to_string(),
            message_id: message_id.to_string(),
            project_id: project_id.map(ToString::to_string),
            kind: input_attachment_kind_label(attachment.kind).to_string(),
            original_name: attachment.name.clone(),
            mime_type: attachment.mime_type.clone(),
            size_bytes: bytes.len() as u64,
            storage_rel_path: slash_path(&storage_rel_path),
            created_at,
        };
        attachment_repository::save_attachment(connection, &record).map_err(storage_error)?;
    }

    Ok(())
}

fn conversation_message_attachments_from_input(
    attachments: &[AgentInputAttachment],
    created_at: i64,
) -> Vec<ChatMessageAttachmentRecord> {
    attachments
        .iter()
        .map(|attachment| {
            let preview_data = if attachment.kind == AgentInputAttachmentKind::Image
                && attachment.encoding == AgentInputAttachmentEncoding::Base64
                && attachment
                    .mime_type
                    .as_deref()
                    .is_some_and(|mime_type| mime_type.starts_with("image/"))
            {
                Some(attachment.data.clone())
            } else {
                None
            };

            ChatMessageAttachmentRecord {
                id: safe_path_component(&attachment.id, "attachment"),
                kind: input_attachment_kind_label(attachment.kind).to_string(),
                name: attachment.name.clone(),
                mime_type: attachment.mime_type.clone(),
                size_bytes: attachment.size_bytes,
                preview_mime_type: preview_data.as_ref().and(attachment.mime_type.clone()),
                preview_data,
                created_at,
            }
        })
        .collect()
}

fn build_attachment_library_context(
    connection: &Connection,
    attachment_root: &Path,
    conversation_id: &str,
    project_id: Option<&str>,
) -> Result<AgentAttachmentLibraryContext, String> {
    let conversation_attachments =
        attachment_repository::list_conversation_attachments(connection, conversation_id)
            .map_err(storage_error)?
            .into_iter()
            .map(agent_attachment_reference)
            .collect::<Vec<_>>();
    let project_attachments = if let Some(project_id) = project_id {
        attachment_repository::list_project_attachments(connection, project_id)
            .map_err(storage_error)?
            .into_iter()
            .map(agent_attachment_reference)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    Ok(AgentAttachmentLibraryContext {
        root_path: Some(attachment_root.to_string_lossy().to_string()),
        conversation_id: Some(conversation_id.to_string()),
        project_id: project_id.map(ToString::to_string),
        conversation_attachments,
        project_attachments,
    })
}

fn agent_attachment_reference(record: AttachmentRecord) -> AgentAttachmentReference {
    let read_path = attachment_read_path(&record.id, &record.original_name);
    AgentAttachmentReference {
        id: record.id,
        conversation_id: record.conversation_id,
        message_id: record.message_id,
        project_id: record.project_id,
        kind: agent_attachment_kind(&record.kind),
        name: record.original_name,
        mime_type: record.mime_type,
        size_bytes: record.size_bytes,
        read_path,
        storage_rel_path: record.storage_rel_path,
        created_at: record.created_at,
    }
}

fn input_attachment_bytes(attachment: &AgentInputAttachment) -> Result<Vec<u8>, String> {
    match attachment.encoding {
        AgentInputAttachmentEncoding::Utf8 => Ok(attachment.data.as_bytes().to_vec()),
        AgentInputAttachmentEncoding::Base64 => base64::engine::general_purpose::STANDARD
            .decode(attachment.data.as_bytes())
            .map_err(|error| format!("附件 base64 数据无效：{error}")),
    }
}

fn input_attachment_kind_label(kind: AgentInputAttachmentKind) -> &'static str {
    match kind {
        AgentInputAttachmentKind::File => "file",
        AgentInputAttachmentKind::Image => "image",
    }
}

fn agent_attachment_kind(kind: &str) -> AgentInputAttachmentKind {
    match kind {
        "image" => AgentInputAttachmentKind::Image,
        _ => AgentInputAttachmentKind::File,
    }
}

fn agent_prompt_preferences_from_record(
    record: AgentPromptPreferencesRecord,
) -> AgentPromptPreferences {
    AgentPromptPreferences {
        work_mode: Some(match record.work_mode.as_str() {
            "general" => AgentPromptWorkMode::General,
            _ => AgentPromptWorkMode::Coding,
        }),
        tone: Some(match record.tone.as_str() {
            "friendly" => AgentPromptTone::Friendly,
            _ => AgentPromptTone::Pragmatic,
        }),
        detail_level: Some(match record.detail_level.as_str() {
            "low" => AgentPromptDetailLevel::Low,
            "high" => AgentPromptDetailLevel::High,
            _ => AgentPromptDetailLevel::Medium,
        }),
        custom_instructions: normalize_prompt_custom_instructions(&record.custom_instructions),
        updated_at: Some(record.updated_at),
    }
}

fn normalize_prompt_custom_instructions(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn attachment_storage_rel_path(
    conversation_id: &str,
    message_id: &str,
    attachment_id: &str,
    original_name: &str,
) -> PathBuf {
    PathBuf::from("conversations")
        .join(safe_path_component(conversation_id, "conversation"))
        .join(safe_path_component(message_id, "message"))
        .join(safe_path_component(attachment_id, "attachment"))
        .join(safe_file_name(original_name, attachment_id))
}

fn attachment_read_path(attachment_id: &str, original_name: &str) -> String {
    format!(
        "@attachments/{}/{}",
        safe_path_component(attachment_id, "attachment"),
        safe_file_name(original_name, attachment_id)
    )
}

fn safe_file_name(name: &str, fallback: &str) -> String {
    let file_name = Path::new(name)
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback);

    safe_path_component(file_name, fallback)
}

fn safe_path_component(value: &str, fallback: &str) -> String {
    let sanitized = value
        .trim()
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '\0' => '_',
            character if character.is_control() => '_',
            character => character,
        })
        .collect::<String>();

    let sanitized = sanitized.trim();
    if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
        fallback.to_string()
    } else {
        sanitized.to_string()
    }
}

fn slash_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn store_pending_action_from_event(
    app_handle: &tauri::AppHandle,
    input: &AgentChatInput,
    event: &AgentEvent,
    tool_calls: &Arc<Mutex<HashMap<String, String>>>,
    conversation_id: Option<&str>,
    assistant_message_id: Option<&str>,
) {
    match event {
        AgentEvent::ToolCall { call, .. } => {
            if let Ok(mut tool_calls) = tool_calls.lock() {
                tool_calls.insert(call.id.clone(), call.tool.clone());
            }
        }
        AgentEvent::ApprovalRequired { run_id, action } => {
            let tool_name = action_id(action).and_then(|action_id| {
                tool_calls
                    .lock()
                    .ok()
                    .and_then(|tool_calls| tool_calls.get(action_id).cloned())
            });
            let action_state = app_handle.state::<AgentActionState>();
            let _ = action_state.store_action(
                input,
                run_id,
                action,
                tool_name,
                conversation_id.map(ToString::to_string),
                assistant_message_id.map(ToString::to_string),
            );
        }
        _ => {}
    }
}

fn persist_assistant_output(
    app_handle: &tauri::AppHandle,
    conversation_id: &str,
    assistant_message_id: &str,
    content: &str,
    status: Option<&str>,
) {
    let storage_state = app_handle.state::<StorageState>();
    let Ok(connection) = storage_state.connection() else {
        return;
    };
    let _ = chat_repository::update_message_status_and_content(
        &connection,
        conversation_id,
        assistant_message_id,
        content,
        status,
        now_ms(),
    );
}

fn emit_agent_error(window: &Window, run_id: &str, message: String) {
    let _ = window.emit(
        AGENT_EVENT_NAME,
        AgentEvent::Error {
            run_id: Some(run_id.to_string()),
            message: message.clone(),
            recoverable: false,
        },
    );
    let _ = window.emit(
        AGENT_EVENT_NAME,
        AgentEvent::Done {
            run_id: run_id.to_string(),
            success: false,
            status: Some(AgentRunStatus::Failed),
            content: Some(message),
            usage: None,
            finish_reason: None,
            proposed_actions: Vec::new(),
        },
    );
}

fn upsert_message(messages: &mut Vec<ChatMessageRecord>, next: ChatMessageRecord) {
    if let Some(existing) = messages.iter_mut().find(|message| message.id == next.id) {
        *existing = next;
    } else {
        messages.push(next);
    }
}

fn status_for_run(status: AgentRunStatus) -> Option<&'static str> {
    match status {
        AgentRunStatus::Completed => Some("sent"),
        AgentRunStatus::WaitingForApproval | AgentRunStatus::Running | AgentRunStatus::Idle => {
            Some("pending")
        }
        AgentRunStatus::Failed | AgentRunStatus::Cancelled => Some("error"),
    }
}

fn resolve_project_context(
    connection: &Connection,
    project_id: Option<&str>,
) -> Result<Option<ProjectRecord>, String> {
    let Some(project_id) = project_id else {
        return Ok(None);
    };

    let mut project = project_repository::get_project(connection, project_id)
        .map_err(storage_error)?
        .ok_or_else(|| format!("未找到项目：{project_id}"))?;
    let raw_path = project
        .path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| {
            format!(
                "项目「{}」没有绑定本地 workspace 路径，请重新选择项目目录。",
                project.name
            )
        })?;
    let canonical_path = canonical_workspace_root(Path::new(raw_path))?;

    project.path = Some(canonical_path.to_string_lossy().to_string());
    Ok(Some(project))
}

fn normalize_optional_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn create_conversation_title(message: &str) -> String {
    let first_line = message
        .lines()
        .next()
        .unwrap_or("新对话")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if first_line.chars().count() > 24 {
        format!("{}...", first_line.chars().take(24).collect::<String>())
    } else if first_line.is_empty() {
        "新对话".to_string()
    } else {
        first_line
    }
}

fn create_id(prefix: &str) -> String {
    let counter = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{counter}", now_ms())
}

fn non_empty(value: String) -> Option<String> {
    let value = value.trim().to_string();
    if value.is_empty() || value == "tvly-my-copilot-search-key" {
        None
    } else {
        Some(value)
    }
}
