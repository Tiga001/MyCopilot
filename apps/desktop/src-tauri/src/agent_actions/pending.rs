use my_copilot_agent::{
    AgentChatInput, AgentChatOutput, AgentEvent, AgentProposedAction, AgentToolCall,
};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
pub struct PendingAgentAction {
    pub action_id: String,
    pub action_type: String,
    pub tool_name: String,
    pub run_id: String,
    pub input: AgentChatInput,
    pub action: AgentProposedAction,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAgentActionSnapshot {
    pub action_id: String,
    pub action_type: String,
    pub tool_name: String,
    pub run_id: String,
    pub action: AgentProposedAction,
    pub created_at: u64,
}

#[derive(Default)]
pub struct AgentActionState {
    pending: Mutex<HashMap<String, PendingAgentAction>>,
}

impl AgentActionState {
    pub fn store_output_actions(&self, input: &AgentChatInput, output: &AgentChatOutput) {
        if output.proposed_actions.is_empty() {
            return;
        }

        let tool_calls = tool_calls_by_id(output);
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for action in &output.proposed_actions {
            let Some(action_id) = action_id(action) else {
                continue;
            };
            let action_type = action_type(action).to_string();
            let tool_name = tool_calls
                .get(action_id)
                .map(|call| call.tool.clone())
                .unwrap_or_else(|| fallback_tool_name(action));

            pending.insert(
                action_id.to_string(),
                PendingAgentAction {
                    action_id: action_id.to_string(),
                    action_type,
                    tool_name,
                    run_id: output.run_id.clone(),
                    input: input.clone(),
                    action: action.clone(),
                    created_at: now_ms(),
                },
            );
        }
    }

    pub fn take(&self, action_id: &str) -> Result<PendingAgentAction, String> {
        let mut pending = self.pending()?;
        pending
            .remove(action_id)
            .ok_or_else(|| format!("未找到待审批 action：{action_id}"))
    }

    pub fn list(&self) -> Result<Vec<PendingAgentActionSnapshot>, String> {
        let pending = self.pending()?;
        let mut actions = pending
            .values()
            .map(|action| PendingAgentActionSnapshot {
                action_id: action.action_id.clone(),
                action_type: action.action_type.clone(),
                tool_name: action.tool_name.clone(),
                run_id: action.run_id.clone(),
                action: action.action.clone(),
                created_at: action.created_at,
            })
            .collect::<Vec<_>>();
        actions.sort_by_key(|action| action.created_at);
        Ok(actions)
    }

    fn pending(&self) -> Result<MutexGuard<'_, HashMap<String, PendingAgentAction>>, String> {
        self.pending
            .lock()
            .map_err(|_| "agent pending action 状态不可用。".to_string())
    }
}

fn tool_calls_by_id(output: &AgentChatOutput) -> HashMap<String, AgentToolCall> {
    output
        .events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::ToolCall { call, .. } => Some((call.id.clone(), call.clone())),
            _ => None,
        })
        .collect()
}

pub fn action_id(action: &AgentProposedAction) -> Option<&str> {
    match action {
        AgentProposedAction::ToolCall { call } => Some(call.id.as_str()),
        AgentProposedAction::Diff { diff } => Some(diff.id.as_str()),
        AgentProposedAction::Command { command } => Some(command.id.as_str()),
    }
}

fn action_type(action: &AgentProposedAction) -> &'static str {
    match action {
        AgentProposedAction::ToolCall { .. } => "tool_call",
        AgentProposedAction::Diff { .. } => "diff",
        AgentProposedAction::Command { .. } => "command",
    }
}

fn fallback_tool_name(action: &AgentProposedAction) -> String {
    match action {
        AgentProposedAction::ToolCall { call } => call.tool.clone(),
        AgentProposedAction::Diff { .. } => "apply_patch".to_string(),
        AgentProposedAction::Command { .. } => "run_command".to_string(),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
