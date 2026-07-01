use crate::llm::{complete_chat, detect_api_style, LlmChatRequest};
use crate::protocol::{
    AgentApprovalStatus, AgentChatInput, AgentChatMessage, AgentChatOutput, AgentError, AgentEvent,
    AgentProposedAction, AgentResult, AgentRunContext, AgentRunMode, AgentRunStatus,
    AgentStateSnapshot, AgentToolCall, AgentToolDefinition, AgentToolResult, AgentUsage,
};
use crate::tools::{ToolExecutionContext, ToolRegistry};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_MAX_TOKENS: u32 = 1024;
const MAX_MAX_TOKENS: u32 = 128_000;
const DEFAULT_TEMPERATURE: f32 = 0.6;
const MAX_TOOL_ITERATIONS: usize = 4;

static RUN_COUNTER: AtomicU64 = AtomicU64::new(1);

pub async fn send_chat(input: AgentChatInput) -> AgentResult<AgentChatOutput> {
    AgentRuntime::default().send_chat(input).await
}

pub struct AgentRuntime {
    tool_registry: ToolRegistry,
    max_tool_iterations: usize,
}

impl Default for AgentRuntime {
    fn default() -> Self {
        Self {
            tool_registry: ToolRegistry::read_only_defaults(),
            max_tool_iterations: MAX_TOOL_ITERATIONS,
        }
    }
}

impl AgentRuntime {
    pub async fn send_chat(&self, input: AgentChatInput) -> AgentResult<AgentChatOutput> {
        let run_id = generate_run_id();
        let context = input.context.clone();
        let tool_definitions = self.tool_registry.definitions();
        let llm_request = build_llm_request(input, &tool_definitions)?;
        let mut messages = llm_request.messages;
        let tool_context = ToolExecutionContext::from_run_context(context.as_ref());
        let mut events = vec![state_event(
            &run_id,
            AgentRunStatus::Running,
            Some(run_id.clone()),
            None,
        )];
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
            })
            .await?;

            merge_usage(&mut usage, llm_response.usage);
            finish_reason = llm_response.finish_reason;

            let Some(tool_request) = parse_tool_call_request(&llm_response.content) else {
                final_content = Some(llm_response.content);
                break;
            };

            if iteration >= self.max_tool_iterations {
                let message = "工具调用次数超过限制，已停止继续执行。".to_string();
                events.push(AgentEvent::Error {
                    run_id: Some(run_id.clone()),
                    message: message.clone(),
                    recoverable: false,
                });
                final_content = Some(message);
                break;
            }

            let call = AgentToolCall {
                id: format!("tool-{run_id}-{}", iteration + 1),
                tool: tool_request.tool,
                args: tool_request.args,
                approval_status: AgentApprovalStatus::NotRequired,
                reason: Some("read-only harness tool".to_string()),
            };
            events.push(AgentEvent::ToolCall {
                run_id: run_id.clone(),
                call: call.clone(),
            });

            let result = self.tool_registry.execute(&tool_context, &call);
            events.push(AgentEvent::ToolResult {
                run_id: run_id.clone(),
                result: result.clone(),
            });

            messages.push(AgentChatMessage {
                role: "assistant".to_string(),
                content: llm_response.content,
            });
            messages.push(AgentChatMessage {
                role: "user".to_string(),
                content: build_tool_observation_message(&result),
            });
        }

        let content = final_content.unwrap_or_else(|| "没有生成可显示的回复。".to_string());
        events.push(AgentEvent::MessageDelta {
            run_id: run_id.clone(),
            delta: content.clone(),
        });
        events.push(state_event(&run_id, AgentRunStatus::Completed, None, None));
        events.push(AgentEvent::Done {
            run_id: run_id.clone(),
            success: true,
        });

        Ok(AgentChatOutput {
            content,
            status: AgentRunStatus::Completed,
            run_id,
            events,
            tool_definitions,
            usage,
            finish_reason,
            proposed_actions: Vec::<AgentProposedAction>::new(),
        })
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
    })
}

fn build_runtime_messages(
    messages: Vec<AgentChatMessage>,
    mode: AgentRunMode,
    context: Option<&AgentRunContext>,
    tool_definitions: &[AgentToolDefinition],
) -> AgentResult<Vec<AgentChatMessage>> {
    let mut normalized = normalize_messages(messages)?;

    if normalized.is_empty() {
        return Err(AgentError::new("没有可发送的对话内容。"));
    }

    if !normalized.iter().any(|message| message.role != "system") {
        return Err(AgentError::new("对话里缺少用户或助手消息。"));
    }

    normalized.insert(
        0,
        AgentChatMessage {
            role: "system".to_string(),
            content: build_system_prompt(mode, context, tool_definitions),
        },
    );

    Ok(normalized)
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
        你可以使用下列只读工具理解用户已选择的 workspace：\n\
        {tools}\n\
        如果需要调用工具，只能回复一个 JSON 对象，不要添加解释文字：\n\
        {{\"type\":\"tool_call\",\"tool\":\"search_files\",\"args\":{{\"query\":\"main\"}}}}\n\
        工具返回后你会收到 tool_result observation，然后再继续推理并给出最终回答。\n\
        你可以解释代码、制定计划、提出补丁或命令，但不能声称已经执行文件读写、命令、Git 操作或安装依赖。\n\
        任何写文件、应用 patch、运行命令、安装依赖、Git 修改类操作，都必须作为待确认动作交给 Tauri/Rust 层执行。\n\
        回答要直接、可执行；如果提出修改，优先用清晰的 diff/patch 或分步骤计划表达。"
    )
}

fn format_tool_definitions(tool_definitions: &[AgentToolDefinition]) -> String {
    tool_definitions
        .iter()
        .map(|definition| {
            let schema = serde_json::to_string(&definition.input_schema)
                .unwrap_or_else(|_| "{}".to_string());
            format!(
                "- {}: {} input_schema={}",
                definition.name, definition.description, schema
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
            &ToolRegistry::read_only_defaults().definitions(),
        )
        .unwrap();

        assert_eq!(messages[0].role, "system");
        assert!(messages[0].content.contains("MyCopilot"));
        assert!(!messages[0].content.contains("/private/path"));
        assert_eq!(messages[1].role, "user");
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
