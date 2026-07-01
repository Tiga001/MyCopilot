use crate::llm::{
    complete_chat, detect_api_style, LlmChatRequest, LlmMessage, LlmMessageRole, LlmToolCall,
};
use crate::protocol::{
    AgentApprovalDecision, AgentApprovalDecisionStatus, AgentApprovalStatus, AgentChatInput,
    AgentChatMessage, AgentChatOutput, AgentCommandRiskLevel, AgentError, AgentEvent,
    AgentProposedAction, AgentResult, AgentRunContext, AgentRunMode, AgentRunStatus,
    AgentStateSnapshot, AgentToolCall, AgentToolDefinition, AgentToolResult, AgentUsage,
};
use crate::tools::{ToolExecutionContext, ToolRegistry};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_MAX_TOKENS: u32 = 1024;
const MAX_MAX_TOKENS: u32 = 128_000;
const DEFAULT_TEMPERATURE: f32 = 0.6;
const MAX_TOOL_ITERATIONS: usize = 4;

static RUN_COUNTER: AtomicU64 = AtomicU64::new(1);

pub type AgentEventEmitter = Arc<dyn Fn(AgentEvent) + Send + Sync + 'static>;

pub async fn send_chat(input: AgentChatInput) -> AgentResult<AgentChatOutput> {
    AgentRuntime::default().send_chat(input).await
}

pub async fn send_chat_with_events(
    input: AgentChatInput,
    run_id: String,
    emitter: AgentEventEmitter,
) -> AgentResult<AgentChatOutput> {
    AgentRuntime::default()
        .send_chat_with_events(input, Some(run_id), Some(emitter))
        .await
}

pub fn next_run_id() -> String {
    generate_run_id()
}

pub struct AgentRuntime {
    max_tool_iterations: usize,
}

impl Default for AgentRuntime {
    fn default() -> Self {
        Self {
            max_tool_iterations: MAX_TOOL_ITERATIONS,
        }
    }
}

impl AgentRuntime {
    pub async fn send_chat(&self, input: AgentChatInput) -> AgentResult<AgentChatOutput> {
        self.send_chat_with_events(input, None, None).await
    }

