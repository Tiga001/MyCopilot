use crate::protocol::{AgentApiStyle, AgentError, AgentResult, AgentToolDefinition, AgentUsage};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Map, Value};
use std::time::Duration;

#[derive(Debug, Clone)]
pub(crate) struct LlmChatRequest {
    pub api_url: String,
    pub api_token: String,
    pub model: String,
    pub api_style: AgentApiStyle,
    pub max_tokens: u32,
    pub temperature: f32,
    pub messages: Vec<LlmMessage>,
    pub tools: Vec<AgentToolDefinition>,
}

#[derive(Debug, Clone)]
pub(crate) struct LlmChatResponse {
    pub content: String,
    pub tool_calls: Vec<LlmToolCall>,
    pub usage: Option<AgentUsage>,
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct LlmMessage {
    pub role: LlmMessageRole,
    pub content: String,
    pub images: Vec<LlmImage>,
    pub tool_call_id: Option<String>,
    pub tool_calls: Vec<LlmToolCall>,
    pub is_error: bool,
}

impl LlmMessage {
    pub(crate) fn text(role: LlmMessageRole, content: impl Into<String>) -> Self {
        Self {
            role,
            content: content.into(),
            images: Vec::new(),
            tool_call_id: None,
            tool_calls: Vec::new(),
            is_error: false,
        }
    }

    pub(crate) fn assistant(content: impl Into<String>, tool_calls: Vec<LlmToolCall>) -> Self {
        Self {
            role: LlmMessageRole::Assistant,
            content: content.into(),
            images: Vec::new(),
            tool_call_id: None,
            tool_calls,
            is_error: false,
        }
    }

    pub(crate) fn tool_result(
        tool_call_id: impl Into<String>,
        content: impl Into<String>,
        is_error: bool,
    ) -> Self {
        Self {
            role: LlmMessageRole::Tool,
            content: content.into(),
            images: Vec::new(),
            tool_call_id: Some(tool_call_id.into()),
            tool_calls: Vec::new(),
            is_error,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LlmMessageRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone)]
pub(crate) struct LlmImage {
    pub mime_type: String,
    pub data_base64: String,
}

impl LlmMessageRole {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::Tool => "tool",
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct LlmToolCall {
    pub id: String,
    pub name: String,
    pub args: Value,
}

pub(crate) async fn complete_chat(request: LlmChatRequest) -> AgentResult<LlmChatResponse> {
    let api_url = request.api_url.trim();
    let api_token = request.api_token.trim();
    let model = request.model.trim();

    if api_url.is_empty() {
        return Err(AgentError::new("请先在设置 > 配置里填写 API URL。"));
    }

    if api_token.is_empty() {
        return Err(AgentError::new("请先在设置 > 配置里填写 API Token。"));
    }

    if model.is_empty() {
        return Err(AgentError::new("请选择一个可用模型。"));
    }

    if request.messages.is_empty() {
        return Err(AgentError::new("没有可发送的对话内容。"));
    }

    let payload = build_payload(&request);
    let headers = build_headers(request.api_style, api_token)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| AgentError::new(format!("创建 HTTP 客户端失败：{error}")))?;

    let response = client
        .post(api_url)
        .headers(headers)
        .json(&payload)
        .send()
        .await
        .map_err(|error| AgentError::new(format!("请求模型接口失败：{error}")))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| AgentError::new(format!("读取模型响应失败：{error}")))?;

    if !status.is_success() {
        return Err(AgentError::new(format!(
            "模型接口返回 {}：{}",
            status.as_u16(),
            truncate_for_error(&body)
        )));
    }

    let value: Value = serde_json::from_str(&body).map_err(|error| {
        AgentError::new(format!(
            "模型响应不是有效 JSON：{error}；原始响应：{}",
            truncate_for_error(&body)
        ))
    })?;

    let tool_calls = extract_tool_calls(&value, request.api_style)?;
    let content = extract_response_text(&value).unwrap_or_default();

    if content.trim().is_empty() && tool_calls.is_empty() {
        return Err(AgentError::new(format!(
            "模型响应里没有可显示文本：{}",
            truncate_for_error(&body)
        )));
    }

