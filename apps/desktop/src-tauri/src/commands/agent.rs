use crate::agent_actions::AgentActionState;
use crate::storage::{config_repository, storage_error, StorageState};
use my_copilot_agent::{
    send_chat, AgentChatInput, AgentChatOutput, AgentSearchConfig, AgentSearchMode,
};
use tauri::State;

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