    pub async fn send_chat_with_events(
        &self,
        input: AgentChatInput,
        run_id: Option<String>,
        emitter: Option<AgentEventEmitter>,
    ) -> AgentResult<AgentChatOutput> {
        let run_id = run_id.unwrap_or_else(generate_run_id);
        let context = input.context.clone();
        let tool_registry =
            ToolRegistry::read_only_defaults_with_search(input.search_config.as_ref());
        let tool_definitions = tool_registry.definitions();
        let mut event_stream = AgentEventStream::new(emitter);
        event_stream.emit(AgentEvent::Started {
            run_id: run_id.clone(),
            tool_definitions: tool_definitions.clone(),
        });
        let llm_request = build_llm_request(input, &tool_definitions)?;
        let mut messages = llm_request.messages;
        let tool_context = ToolExecutionContext::from_run_context(context.as_ref());
        event_stream.emit(state_event(
            &run_id,
            AgentRunStatus::Running,
            Some(run_id.clone()),
            None,
        ));
        let mut usage = None;
        let mut finish_reason = None;
        let mut final_content = None;

        for iteration in 0..=self.max_tool_iterations {
            let llm_response = complete_chat(LlmChatRequest {
                api_url: llm_request.api_url.clone(),
                api_token: llm_request.api_token.clone(),
                model: llm_request.model.clone(),
                api_style: llm_request.api_style,
                max_tokens: llm_request.max_tokens,
                temperature: llm_request.temperature,
                messages: messages.clone(),
                tools: llm_request.tools.clone(),
            })
            .await?;

            merge_usage(&mut usage, llm_response.usage);
            finish_reason = llm_response.finish_reason;

            let tool_requests = tool_calls_from_response(
                llm_response.tool_calls,
                &llm_response.content,
                &run_id,
                iteration,
            );
            if tool_requests.is_empty() {
                final_content = Some(llm_response.content);
                break;
            }

            if iteration >= self.max_tool_iterations {
                let message = "工具调用次数超过限制，已停止继续执行。".to_string();
                event_stream.emit(AgentEvent::Error {
                    run_id: Some(run_id.clone()),
                    message: message.clone(),
                    recoverable: false,
                });
                final_content = Some(message);
                break;
            }

            messages.push(LlmMessage::assistant(
                llm_response.content.clone(),
                tool_requests.clone(),
            ));

            for tool_request in tool_requests {
                let tool_name = tool_request.name;
                let tool_args = tool_request.args;
                let reason = extract_reason_from_args(&tool_args);
                let requires_approval = tool_registry
                    .definition_for(&tool_name)
                    .map(|definition| definition.requires_approval)
                    .unwrap_or(false);
                let call = AgentToolCall {
                    id: tool_request.id,
                    tool: tool_name,
                    args: tool_args,
                    approval_status: if requires_approval {
                        AgentApprovalStatus::Required
                    } else {
                        AgentApprovalStatus::NotRequired
                    },
                    reason: reason.or_else(|| Some("agent requested tool call".to_string())),
                };
                event_stream.emit(AgentEvent::ToolCall {
                    run_id: run_id.clone(),
                    call: call.clone(),
                });

                if requires_approval {
                    let action = tool_registry.proposed_action(&call)?;
                    if let AgentProposedAction::Diff { diff } = &action {
                        event_stream.emit(AgentEvent::Diff {
                            run_id: run_id.clone(),
                            diff: diff.clone(),
                        });
                    }
                    event_stream.emit(AgentEvent::ApprovalRequired {
                        run_id: run_id.clone(),
                        action: action.clone(),
                    });
                    let content = build_approval_required_message(&action);
                    event_stream.emit(AgentEvent::MessageDelta {
                        run_id: run_id.clone(),
                        delta: content.clone(),
                    });
                    event_stream.emit(state_event(
                        &run_id,
                        AgentRunStatus::WaitingForApproval,
                        Some(run_id.clone()),
                        None,
                    ));
                    event_stream.emit(done_event(
                        &run_id,
                        true,
                        AgentRunStatus::WaitingForApproval,
                        Some(content.clone()),
                        usage.clone(),
                        finish_reason.clone(),
                        vec![action.clone()],
                    ));

                    return Ok(AgentChatOutput {
                        content,
                        status: AgentRunStatus::WaitingForApproval,
                        run_id,
                        events: event_stream.into_events(),
                        tool_definitions,
                        usage,
                        finish_reason,
                        proposed_actions: vec![action],
                    });
                }

                let result = tool_registry.execute(&tool_context, &call);
                event_stream.emit(AgentEvent::ToolResult {
                    run_id: run_id.clone(),
                    result: result.clone(),
                });

                messages.push(LlmMessage::tool_result(
                    call.id,
                    build_tool_observation_message(&result),
                    !result.ok,
                ));
            }
        }

        let content = final_content.unwrap_or_else(|| "没有生成可显示的回复。".to_string());
        event_stream.emit(AgentEvent::MessageDelta {
            run_id: run_id.clone(),
            delta: content.clone(),
        });
        event_stream.emit(state_event(&run_id, AgentRunStatus::Completed, None, None));
        event_stream.emit(done_event(
            &run_id,
            true,
            AgentRunStatus::Completed,
            Some(content.clone()),
            usage.clone(),
            finish_reason.clone(),
            Vec::new(),
        ));

        Ok(AgentChatOutput {
            content,
            status: AgentRunStatus::Completed,
            run_id,
            events: event_stream.into_events(),
            tool_definitions,
            usage,
            finish_reason,
            proposed_actions: Vec::<AgentProposedAction>::new(),
        })
    }
}

struct AgentEventStream {
    events: Vec<AgentEvent>,
    emitter: Option<AgentEventEmitter>,
}

impl AgentEventStream {
    fn new(emitter: Option<AgentEventEmitter>) -> Self {
        Self {
            events: Vec::new(),
            emitter,
        }
    }