    Ok(LlmChatResponse {
        content,
        tool_calls,
        usage: extract_usage(&value),
        finish_reason: extract_finish_reason(&value),
    })
}

pub(crate) fn detect_api_style(api_url: &str) -> AgentApiStyle {
    let normalized = api_url.to_ascii_lowercase();

    if normalized.contains("/chat/completions") {
        return AgentApiStyle::OpenAiCompatible;
    }

    if normalized.contains("anthropic") || normalized.ends_with("/messages") {
        return AgentApiStyle::AnthropicCompatible;
    }

    AgentApiStyle::OpenAiCompatible
}

fn build_payload(request: &LlmChatRequest) -> Value {
    match request.api_style {
        AgentApiStyle::OpenAiCompatible => {
            let mut payload = Map::from_iter([
                ("model".to_string(), json!(request.model)),
                (
                    "messages".to_string(),
                    Value::Array(build_openai_messages(&request.messages)),
                ),
                ("stream".to_string(), json!(false)),
                ("max_tokens".to_string(), json!(request.max_tokens)),
                ("temperature".to_string(), json!(request.temperature)),
            ]);

            if !request.tools.is_empty() {
                payload.insert(
                    "tools".to_string(),
                    Value::Array(build_openai_tools(&request.tools)),
                );
                payload.insert("tool_choice".to_string(), json!("auto"));
            }

            Value::Object(payload)
        }
        AgentApiStyle::AnthropicCompatible => {
            let (system, messages) = split_anthropic_messages(&request.messages);
            let mut payload = Map::from_iter([
                ("model".to_string(), json!(request.model)),
                ("max_tokens".to_string(), json!(request.max_tokens)),
                ("temperature".to_string(), json!(request.temperature)),
                ("messages".to_string(), json!(messages)),
            ]);

            if let Some(system) = system {
                payload.insert("system".to_string(), json!(system));
            }
            if !request.tools.is_empty() {
                payload.insert(
                    "tools".to_string(),
                    Value::Array(build_anthropic_tools(&request.tools)),
                );
            }

            Value::Object(payload)
        }
    }
}

fn build_openai_messages(messages: &[LlmMessage]) -> Vec<Value> {
    messages
        .iter()
        .map(|message| match message.role {
            LlmMessageRole::System => json!({ "role": "system", "content": message.content }),
            LlmMessageRole::User => json!({
                "role": "user",
                "content": build_openai_user_content(message)
            }),
            LlmMessageRole::Assistant => {
                let mut object = Map::from_iter([(
                    "role".to_string(),
                    Value::String(message.role.as_str().to_string()),
                )]);
                if message.tool_calls.is_empty() {
                    object.insert("content".to_string(), json!(message.content));
                } else {
                    object.insert(
                        "content".to_string(),
                        if message.content.trim().is_empty() {
                            Value::Null
                        } else {
                            json!(message.content)
                        },
                    );
                    object.insert(
                        "tool_calls".to_string(),
                        Value::Array(build_openai_tool_calls(&message.tool_calls)),
                    );
                }
                Value::Object(object)
            }
            LlmMessageRole::Tool => json!({
                "role": "tool",
                "tool_call_id": message.tool_call_id.as_deref().unwrap_or_default(),
                "content": message.content
            }),
        })
        .collect()
}

fn build_openai_user_content(message: &LlmMessage) -> Value {
    if message.images.is_empty() {
        return json!(message.content);
    }

    let mut parts = Vec::new();
    if !message.content.trim().is_empty() {
        parts.push(json!({
            "type": "text",
            "text": message.content
        }));
    }
    parts.extend(message.images.iter().map(|image| {
        json!({
            "type": "image_url",
            "image_url": {
                "url": format!("data:{};base64,{}", image.mime_type, image.data_base64)
            }
        })
    }));

    Value::Array(parts)
}

fn build_openai_tools(tools: &[AgentToolDefinition]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            json!({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": normalize_json_schema(&tool.input_schema)
                }
            })
        })
        .collect()
}

fn build_openai_tool_calls(tool_calls: &[LlmToolCall]) -> Vec<Value> {
    tool_calls
        .iter()
        .map(|call| {
            json!({
                "id": call.id,
                "type": "function",
                "function": {
                    "name": call.name,
                    "arguments": serde_json::to_string(&call.args).unwrap_or_else(|_| "{}".to_string())
                }
            })
        })
        .collect()
}

