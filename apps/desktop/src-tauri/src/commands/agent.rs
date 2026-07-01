use crate::agent_actions::pending::action_id;
use crate::agent_actions::AgentActionState;
use crate::storage::{config_repository, storage_error, StorageState};
use my_copilot_agent::{
    next_run_id, send_chat, send_chat_with_events, AgentChatInput, AgentChatOutput, AgentEvent,
    AgentEventEmitter, AgentRunStatus, AgentSearchConfig, AgentSearchMode,
};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State, Window};

pub const AGENT_EVENT_NAME: &str = "agent_event";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStartChatOutput {
    pub run_id: String,
    pub event_name: String,
}

#[tauri::command]
pub async fn agent_send_chat(
    mut input: AgentChatInput,
    storage_state: State<'_, StorageState>,
    action_state: State<'_, AgentActionState>,
) -> Result<AgentChatOutput, String> {
    input.search_config = load_agent_search_config(storage_state)?;
    let output = send_chat(input.clone())
        .await
        .map_err(|error| error.to_string())?;
    action_state.store_output_actions(&input, &output);
    Ok(output)
}

#[tauri::command]
pub async fn agent_start_chat(
    mut input: AgentChatInput,
    storage_state: State<'_, StorageState>,
    window: Window,
) -> Result<AgentStartChatOutput, String> {
    input.search_config = load_agent_search_config(storage_state)?;
    input.stream = Some(true);

    let run_id = next_run_id();
    let event_name = AGENT_EVENT_NAME.to_string();
    let worker_run_id = run_id.clone();
    let worker_input = input.clone();
    let worker_window = window.clone();
    let app_handle = window.app_handle().clone();

    tauri::async_runtime::spawn(async move {
        let event_window = worker_window.clone();
        let event_input = worker_input.clone();
        let event_app_handle = app_handle.clone();
        let event_tool_calls = Arc::new(Mutex::new(HashMap::<String, String>::new()));
        let event_tool_calls_for_emitter = event_tool_calls.clone();
        let emitter: AgentEventEmitter = Arc::new(move |event| {
            store_pending_action_from_event(
                &event_app_handle,
                &event_input,
                &event,
                &event_tool_calls_for_emitter,
            );
            let _ = event_window.emit(AGENT_EVENT_NAME, event);
        });

        match send_chat_with_events(worker_input.clone(), worker_run_id.clone(), emitter).await {
            Ok(output) => {
                let action_state = app_handle.state::<AgentActionState>();
                action_state.store_output_actions(&worker_input, &output);
            }
            Err(error) => {
                emit_agent_error(&worker_window, &worker_run_id, error.to_string());
            }
        }
    });

    Ok(AgentStartChatOutput { run_id, event_name })
}

fn store_pending_action_from_event(
    app_handle: &tauri::AppHandle,
    input: &AgentChatInput,
    event: &AgentEvent,
    tool_calls: &Arc<Mutex<HashMap<String, String>>>,
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
            let _ = action_state.store_action(input, run_id, action, tool_name);
        }
        _ => {}
    }
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

fn load_agent_search_config(
    state: State<'_, StorageState>,
) -> Result<Option<AgentSearchConfig>, String> {
    let connection = state.connection()?;
    let settings = config_repository::load_model_settings(&connection).map_err(storage_error)?;
    let Some(settings) = settings else {
        return Ok(None);
    };

    Ok(Some(AgentSearchConfig {
        mode: match settings.search_mode.as_str() {
            "disabled" => AgentSearchMode::Disabled,
            "tavily" => AgentSearchMode::Tavily,
            _ => AgentSearchMode::Auto,
        },
        tavily_api_key: non_empty(settings.tavily_api_key),
    }))
}

fn non_empty(value: String) -> Option<String> {
    let value = value.trim().to_string();
    if value.is_empty() || value == "tvly-my-copilot-search-key" {
        None
    } else {
        Some(value)
    }
}