    fn emit(&mut self, event: AgentEvent) {
        if let Some(emitter) = &self.emitter {
            emitter(event.clone());
        }
        self.events.push(event);
    }

    fn into_events(self) -> Vec<AgentEvent> {
        self.events
    }
}

fn build_llm_request(
    input: AgentChatInput,
    tool_definitions: &[AgentToolDefinition],
) -> AgentResult<LlmChatRequest> {
    let api_style = input
        .api_style
        .unwrap_or_else(|| detect_api_style(input.api_url.trim()));
    let mode = input.mode.unwrap_or(AgentRunMode::Chat);
    let messages = build_runtime_messages(
        input.messages,
        mode,
        input.context.as_ref(),
        input.approval_decision.as_ref(),
        tool_definitions,
    )?;

    Ok(LlmChatRequest {
        api_url: input.api_url.trim().to_string(),
        api_token: input.api_token.trim().to_string(),
        model: input.model.trim().to_string(),
        api_style,
        max_tokens: sanitize_max_tokens(input.max_tokens),
        temperature: sanitize_temperature(input.temperature),
        messages,
        tools: tool_definitions.to_vec(),
    })
}

fn build_runtime_messages(
    messages: Vec<AgentChatMessage>,
    mode: AgentRunMode,
    context: Option<&AgentRunContext>,
    approval_decision: Option<&AgentApprovalDecision>,
    tool_definitions: &[AgentToolDefinition],
) -> AgentResult<Vec<LlmMessage>> {
    let mut normalized = normalize_messages(messages)?;

    if normalized.is_empty() {
        return Err(AgentError::new("没有可发送的对话内容。"));
    }

    if !normalized.iter().any(|message| message.role != "system") {
        return Err(AgentError::new("对话里缺少用户或助手消息。"));
    }

    if let Some(approval_decision) = approval_decision {
        normalized.push(AgentChatMessage {
            role: "user".to_string(),
            content: build_approval_decision_observation(approval_decision),
        });
    }

    let mut runtime_messages = normalized
        .into_iter()
        .map(agent_message_to_llm_message)
        .collect::<AgentResult<Vec<_>>>()?;

    runtime_messages.insert(
        0,
        LlmMessage::text(
            LlmMessageRole::System,
            build_system_prompt(mode, context, tool_definitions),
        ),
    );

    Ok(runtime_messages)
}

fn agent_message_to_llm_message(message: AgentChatMessage) -> AgentResult<LlmMessage> {
    let role = match message.role.as_str() {
        "system" => LlmMessageRole::System,
        "user" => LlmMessageRole::User,
        "assistant" => LlmMessageRole::Assistant,
        _ => {
            return Err(AgentError::new(format!(
                "不支持的消息角色：{}",
                message.role
            )))
        }
    };

    Ok(LlmMessage::text(role, message.content))
}

fn normalize_messages(messages: Vec<AgentChatMessage>) -> AgentResult<Vec<AgentChatMessage>> {
    let mut normalized = Vec::new();

    for message in messages {
        let role = message.role.trim();
        let content = message.content.trim();

        if content.is_empty() {
            continue;
        }

        match role {
            "system" | "user" | "assistant" => normalized.push(AgentChatMessage {
                role: role.to_string(),
                content: content.to_string(),
            }),
            _ => return Err(AgentError::new(format!("不支持的消息角色：{role}"))),
        }
    }

    Ok(normalized)
}