fn split_anthropic_messages(messages: &[LlmMessage]) -> (Option<String>, Vec<Value>) {
    let mut system_parts = Vec::new();
    let mut chat_messages = Vec::new();

    for message in messages {
        match message.role {
            LlmMessageRole::System => system_parts.push(message.content.as_str()),
            LlmMessageRole::User => {
                let mut blocks = Vec::new();
                if !message.content.trim().is_empty() {
                    blocks.push(json!({ "type": "text", "text": message.content }));
                }
                blocks.extend(message.images.iter().map(|image| {
                    json!({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": image.mime_type,
                            "data": image.data_base64
                        }
                    })
                }));
                push_anthropic_message(&mut chat_messages, "user", blocks);
            }
            LlmMessageRole::Assistant => {
                let mut blocks = Vec::new();
                if !message.content.trim().is_empty() {
                    blocks.push(json!({ "type": "text", "text": message.content }));
                }
                blocks.extend(message.tool_calls.iter().map(|call| {
                    json!({
                        "type": "tool_use",
                        "id": call.id,
                        "name": call.name,
                        "input": call.args
                    })
                }));
                push_anthropic_message(&mut chat_messages, "assistant", blocks);
            }
            LlmMessageRole::Tool => {
                push_anthropic_message(
                    &mut chat_messages,
                    "user",
                    vec![json!({
                        "type": "tool_result",
                        "tool_use_id": message.tool_call_id.as_deref().unwrap_or_default(),
                        "content": message.content,
                        "is_error": message.is_error
                    })],
                );
            }
        }
    }

    let system = if system_parts.is_empty() {
        None
    } else {
        Some(system_parts.join("\n\n"))
    };

    (system, chat_messages)
}

fn push_anthropic_message(messages: &mut Vec<Value>, role: &str, content_blocks: Vec<Value>) {
    if content_blocks.is_empty() {
        return;
    }

    if let Some(last) = messages.last_mut() {
        let same_role = last
            .get("role")
            .and_then(Value::as_str)
            .map(|value| value == role)
            .unwrap_or(false);
        if same_role {
            if let Some(content) = last.get_mut("content").and_then(Value::as_array_mut) {
                content.extend(content_blocks);
                return;
            }
        }
    }

    messages.push(json!({
        "role": role,
        "content": content_blocks
    }));
}

fn build_anthropic_tools(tools: &[AgentToolDefinition]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "description": tool.description,
                "input_schema": normalize_json_schema(&tool.input_schema)
            })
        })
        .collect()
}

fn normalize_json_schema(schema: &Value) -> Value {
    match schema {
        Value::Object(_) => schema.clone(),
        _ => json!({ "type": "object", "properties": {} }),
    }
}

fn build_headers(api_style: AgentApiStyle, api_token: &str) -> AgentResult<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

    match api_style {
        AgentApiStyle::OpenAiCompatible => {
            let bearer = format!("Bearer {api_token}");
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&bearer)
                    .map_err(|_| AgentError::new("API Token 包含非法字符。"))?,
            );
        }
        AgentApiStyle::AnthropicCompatible => {
            headers.insert(
                "x-api-key",
                HeaderValue::from_str(api_token)
                    .map_err(|_| AgentError::new("API Token 包含非法字符。"))?,
            );
            headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        }
    }

    Ok(headers)
}

fn extract_response_text(value: &Value) -> Option<String> {
    if let Some(text) = value.get("content").and_then(extract_content_text) {
        return Some(text);
    }

    if let Some(text) = value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(extract_content_text)
    {
        return Some(text);
    }

    if let Some(text) = value.get("completion").and_then(Value::as_str) {
        return Some(text.to_string());
    }

    let choice = value.get("choices")?.as_array()?.first()?;

    if let Some(text) = choice
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(extract_content_text)
    {
        return Some(text);
    }

    choice
        .get("text")
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn extract_content_text(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }

    let parts = content.as_array()?;
    let text = parts
        .iter()
        .filter_map(|part| {
            part.get("text")
                .and_then(Value::as_str)
                .or_else(|| part.get("content").and_then(Value::as_str))
        })
        .collect::<Vec<_>>()
        .join("");

    Some(text)
}

fn extract_usage(value: &Value) -> Option<AgentUsage> {
    let usage = value.get("usage")?;
    let input_tokens = usage
        .get("prompt_tokens")
        .or_else(|| usage.get("input_tokens"))
        .and_then(Value::as_u64);
    let output_tokens = usage
        .get("completion_tokens")
        .or_else(|| usage.get("output_tokens"))
        .and_then(Value::as_u64);
    let total_tokens = usage
        .get("total_tokens")
        .and_then(Value::as_u64)
        .or_else(|| match (input_tokens, output_tokens) {
            (Some(input), Some(output)) => Some(input + output),
            _ => None,
        });

    if input_tokens.is_none() && output_tokens.is_none() && total_tokens.is_none() {
        return None;
    }

    Some(AgentUsage {
        input_tokens,
        output_tokens,
        total_tokens,
    })
}

