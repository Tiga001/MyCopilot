use crate::protocol::{AgentApiStyle, AgentChatMessage, AgentError, AgentResult, AgentUsage};
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
    pub messages: Vec<AgentChatMessage>,
}

#[derive(Debug, Clone)]
pub(crate) struct LlmChatResponse {
    pub content: String,
    pub usage: Option<AgentUsage>,
    pub finish_reason: Option<String>,
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

    let content = extract_response_text(&value)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| {
            AgentError::new(format!(
                "模型响应里没有可显示文本：{}",
                truncate_for_error(&body)
            ))
        })?;

    Ok(LlmChatResponse {
        content,
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
        AgentApiStyle::OpenAiCompatible => json!({
            "model": request.model,
            "messages": request.messages,
            "stream": false,
            "max_tokens": request.max_tokens,
            "temperature": request.temperature,
        }),
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

            Value::Object(payload)
        }
    }
}

fn split_anthropic_messages(
    messages: &[AgentChatMessage],
) -> (Option<String>, Vec<AgentChatMessage>) {
    let mut system_parts = Vec::new();
    let mut chat_messages = Vec::new();

    for message in messages {
        if message.role == "system" {
            system_parts.push(message.content.as_str());
        } else {
            chat_messages.push(message.clone());
        }
    }

    let system = if system_parts.is_empty() {
        None
    } else {
        Some(system_parts.join("\n\n"))
    };

    (system, chat_messages)
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

    fn message(role: &str, content: &str) -> AgentChatMessage {
        AgentChatMessage {
            role: role.to_string(),
            content: content.to_string(),
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
                message("system", "Safety first."),
                message("user", "Hello"),
                message("assistant", "Hi"),
            ],
        };

        let payload = build_payload(&request);

        assert_eq!(payload["system"], "Safety first.");
        assert_eq!(payload["messages"].as_array().unwrap().len(), 2);
        assert_eq!(payload["messages"][0]["role"], "user");
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