fn build_system_prompt(
    mode: AgentRunMode,
    context: Option<&AgentRunContext>,
    tool_definitions: &[AgentToolDefinition],
) -> String {
    let mode_label = match mode {
        AgentRunMode::Chat => "chat",
        AgentRunMode::Plan => "plan",
        AgentRunMode::Edit => "edit",
    };
    let has_workspace = context
        .and_then(|context| context.workspace.as_ref())
        .is_some();
    let workspace_note = if has_workspace {
        "当前已有用户选择的工作区。不要假装已经读取文件；只有在后续工具结果提供文件内容后，才能声称了解具体文件。"
    } else {
        "当前没有可用的工作区上下文。需要文件内容时，先说明需要通过受控工具读取。"
    };
    let tools = format_tool_definitions(tool_definitions);

    format!(
        "你是 MyCopilot 的后端 coding agent，运行模式是 {mode_label}。\n\
        {workspace_note}\n\
        你可以通过模型 API 的原生 tool/function calling 使用下列工具理解用户已选择的 workspace、公开网页信息，或请求用户批准危险动作：\n\
        {tools}\n\
        如果需要调用工具，必须使用原生 tool/function calling，不要手写 JSON tool_call 文本。\n\
        工具返回后你会收到 tool result，然后再继续推理并给出最终回答。\n\
        对 requiresApproval=true 的工具，只能提出请求；用户批准前不能声称已经执行。\n\
        如果收到 approval_decision observation，必须遵守用户的拒绝理由或改法要求，不要重复提出完全相同的请求。\n\
        你可以解释代码、制定计划、提出补丁或命令，但不能声称已经执行文件读写、命令、Git 操作或安装依赖。\n\
        任何写文件、应用 patch、运行命令、安装依赖、Git 修改类操作，都必须作为待确认动作交给 Tauri/Rust 层执行。\n\
        回答要直接、可执行；如果提出修改，优先用清晰的 diff/patch 或分步骤计划表达。"
    )
}

fn format_tool_definitions(tool_definitions: &[AgentToolDefinition]) -> String {
    tool_definitions
        .iter()
        .map(|definition| {
            format!(
                "- {}: {} requiresWorkspace={} requiresApproval={}",
                definition.name,
                definition.description,
                definition.requires_workspace,
                definition.requires_approval
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Debug)]
struct ToolCallRequest {
    tool: String,
    args: Value,
}

#[derive(Debug, Deserialize)]
struct ToolCallEnvelope {
    #[serde(rename = "type")]
    kind: Option<String>,
    tool: Option<String>,
    args: Option<Value>,
    call: Option<NestedToolCallEnvelope>,
}

#[derive(Debug, Deserialize)]
struct NestedToolCallEnvelope {
    tool: String,
    args: Option<Value>,
}

fn parse_tool_call_request(content: &str) -> Option<ToolCallRequest> {
    let value = extract_json_value(content)?;
    let envelope: ToolCallEnvelope = serde_json::from_value(value).ok()?;
    let kind = envelope.kind.as_deref().unwrap_or("tool_call");
    if kind != "tool_call" {
        return None;
    }

    if let Some(call) = envelope.call {
        return Some(ToolCallRequest {
            tool: call.tool,
            args: call.args.unwrap_or_else(|| json!({})),
        });
    }

    envelope.tool.map(|tool| ToolCallRequest {
        tool,
        args: envelope.args.unwrap_or_else(|| json!({})),
    })
}

fn tool_calls_from_response(
    native_tool_calls: Vec<LlmToolCall>,
    content: &str,
    run_id: &str,
    iteration: usize,
) -> Vec<LlmToolCall> {
    if !native_tool_calls.is_empty() {
        return native_tool_calls;
    }

    parse_tool_call_request(content)
        .map(|request| {
            vec![LlmToolCall {
                id: format!("tool-{run_id}-{}", iteration + 1),
                name: request.tool,
                args: request.args,
            }]
        })
        .unwrap_or_default()
}

fn extract_json_value(content: &str) -> Option<Value> {
    let trimmed = content.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return Some(value);
    }

    if let Some(stripped) = strip_json_code_fence(trimmed) {
        if let Ok(value) = serde_json::from_str::<Value>(stripped.trim()) {
            return Some(value);
        }
    }

    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    if end <= start {
        return None;
    }

    serde_json::from_str::<Value>(&trimmed[start..=end]).ok()
}

fn strip_json_code_fence(content: &str) -> Option<&str> {
    let without_start = content
        .strip_prefix("```json")
        .or_else(|| content.strip_prefix("```"))?;
    without_start.strip_suffix("```")
}

fn build_tool_observation_message(result: &AgentToolResult) -> String {
    let payload = if result.ok {
        json!({
            "type": "tool_result",
            "tool": result.tool,
            "callId": result.call_id,
            "ok": true,
            "result": result.result
        })
    } else {
        json!({
            "type": "tool_result",
            "tool": result.tool,
            "callId": result.call_id,
            "ok": false,
            "error": result.error
        })
    };
    let payload = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string());

    format!(
        "Tool result observation. Use this result to continue. Do not repeat the same tool call unless more information is needed.\n```json\n{payload}\n```"
    )
}