fn extract_finish_reason(value: &Value) -> Option<String> {
    if let Some(reason) = value.get("stop_reason").and_then(Value::as_str) {
        return Some(reason.to_string());
    }

    let choice = value.get("choices")?.as_array()?.first()?;
    choice
        .get("finish_reason")
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn extract_tool_calls(value: &Value, api_style: AgentApiStyle) -> AgentResult<Vec<LlmToolCall>> {
    match api_style {
        AgentApiStyle::OpenAiCompatible => extract_openai_tool_calls(value),
        AgentApiStyle::AnthropicCompatible => extract_anthropic_tool_calls(value),
    }
}

fn extract_openai_tool_calls(value: &Value) -> AgentResult<Vec<LlmToolCall>> {
    let Some(calls) = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("tool_calls"))
        .and_then(Value::as_array)
    else {
        return Ok(Vec::new());
    };

    calls
        .iter()
        .enumerate()
        .map(|(index, call)| {
            let function = call
                .get("function")
                .ok_or_else(|| AgentError::new("OpenAI tool_call 缺少 function 字段。"))?;
            let name = function
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .ok_or_else(|| AgentError::new("OpenAI tool_call 缺少 function.name。"))?;
            let arguments = function
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}");
            let args = parse_tool_arguments(arguments).map_err(|error| {
                AgentError::new(format!(
                    "OpenAI tool_call `{name}` 的 arguments 不是有效 JSON：{error}"
                ))
            })?;
            let id = call
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(ToString::to_string)
                .unwrap_or_else(|| format!("openai-tool-call-{}", index + 1));

            Ok(LlmToolCall {
                id,
                name: name.to_string(),
                args,
            })
        })
        .collect()
}

fn extract_anthropic_tool_calls(value: &Value) -> AgentResult<Vec<LlmToolCall>> {
    let Some(content) = value.get("content").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };

    content
        .iter()
        .filter(|part| {
            part.get("type")
                .and_then(Value::as_str)
                .map(|kind| kind == "tool_use")
                .unwrap_or(false)
        })
        .enumerate()
        .map(|(index, part)| {
            let name = part
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .ok_or_else(|| AgentError::new("Anthropic tool_use 缺少 name。"))?;
            let id = part
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(ToString::to_string)
                .unwrap_or_else(|| format!("anthropic-tool-use-{}", index + 1));
            let args = part.get("input").cloned().unwrap_or_else(|| json!({}));

            Ok(LlmToolCall {
                id,
                name: name.to_string(),
                args,
            })
        })
        .collect()
}

fn parse_tool_arguments(arguments: &str) -> serde_json::Result<Value> {
    let arguments = arguments.trim();
    if arguments.is_empty() {
        return Ok(json!({}));
    }

    serde_json::from_str(arguments)
}

