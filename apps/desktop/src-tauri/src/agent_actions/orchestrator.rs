use crate::agent_actions::pending::{AgentActionState, PendingAgentAction};
use crate::fs::patch::{apply_unified_diff, PatchApplyResult};
use crate::git::diff::{read_git_diff, GitDiffSnapshot};
use crate::process::command_runner::{
    run_approved_command, CommandExecutionResult, CommandRunState,
};
use crate::storage::{chat_repository, now_ms, StorageState};
use my_copilot_agent::{
    send_chat, AgentApprovalDecision, AgentApprovalDecisionStatus, AgentChatInput,
    AgentChatMessage, AgentChatOutput, AgentCommandRequest, AgentDiffProposal, AgentProposedAction,
    AgentToolResult,
};
use serde::Serialize;
use serde_json::json;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentActionExecutionStatus {
    Applied,
    Failed,
    Rejected,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentActionExecutionOutput {
    pub action_id: String,
    pub action_type: String,
    pub tool_name: String,
    pub status: AgentActionExecutionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch_result: Option<AgentPatchExecutionResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_result: Option<AgentCommandExecutionResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_result: Option<AgentToolResult>,
    pub agent_output: AgentChatOutput,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPatchExecutionResult {
    pub file_path: String,
    pub applied_file_paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_diff: Option<GitDiffSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_diff_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommandExecutionResult {
    pub command: String,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub cancelled: bool,
    pub duration_ms: u64,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub async fn approve_action(
    action_state: &AgentActionState,
    command_state: &CommandRunState,
    storage_state: &StorageState,
    action_id: String,
) -> Result<AgentActionExecutionOutput, String> {
    let pending = action_state.take(&action_id)?;

    match pending.action.clone() {
        AgentProposedAction::Diff { diff } => {
            approve_diff_action(action_state, storage_state, pending, diff).await
        }
        AgentProposedAction::Command { command } => {
            approve_command_action(action_state, command_state, storage_state, pending, command)
                .await
        }
        AgentProposedAction::ToolCall { call } => {
            Err(format!("暂不支持审批执行通用 tool_call：{}", call.tool))
        }
    }
}

pub async fn reject_action(
    action_state: &AgentActionState,
    storage_state: &StorageState,
    action_id: String,
    message: Option<String>,
) -> Result<AgentActionExecutionOutput, String> {
    let pending = action_state.take(&action_id)?;
    if pending.tool_name == "run_command" {
        return reject_command_action(action_state, storage_state, pending, message).await;
    }

    let mut input = pending.input.clone();
    input.approval_decision = Some(AgentApprovalDecision {
        action_id: pending.action_id.clone(),
        status: AgentApprovalDecisionStatus::Rejected,
        message: message
            .map(|message| message.trim().to_string())
            .filter(|message| !message.is_empty()),
    });

    let agent_output = send_chat(input.clone())
        .await
        .map_err(|error| error.to_string())?;
    action_state.store_output_actions_with_message(
        &input,
        &agent_output,
        pending.conversation_id.clone(),
        pending.assistant_message_id.clone(),
    );
    persist_assistant_output(storage_state, &pending, &agent_output);

    Ok(AgentActionExecutionOutput {
        action_id: pending.action_id,
        action_type: pending.action_type,
        tool_name: pending.tool_name,
        status: AgentActionExecutionStatus::Rejected,
        patch_result: None,
        command_result: None,
        tool_result: None,
        agent_output,
    })
}

async fn reject_command_action(
    action_state: &AgentActionState,
    storage_state: &StorageState,
    pending: PendingAgentAction,
    message: Option<String>,
) -> Result<AgentActionExecutionOutput, String> {
    let rejected_message = message
        .map(|message| message.trim().to_string())
        .filter(|message| !message.is_empty());
    let command = match &pending.action {
        AgentProposedAction::Command { command } => Some(command),
        _ => None,
    };
    let tool_result =
        rejected_command_tool_result(&pending.action_id, command, rejected_message.clone());

    let mut input = pending.input.clone();
    input.approval_decision = Some(AgentApprovalDecision {
        action_id: pending.action_id.clone(),
        status: AgentApprovalDecisionStatus::Rejected,
        message: rejected_message,
    });
    input.messages.push(AgentChatMessage {
        role: "user".to_string(),
        content: build_rejected_command_result_observation(&tool_result),
    });

    let agent_output = send_chat(input.clone())
        .await
        .map_err(|error| error.to_string())?;
    action_state.store_output_actions_with_message(
        &input,
        &agent_output,
        pending.conversation_id.clone(),
        pending.assistant_message_id.clone(),
    );
    persist_assistant_output(storage_state, &pending, &agent_output);

    Ok(AgentActionExecutionOutput {
        action_id: pending.action_id,
        action_type: pending.action_type,
        tool_name: pending.tool_name,
        status: AgentActionExecutionStatus::Rejected,
        patch_result: None,
        command_result: None,
        tool_result: Some(tool_result),
        agent_output,
    })
}

async fn approve_diff_action(
    action_state: &AgentActionState,
    storage_state: &StorageState,
    pending: PendingAgentAction,
    diff: AgentDiffProposal,
) -> Result<AgentActionExecutionOutput, String> {
    let workspace_root = workspace_root(&pending.input);
    let execution = match workspace_root {
        Ok(root) => apply_patch_and_read_diff(&root, &diff),
        Err(error) => PatchExecution {
            status: AgentActionExecutionStatus::Failed,
            observation_ok: false,
            result: AgentPatchExecutionResult {
                file_path: diff.file_path.clone(),
                applied_file_paths: Vec::new(),
                git_diff: None,
                git_diff_error: None,
                error: Some(error),
            },
        },
    };

    let mut input = pending.input.clone();
    input.approval_decision = Some(AgentApprovalDecision {
        action_id: pending.action_id.clone(),
        status: AgentApprovalDecisionStatus::Approved,
        message: Some("用户批准应用 patch。".to_string()),
    });
    input.messages.push(AgentChatMessage {
        role: "user".to_string(),
        content: build_tool_result_observation(
            &pending.tool_name,
            &pending.action_id,
            execution.observation_ok,
            &execution.result,
        ),
    });

    let agent_output = send_chat(input.clone())
        .await
        .map_err(|error| error.to_string())?;
    action_state.store_output_actions_with_message(
        &input,
        &agent_output,
        pending.conversation_id.clone(),
        pending.assistant_message_id.clone(),
    );
    persist_assistant_output(storage_state, &pending, &agent_output);

    Ok(AgentActionExecutionOutput {
        action_id: pending.action_id,
        action_type: pending.action_type,
        tool_name: pending.tool_name,
        status: execution.status,
        patch_result: Some(execution.result),
        command_result: None,
        tool_result: None,
        agent_output,
    })
}

async fn approve_command_action(
    action_state: &AgentActionState,
    command_state: &CommandRunState,
    storage_state: &StorageState,
    pending: PendingAgentAction,
    command: AgentCommandRequest,
) -> Result<AgentActionExecutionOutput, String> {
    let workspace_root = workspace_root(&pending.input);
    let execution = match workspace_root {
        Ok(root) => {
            let guard = command_state.register(&pending.action_id);
            run_command_and_capture(&root, &command, Some(guard.cancel_flag()))
        }
        Err(error) => CommandExecution {
            status: AgentActionExecutionStatus::Failed,
            observation_ok: false,
            result: AgentCommandExecutionResult {
                command: command.command.clone(),
                cwd: command.cwd.clone().unwrap_or_else(|| ".".to_string()),
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                timed_out: false,
                cancelled: false,
                duration_ms: 0,
                stdout_truncated: false,
                stderr_truncated: false,
                error: Some(error),
            },
        },
    };

    let mut input = pending.input.clone();
    input.approval_decision = Some(AgentApprovalDecision {
        action_id: pending.action_id.clone(),
        status: AgentApprovalDecisionStatus::Approved,
        message: Some("用户批准运行命令。".to_string()),
    });
    input.messages.push(AgentChatMessage {
        role: "user".to_string(),
        content: build_command_result_observation(
            &pending.tool_name,
            &pending.action_id,
            execution.observation_ok,
            &execution.result,
        ),
    });
    let tool_result = command_tool_result(
        &pending.action_id,
        pending.tool_name.as_str(),
        execution.observation_ok,
        &execution.result,
    );

    let agent_output = send_chat(input.clone())
        .await
        .map_err(|error| error.to_string())?;
    action_state.store_output_actions_with_message(
        &input,
        &agent_output,
        pending.conversation_id.clone(),
        pending.assistant_message_id.clone(),
    );
    persist_assistant_output(storage_state, &pending, &agent_output);

    Ok(AgentActionExecutionOutput {
        action_id: pending.action_id,
        action_type: pending.action_type,
        tool_name: pending.tool_name,
        status: execution.status,
        patch_result: None,
        command_result: Some(execution.result),
        tool_result: Some(tool_result),
        agent_output,
    })
}

struct PatchExecution {
    status: AgentActionExecutionStatus,
    observation_ok: bool,
    result: AgentPatchExecutionResult,
}

struct CommandExecution {
    status: AgentActionExecutionStatus,
    observation_ok: bool,
    result: AgentCommandExecutionResult,
}

fn command_tool_result(
    action_id: &str,
    tool_name: &str,
    observation_ok: bool,
    command_result: &AgentCommandExecutionResult,
) -> AgentToolResult {
    AgentToolResult {
        call_id: action_id.to_string(),
        tool: tool_name.to_string(),
        ok: observation_ok,
        result: Some(json!(command_result)),
        error: if observation_ok {
            None
        } else {
            command_result
                .error
                .clone()
                .or_else(|| Some("命令执行失败、超时、被取消或返回非零 exit code。".to_string()))
        },
    }
}

fn rejected_command_tool_result(
    action_id: &str,
    command: Option<&AgentCommandRequest>,
    message: Option<String>,
) -> AgentToolResult {
    let mut result = json!({
        "status": "rejected",
    });

    if let Some(object) = result.as_object_mut() {
        if let Some(message) = message {
            object.insert("message".to_string(), json!(message));
        }

        if let Some(command) = command {
            object.insert("command".to_string(), json!(command.command));
            object.insert("cwd".to_string(), json!(command.cwd));
            object.insert("timeoutMs".to_string(), json!(command.timeout_ms));
            object.insert("riskLevel".to_string(), json!(command.risk_level));
            object.insert("reason".to_string(), json!(command.reason));
        }
    }

    AgentToolResult {
        call_id: action_id.to_string(),
        tool: "run_command".to_string(),
        ok: true,
        result: Some(result),
        error: None,
    }
}

fn apply_patch_and_read_diff(root: &PathBuf, diff: &AgentDiffProposal) -> PatchExecution {
    match apply_unified_diff(root, &diff.file_path, &diff.patch) {
        Ok(apply_result) => successful_patch_execution(root, diff, apply_result),
        Err(error) => PatchExecution {
            status: AgentActionExecutionStatus::Failed,
            observation_ok: false,
            result: AgentPatchExecutionResult {
                file_path: diff.file_path.clone(),
                applied_file_paths: Vec::new(),
                git_diff: None,
                git_diff_error: None,
                error: Some(error),
            },
        },
    }
}

fn successful_patch_execution(
    root: &PathBuf,
    diff: &AgentDiffProposal,
    apply_result: PatchApplyResult,
) -> PatchExecution {
    let (git_diff, git_diff_error) = match read_git_diff(root, Some(&diff.file_path)) {
        Ok(git_diff) => (Some(git_diff), None),
        Err(error) => (None, Some(error)),
    };

    PatchExecution {
        status: AgentActionExecutionStatus::Applied,
        observation_ok: true,
        result: AgentPatchExecutionResult {
            file_path: diff.file_path.clone(),
            applied_file_paths: apply_result.file_paths,
            git_diff,
            git_diff_error,
            error: None,
        },
    }
}

fn run_command_and_capture(
    root: &PathBuf,
    command: &AgentCommandRequest,
    cancel_flag: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> CommandExecution {
    match run_approved_command(root, command, cancel_flag) {
        Ok(result) => successful_command_execution(result),
        Err(error) => CommandExecution {
            status: AgentActionExecutionStatus::Failed,
            observation_ok: false,
            result: AgentCommandExecutionResult {
                command: command.command.clone(),
                cwd: command.cwd.clone().unwrap_or_else(|| ".".to_string()),
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                timed_out: false,
                cancelled: false,
                duration_ms: 0,
                stdout_truncated: false,
                stderr_truncated: false,
                error: Some(error),
            },
        },
    }
}

fn successful_command_execution(result: CommandExecutionResult) -> CommandExecution {
    let ok = result.exit_code == Some(0) && !result.timed_out && !result.cancelled;
    CommandExecution {
        status: if ok {
            AgentActionExecutionStatus::Applied
        } else {
            AgentActionExecutionStatus::Failed
        },
        observation_ok: ok,
        result: AgentCommandExecutionResult {
            command: result.command,
            cwd: result.cwd,
            exit_code: result.exit_code,
            stdout: result.stdout,
            stderr: result.stderr,
            timed_out: result.timed_out,
            cancelled: result.cancelled,
            duration_ms: result.duration_ms,
            stdout_truncated: result.stdout_truncated,
            stderr_truncated: result.stderr_truncated,
            error: if ok {
                None
            } else {
                Some("命令执行失败、超时、被取消或返回非零 exit code。".to_string())
            },
        },
    }
}

fn persist_assistant_output(
    storage_state: &StorageState,
    pending: &PendingAgentAction,
    output: &AgentChatOutput,
) {
    let (Some(conversation_id), Some(assistant_message_id)) = (
        pending.conversation_id.as_deref(),
        pending.assistant_message_id.as_deref(),
    ) else {
        return;
    };
    let Ok(connection) = storage_state.connection() else {
        return;
    };
    let _ = chat_repository::update_message_status_and_content(
        &connection,
        conversation_id,
        assistant_message_id,
        &output.content,
        status_for_run(output.status),
        now_ms(),
    );
}

fn status_for_run(status: my_copilot_agent::AgentRunStatus) -> Option<&'static str> {
    match status {
        my_copilot_agent::AgentRunStatus::Completed => Some("sent"),
        my_copilot_agent::AgentRunStatus::WaitingForApproval
        | my_copilot_agent::AgentRunStatus::Running
        | my_copilot_agent::AgentRunStatus::Idle => Some("pending"),
        my_copilot_agent::AgentRunStatus::Failed | my_copilot_agent::AgentRunStatus::Cancelled => {
            Some("error")
        }
    }
}

fn workspace_root(input: &AgentChatInput) -> Result<PathBuf, String> {
    input
        .context
        .as_ref()
        .and_then(|context| context.workspace.as_ref())
        .and_then(|workspace| workspace.root_path.as_ref())
        .map(PathBuf::from)
        .ok_or_else(|| "没有已选择的 workspace，无法应用 patch。".to_string())
}

fn build_tool_result_observation(
    tool_name: &str,
    action_id: &str,
    ok: bool,
    result: &AgentPatchExecutionResult,
) -> String {
    let payload = if ok {
        json!({
            "type": "tool_result",
            "tool": tool_name,
            "callId": action_id,
            "ok": true,
            "result": result
        })
    } else {
        json!({
            "type": "tool_result",
            "tool": tool_name,
            "callId": action_id,
            "ok": false,
            "error": result.error,
            "result": result
        })
    };
    let payload = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string());

    format!(
        "Tool result observation from approved host action. Use this result to continue, repair the patch if needed, or summarize the applied change.\n```json\n{payload}\n```"
    )
}

fn build_command_result_observation(
    tool_name: &str,
    action_id: &str,
    ok: bool,
    result: &AgentCommandExecutionResult,
) -> String {
    let payload = if ok {
        json!({
            "type": "tool_result",
            "tool": tool_name,
            "callId": action_id,
            "ok": true,
            "result": result
        })
    } else {
        json!({
            "type": "tool_result",
            "tool": tool_name,
            "callId": action_id,
            "ok": false,
            "error": result.error,
            "result": result
        })
    };
    let payload = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string());

    format!(
        "Tool result observation from approved host command. Use stdout, stderr, exitCode, and timeout status to continue or repair.\n```json\n{payload}\n```"
    )
}

fn build_rejected_command_result_observation(tool_result: &AgentToolResult) -> String {
    let payload = json!({
        "type": "tool_result",
        "tool": tool_result.tool,
        "callId": tool_result.call_id,
        "ok": tool_result.ok,
        "result": tool_result.result,
        "error": tool_result.error,
    });
    let payload = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string());

    format!(
        "Tool result observation from rejected host command. The user rejected this run_command request. Do not request the same command again unless the user explicitly changes their decision. Respect the rejection message and continue with an alternative approach or ask a different approval request if needed.\n```json\n{payload}\n```"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_tool_result_uses_run_command_call_id_and_result_payload() {
        let command_result = AgentCommandExecutionResult {
            command: "pnpm test".to_string(),
            cwd: "/workspace".to_string(),
            exit_code: Some(0),
            stdout: "ok".to_string(),
            stderr: String::new(),
            timed_out: false,
            cancelled: false,
            duration_ms: 123,
            stdout_truncated: false,
            stderr_truncated: false,
            error: None,
        };

        let result = command_tool_result("command-1", "run_command", true, &command_result);

        assert_eq!(result.call_id, "command-1");
        assert_eq!(result.tool, "run_command");
        assert!(result.ok);
        assert_eq!(result.result.as_ref().unwrap()["command"], "pnpm test");
        assert_eq!(result.result.as_ref().unwrap()["exitCode"], 0);
        assert!(result.error.is_none());
    }

    #[test]
    fn rejected_command_tool_result_keeps_rejection_on_same_call() {
        let command = AgentCommandRequest {
            id: "command-1".to_string(),
            command: "pnpm install".to_string(),
            cwd: Some("/workspace".to_string()),
            timeout_ms: Some(120_000),
            approval_status: my_copilot_agent::AgentApprovalStatus::Required,
            risk_level: None,
            reason: Some("安装依赖".to_string()),
        };
        let result = rejected_command_tool_result(
            "command-1",
            Some(&command),
            Some("先不要运行安装命令。".to_string()),
        );

        assert_eq!(result.call_id, "command-1");
        assert_eq!(result.tool, "run_command");
        assert!(result.ok);
        assert_eq!(result.result.as_ref().unwrap()["status"], "rejected");
        assert_eq!(result.result.as_ref().unwrap()["command"], "pnpm install");
        assert_eq!(
            result.result.as_ref().unwrap()["message"],
            "先不要运行安装命令。"
        );
        assert!(result.error.is_none());
    }

    #[test]
    fn rejected_command_observation_tells_agent_to_continue_without_repeating() {
        let result = rejected_command_tool_result(
            "command-1",
            None,
            Some("换一种不用安装依赖的做法。".to_string()),
        );
        let observation = build_rejected_command_result_observation(&result);

        assert!(observation.contains("rejected host command"));
        assert!(observation.contains("Do not request the same command again"));
        assert!(observation.contains("换一种不用安装依赖的做法"));
    }
}