fn build_approval_decision_observation(decision: &AgentApprovalDecision) -> String {
    let status = match decision.status {
        AgentApprovalDecisionStatus::Approved => "approved",
        AgentApprovalDecisionStatus::Rejected => "rejected",
    };
    let payload = json!({
        "type": "approval_decision",
        "actionId": decision.action_id,
        "status": status,
        "message": decision.message
    });
    let payload = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string());

    format!(
        "Approval decision observation. If rejected, respect the user's reason or requested alternative before continuing.\n```json\n{payload}\n```"
    )
}

fn build_approval_required_message(action: &AgentProposedAction) -> String {
    match action {
        AgentProposedAction::Command { command } => {
            let mut lines = vec![
                "需要审批后才能运行命令。".to_string(),
                format!("命令：`{}`", command.command),
            ];
            if let Some(cwd) = &command.cwd {
                lines.push(format!("工作目录：`{cwd}`"));
            }
            if let Some(timeout_ms) = command.timeout_ms {
                lines.push(format!("超时：{timeout_ms} ms"));
            }
            if let Some(risk_level) = command.risk_level {
                lines.push(format!("风险级别：{}", command_risk_label(risk_level)));
            }
            if let Some(reason) = &command.reason {
                lines.push(format!("原因：{reason}"));
            }
            lines.push("你可以批准执行，也可以拒绝并说明原因或要求换一种做法。".to_string());
            lines.join("\n")
        }
        AgentProposedAction::ToolCall { call } => format!(
            "工具 `{}` 需要审批后才能执行。你可以批准，也可以拒绝并说明原因或要求换一种做法。",
            call.tool
        ),
        AgentProposedAction::Diff { diff } => format!(
            "文件 `{}` 的修改需要审批后才能应用。\n{}\n你可以批准，也可以拒绝并说明原因或要求换一种做法。",
            diff.file_path,
            diff.summary
                .as_deref()
                .map(|summary| format!("摘要：{summary}"))
                .unwrap_or_else(|| "摘要：未提供".to_string())
        ),
    }
}

fn command_risk_label(risk_level: AgentCommandRiskLevel) -> &'static str {
    match risk_level {
        AgentCommandRiskLevel::ReadOnly => "read_only",
        AgentCommandRiskLevel::WritesWorkspace => "writes_workspace",
        AgentCommandRiskLevel::Network => "network",
        AgentCommandRiskLevel::Destructive => "destructive",
        AgentCommandRiskLevel::Unknown => "unknown",
    }
}

fn extract_reason_from_args(args: &Value) -> Option<String> {
    args.get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .map(ToString::to_string)
}

fn merge_usage(total: &mut Option<AgentUsage>, next: Option<AgentUsage>) {
    let Some(next) = next else {
        return;
    };

    match total {
        Some(total) => {
            total.input_tokens = sum_optional(total.input_tokens, next.input_tokens);
            total.output_tokens = sum_optional(total.output_tokens, next.output_tokens);
            total.total_tokens = sum_optional(total.total_tokens, next.total_tokens);
        }
        None => *total = Some(next),
    }
}

fn sum_optional(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left + right),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

fn sanitize_max_tokens(max_tokens: Option<u32>) -> u32 {
    max_tokens
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_TOKENS)
        .min(MAX_MAX_TOKENS)
}

fn sanitize_temperature(temperature: Option<f32>) -> f32 {
    match temperature {
        Some(value) if value.is_finite() => value.clamp(0.0, 2.0),
        _ => DEFAULT_TEMPERATURE,
    }
}