fn truncate_for_error(value: &str) -> String {
    const MAX_CHARS: usize = 600;

    let mut truncated = value.chars().take(MAX_CHARS).collect::<String>();
    if value.chars().count() > MAX_CHARS {
        truncated.push('…');
    }

    truncated
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::AgentToolSafety;

    fn message(role: LlmMessageRole, content: &str) -> LlmMessage {
        LlmMessage::text(role, content)
    }

    fn tool_definition() -> AgentToolDefinition {
        AgentToolDefinition {
            name: "read_file".to_string(),
            description: "Read a file.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" }
                },
                "required": ["path"]
            }),
            safety: AgentToolSafety::ReadOnly,
            requires_workspace: true,
            requires_approval: false,
        }
    }

    #[test]
    fn detects_openai_chat_completion_urls() {
        assert_eq!(
            detect_api_style("https://example.test/v1/chat/completions"),
            AgentApiStyle::OpenAiCompatible
        );
    }

    #[test]
    fn moves_system_messages_to_anthropic_system_field() {
        let request = LlmChatRequest {
            api_url: "https://api.anthropic.com/v1/messages".to_string(),
            api_token: "token".to_string(),
            model: "claude".to_string(),
            api_style: AgentApiStyle::AnthropicCompatible,
            max_tokens: 1024,
            temperature: 0.2,
            messages: vec![
                message(LlmMessageRole::System, "Safety first."),
                message(LlmMessageRole::User, "Hello"),
                message(LlmMessageRole::Assistant, "Hi"),
            ],
            tools: Vec::new(),
        };

        let payload = build_payload(&request);

        assert_eq!(payload["system"], "Safety first.");
        assert_eq!(payload["messages"].as_array().unwrap().len(), 2);
        assert_eq!(payload["messages"][0]["role"], "user");
        assert_eq!(payload["messages"][0]["content"][0]["type"], "text");
    }

    #[test]
    fn builds_openai_native_tool_payload_and_tool_result_messages() {
        let request = LlmChatRequest {
            api_url: "https://example.test/v1/chat/completions".to_string(),
            api_token: "token".to_string(),
            model: "gpt".to_string(),
            api_style: AgentApiStyle::OpenAiCompatible,
            max_tokens: 1024,
            temperature: 0.2,
            messages: vec![
                message(LlmMessageRole::User, "Read src/lib.rs"),
                LlmMessage::assistant(
                    "",
                    vec![LlmToolCall {
                        id: "call-1".to_string(),
                        name: "read_file".to_string(),
                        args: json!({ "path": "src/lib.rs" }),
                    }],
                ),
                LlmMessage::tool_result("call-1", "{\"ok\":true}", false),
            ],
            tools: vec![tool_definition()],
        };

        let payload = build_payload(&request);

        assert_eq!(payload["tool_choice"], "auto");
        assert_eq!(payload["tools"][0]["type"], "function");
        assert_eq!(payload["tools"][0]["function"]["name"], "read_file");
        assert_eq!(payload["messages"][1]["tool_calls"][0]["id"], "call-1");
        assert_eq!(payload["messages"][2]["role"], "tool");
        assert_eq!(payload["messages"][2]["tool_call_id"], "call-1");
    }

    #[test]
    fn builds_anthropic_native_tool_payload_and_tool_result_messages() {
        let request = LlmChatRequest {
            api_url: "https://api.anthropic.com/v1/messages".to_string(),
            api_token: "token".to_string(),
            model: "claude".to_string(),
            api_style: AgentApiStyle::AnthropicCompatible,
            max_tokens: 1024,
            temperature: 0.2,
            messages: vec![
                message(LlmMessageRole::User, "Read src/lib.rs"),
                LlmMessage::assistant(
                    "",
                    vec![LlmToolCall {
                        id: "toolu-1".to_string(),
                        name: "read_file".to_string(),
                        args: json!({ "path": "src/lib.rs" }),
                    }],
                ),
                LlmMessage::tool_result("toolu-1", "{\"ok\":true}", false),
            ],
            tools: vec![tool_definition()],
        };

        let payload = build_payload(&request);

        assert_eq!(payload["tools"][0]["name"], "read_file");
        assert_eq!(payload["messages"][1]["content"][0]["type"], "tool_use");
        assert_eq!(payload["messages"][2]["role"], "user");
        assert_eq!(payload["messages"][2]["content"][0]["type"], "tool_result");
        assert_eq!(
            payload["messages"][2]["content"][0]["tool_use_id"],
            "toolu-1"
        );
    }

    #[test]
    fn extracts_native_tool_calls() {
        let openai = json!({
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "id": "call-1",
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": "{\"path\":\"src/lib.rs\"}"
                        }
                    }]
                }
            }]
        });
        let anthropic = json!({
            "content": [{
                "type": "tool_use",
                "id": "toolu-1",
                "name": "search_files",
                "input": { "query": "main" }
            }]
        });

        let openai_calls = extract_tool_calls(&openai, AgentApiStyle::OpenAiCompatible).unwrap();
        let anthropic_calls =
            extract_tool_calls(&anthropic, AgentApiStyle::AnthropicCompatible).unwrap();

        assert_eq!(openai_calls[0].id, "call-1");
        assert_eq!(openai_calls[0].name, "read_file");
        assert_eq!(openai_calls[0].args["path"], "src/lib.rs");
        assert_eq!(anthropic_calls[0].id, "toolu-1");
        assert_eq!(anthropic_calls[0].name, "search_files");
        assert_eq!(anthropic_calls[0].args["query"], "main");
    }

    #[test]
    fn extracts_openai_and_anthropic_usage() {
        let openai = json!({
            "usage": {
                "prompt_tokens": 7,
                "completion_tokens": 5,
                "total_tokens": 12
            }
        });
        let anthropic = json!({
            "usage": {
                "input_tokens": 3,
                "output_tokens": 4
            }
        });

        assert_eq!(extract_usage(&openai).unwrap().total_tokens, Some(12));
        assert_eq!(extract_usage(&anthropic).unwrap().total_tokens, Some(7));
    }
}
