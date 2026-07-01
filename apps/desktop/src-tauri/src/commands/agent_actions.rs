use crate::agent_actions::orchestrator::{
    approve_action, reject_action, AgentActionExecutionOutput,
};
use crate::agent_actions::pending::PendingAgentActionSnapshot;
use crate::agent_actions::AgentActionState;
use crate::process::command_runner::CommandRunState;
use tauri::State;

#[tauri::command]
pub fn agent_list_pending_actions(
    state: State<'_, AgentActionState>,
) -> Result<Vec<PendingAgentActionSnapshot>, String> {
    state.list()
}

#[tauri::command]
pub async fn agent_approve_action(
    action_id: String,
    action_state: State<'_, AgentActionState>,
    command_state: State<'_, CommandRunState>,
) -> Result<AgentActionExecutionOutput, String> {
    approve_action(&action_state, &command_state, action_id).await
}

#[tauri::command]
pub async fn agent_reject_action(
    action_id: String,
    message: Option<String>,
    state: State<'_, AgentActionState>,
) -> Result<AgentActionExecutionOutput, String> {
    reject_action(&state, action_id, message).await
}

#[tauri::command]
pub fn agent_cancel_action(
    action_id: String,
    command_state: State<'_, CommandRunState>,
) -> Result<bool, String> {
    command_state.cancel(&action_id)
}