fn state_event(
    run_id: &str,
    status: AgentRunStatus,
    active_run_id: Option<String>,
    last_error: Option<String>,
) -> AgentEvent {
    AgentEvent::State {
        run_id: run_id.to_string(),
        state: AgentStateSnapshot {
            status,
            active_run_id,
            last_error,
            updated_at: now_ms(),
        },
    }
}

fn done_event(
    run_id: &str,
    success: bool,
    status: AgentRunStatus,
    content: Option<String>,
    usage: Option<AgentUsage>,
    finish_reason: Option<String>,
    proposed_actions: Vec<AgentProposedAction>,
) -> AgentEvent {
    AgentEvent::Done {
        run_id: run_id.to_string(),
        success,
        status: Some(status),
        content,
        usage,
        finish_reason,
        proposed_actions,
    }
}

fn generate_run_id() -> String {
    let counter = RUN_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("run-{}-{counter}", now_ms())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{AgentRunContext, AgentWorkspaceContext};

    fn message(role: &str, content: &str) -> AgentChatMessage {
        AgentChatMessage {
            role: role.to_string(),
            content: content.to_string(),
        }
    }

    #[test]
    fn normalizes_supported_messages_and_skips_empty_content() {
        let messages = normalize_messages(vec![
            message(" user ", " hello "),
            message("assistant", " "),
            message("system", "rules"),
        ])
        .unwrap();

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, "hello");
    }

    #[test]
    fn runtime_messages_add_backend_system_prompt() {
        let context = AgentRunContext {
            conversation_id: Some("conversation-1".to_string()),
            project_id: Some("project-1".to_string()),
            workspace: Some(AgentWorkspaceContext {
                project_id: Some("project-1".to_string()),
                display_name: Some("Workspace".to_string()),
                root_path: Some("/private/path".to_string()),
            }),
        };
        let messages = build_runtime_messages(
            vec![message("user", "Read src/main.rs")],
            AgentRunMode::Chat,
            Some(&context),
            None,
            &ToolRegistry::read_only_defaults_with_search(None).definitions(),
        )
        .unwrap();

        assert_eq!(messages[0].role.as_str(), "system");
        assert!(messages[0].content.contains("MyCopilot"));
        assert!(!messages[0].content.contains("/private/path"));
        assert_eq!(messages[1].role.as_str(), "user");
    }

    #[test]
    fn runtime_messages_include_approval_decision_observation() {
        let decision = AgentApprovalDecision {
            action_id: "tool-1".to_string(),
            status: AgentApprovalDecisionStatus::Rejected,
            message: Some("不要运行安装命令，先说明替代方案。".to_string()),
        };
        let messages = build_runtime_messages(
            vec![message("user", "Run pnpm install")],
            AgentRunMode::Chat,
            None,
            Some(&decision),
            &ToolRegistry::read_only_defaults_with_search(None).definitions(),
        )
        .unwrap();

        assert!(messages
            .iter()
            .any(|message| message.content.contains("approval_decision")
                && message.content.contains("不要运行安装命令")));
    }

    #[test]
    fn rejects_unknown_message_roles() {
        let error = normalize_messages(vec![message("tool", "result")]).unwrap_err();
        assert!(error.to_string().contains("不支持的消息角色"));
    }

    #[test]
    fn parses_plain_and_fenced_tool_calls() {
        let plain = parse_tool_call_request(
            r#"{"type":"tool_call","tool":"search_files","args":{"query":"main"}}"#,
        )
        .unwrap();
        let fenced = parse_tool_call_request(
            "```json\n{\"type\":\"tool_call\",\"tool\":\"read_file\",\"args\":{\"path\":\"src/lib.rs\"}}\n```",
        )
        .unwrap();

        assert_eq!(plain.tool, "search_files");
        assert_eq!(plain.args["query"], "main");
        assert_eq!(fenced.tool, "read_file");
        assert_eq!(fenced.args["path"], "src/lib.rs");
    }
}
