use super::{truncate_chars, AgentTool, ToolExecutionContext};
use crate::protocol::{AgentError, AgentResult, AgentToolDefinition, AgentToolSafety};
use base64::Engine;
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use reqwest::Url;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Duration;

const TAVILY_SEARCH_ENDPOINT: &str = "https://api.tavily.com/search";
const DEFAULT_MAX_RESULTS: usize = 5;
const MAX_RESULTS: usize = 10;
const DEFAULT_RESULT_CONTENT_CHARS: usize = 1_500;
const MAX_RESULT_CONTENT_CHARS: usize = 4_000;
const DEFAULT_ANSWER_CHARS: usize = 4_000;
const FAVICON_MAX_BYTES: usize = 64 * 1024;
const FAVICON_HTML_MAX_BYTES: usize = 768 * 1024;
const FAVICON_TIMEOUT_MILLIS: u64 = 1_200;
const FAVICON_USER_AGENT: &str = "MyCopilot/0.1 favicon resolver";

pub(super) struct WebSearchTool {
    api_key: String,
}

impl WebSearchTool {
    pub fn new(api_key: String) -> Self {
        Self { api_key }
    }
}

impl AgentTool for WebSearchTool {
    fn definition(&self) -> AgentToolDefinition {
        AgentToolDefinition {
            name: "web_search".to_string(),
            description: "Search the public web using Tavily. Sends the query to an external network service.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query." },
                    "maxResults": { "type": "integer", "minimum": 1, "maximum": MAX_RESULTS },
                    "searchDepth": { "type": "string", "enum": ["auto", "basic", "advanced"] },
                    "topic": { "type": "string", "enum": ["general", "news", "finance"] },
                    "timeRange": { "type": "string", "description": "Optional Tavily time range such as day, week, month, or year." },
                    "includeAnswer": { "type": "boolean" },
                    "includeRawContent": { "type": "boolean" },
                    "includeDomains": { "type": "array", "items": { "type": "string" } },
                    "excludeDomains": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["query"]
            }),
            safety: AgentToolSafety::ReadOnly,
            requires_workspace: false,
            requires_approval: false,
        }
    }

    fn execute(&self, _context: &ToolExecutionContext, args: Value) -> AgentResult<Value> {
        let args: WebSearchArgs = serde_json::from_value(args)
            .map_err(|error| AgentError::new(format!("web_search 参数无效：{error}")))?;
        let request = TavilySearchRequest::from_args(args)?;
        let response = TavilySearchClient::new(self.api_key.clone()).search(&request)?;

        Ok(format_tavily_response(request, response))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebSearchArgs {
    query: String,
    max_results: Option<usize>,
    search_depth: Option<String>,
    topic: Option<String>,
    time_range: Option<String>,
    include_answer: Option<bool>,
    include_raw_content: Option<bool>,
    include_domains: Option<Vec<String>>,
    exclude_domains: Option<Vec<String>>,
}

#[derive(Debug)]
struct TavilySearchRequest {
    query: String,
    max_results: usize,
    search_depth: String,
    topic: Option<String>,
    time_range: Option<String>,
    include_answer: bool,
    include_raw_content: bool,
    include_domains: Vec<String>,
    exclude_domains: Vec<String>,
}

impl TavilySearchRequest {
    fn from_args(args: WebSearchArgs) -> AgentResult<Self> {
        let query = args.query.trim().to_string();
        if query.is_empty() {
            return Err(AgentError::new("web_search.query 不能为空。"));
        }

        let search_depth = args.search_depth.unwrap_or_else(|| "basic".to_string());
        if !matches!(search_depth.as_str(), "auto" | "basic" | "advanced") {
            return Err(AgentError::new(
                "web_search.searchDepth 只能是 auto、basic 或 advanced。",
            ));
        }

        let topic = args.topic.filter(|topic| !topic.trim().is_empty());
        if let Some(topic) = topic.as_deref() {
            if !matches!(topic, "general" | "news" | "finance") {
                return Err(AgentError::new(
                    "web_search.topic 只能是 general、news 或 finance。",
                ));
            }
        }

        Ok(Self {
            query,
            max_results: args
                .max_results
                .unwrap_or(DEFAULT_MAX_RESULTS)
                .clamp(1, MAX_RESULTS),
            search_depth,
            topic,
            time_range: args.time_range.filter(|value| !value.trim().is_empty()),
            include_answer: args.include_answer.unwrap_or(true),
            include_raw_content: args.include_raw_content.unwrap_or(false),
            include_domains: clean_domains(args.include_domains.unwrap_or_default()),
            exclude_domains: clean_domains(args.exclude_domains.unwrap_or_default()),
        })
    }

    fn to_payload(&self) -> Value {
        let mut payload = json!({
            "query": self.query,
            "max_results": self.max_results,
            "search_depth": self.search_depth,
            "include_answer": self.include_answer,
            "include_raw_content": self.include_raw_content,
        });

        if let Some(topic) = &self.topic {
            payload["topic"] = json!(topic);
        }
        if let Some(time_range) = &self.time_range {
            payload["time_range"] = json!(time_range);
        }
        if !self.include_domains.is_empty() {
            payload["include_domains"] = json!(self.include_domains);
        }
        if !self.exclude_domains.is_empty() {
            payload["exclude_domains"] = json!(self.exclude_domains);
        }

        payload
    }
}

struct TavilySearchClient {
    api_key: String,
}

impl TavilySearchClient {
    fn new(api_key: String) -> Self {
        Self { api_key }
    }

    fn search(&self, request: &TavilySearchRequest) -> AgentResult<Value> {
        let api_key = self.api_key.trim();
        if api_key.is_empty() {
            return Err(AgentError::new(
                "Tavily API Key 为空，无法执行 web_search。",
            ));
        }

        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {api_key}"))
                .map_err(|_| AgentError::new("Tavily API Key 包含非法字符。"))?,
        );

        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|error| AgentError::new(format!("创建 Tavily HTTP 客户端失败：{error}")))?;
        let response = client
            .post(TAVILY_SEARCH_ENDPOINT)
            .headers(headers)
            .json(&request.to_payload())
            .send()
            .map_err(|error| AgentError::new(format!("请求 Tavily 搜索失败：{error}")))?;
        let status = response.status();
        let body = response
            .text()
            .map_err(|error| AgentError::new(format!("读取 Tavily 响应失败：{error}")))?;

        if !status.is_success() {
            let (body, _) = truncate_chars(&body, 600);
            return Err(AgentError::new(format!(
                "Tavily 搜索返回 {}：{}",
                status.as_u16(),
                body
            )));
        }

        serde_json::from_str(&body)
            .map_err(|error| AgentError::new(format!("Tavily 响应不是有效 JSON：{error}")))
    }
}

fn format_tavily_response(request: TavilySearchRequest, response: Value) -> Value {
    let favicon_client = favicon_client();
    let (answer, answer_truncated) = response
        .get("answer")
        .and_then(Value::as_str)
        .map(|answer| truncate_chars(answer, DEFAULT_ANSWER_CHARS))
        .map(|(answer, truncated)| (Some(answer), truncated))
        .unwrap_or((None, false));
    let raw_results_len = response
        .get("results")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let mut truncated = answer_truncated || raw_results_len > request.max_results;
    let results = response
        .get("results")
        .and_then(Value::as_array)
        .map(|results| {
            results
                .iter()
                .take(request.max_results)
                .map(|result| {
                    let (result, result_truncated) = format_tavily_result(
                        result,
                        request.include_raw_content,
                        favicon_client.as_ref(),
                    );
                    truncated |= result_truncated;
                    result
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let images = response.get("images").cloned().unwrap_or_else(|| json!([]));
    let response_time = response
        .get("response_time")
        .or_else(|| response.get("responseTime"))
        .cloned();

    json!({
        "query": request.query,
        "provider": "tavily",
        "answer": answer,
        "results": results,
        "images": images,
        "responseTime": response_time,
        "truncated": truncated
    })
}

fn format_tavily_result(
    result: &Value,
    include_raw_content: bool,
    favicon_client: Option<&Client>,
) -> (Value, bool) {
    let (content, content_truncated) = result
        .get("content")
        .and_then(Value::as_str)
        .map(|content| truncate_chars(content, DEFAULT_RESULT_CONTENT_CHARS))
        .map(|(content, truncated)| (Some(content), truncated))
        .unwrap_or((None, false));
    let (raw_content, raw_content_truncated) = if include_raw_content {
        result
            .get("raw_content")
            .or_else(|| result.get("rawContent"))
            .and_then(Value::as_str)
            .map(|content| truncate_chars(content, MAX_RESULT_CONTENT_CHARS))
            .map(|(content, truncated)| (Some(content), truncated))
            .unwrap_or((None, false))
    } else {
        (None, false)
    };
    let favicon = result
        .get("url")
        .and_then(Value::as_str)
        .and_then(|url| fetch_favicon_asset(favicon_client?, result, url));

    (
        json!({
            "title": result.get("title").and_then(Value::as_str),
            "url": result.get("url").and_then(Value::as_str),
            "content": content,
            "rawContent": raw_content,
            "score": result.get("score").cloned(),
            "publishedDate": result
                .get("published_date")
                .or_else(|| result.get("publishedDate"))
                .and_then(Value::as_str),
            "faviconDataUrl": favicon.as_ref().map(|asset| asset.data_url.as_str()),
            "faviconMimeType": favicon.as_ref().map(|asset| asset.mime_type.as_str())
        }),
        content_truncated || raw_content_truncated,
    )
}

struct FaviconAsset {
    data_url: String,
    mime_type: String,
}

fn favicon_client() -> Option<Client> {
    Client::builder()
        .timeout(Duration::from_millis(FAVICON_TIMEOUT_MILLIS))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 3 {
                attempt.stop()
            } else if normalize_public_url(attempt.url().as_str()).is_none() {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .ok()
}

fn fetch_favicon_asset(client: &Client, result: &Value, page_url: &str) -> Option<FaviconAsset> {
    let page_url = normalize_public_url(page_url)?;

    for candidate in favicon_candidates(result, &page_url) {
        if let Some(asset) = fetch_favicon_url(client, &candidate) {
            return Some(asset);
        }
    }

    for candidate in fetch_html_favicon_candidates(client, &page_url) {
        if let Some(asset) = fetch_favicon_url(client, &candidate) {
            return Some(asset);
        }
    }

    None
}

fn favicon_candidates(result: &Value, page_url: &Url) -> Vec<Url> {
    let mut candidates = Vec::new();

    for key in ["favicon", "favicon_url", "faviconUrl"] {
        if let Some(candidate) = result
            .get(key)
            .and_then(Value::as_str)
            .and_then(|value| resolve_public_url(page_url, value))
        {
            push_unique_url(&mut candidates, candidate);
        }
    }

    if let Some(candidate) = origin_favicon_url(page_url) {
        push_unique_url(&mut candidates, candidate);
    }

    candidates
}

fn push_unique_url(candidates: &mut Vec<Url>, url: Url) {
    if !candidates.iter().any(|candidate| candidate == &url) {
        candidates.push(url);
    }
}

fn origin_favicon_url(page_url: &Url) -> Option<Url> {
    let origin = page_url.origin().ascii_serialization();
    normalize_public_url(&format!("{origin}/favicon.ico"))
}

fn resolve_public_url(base_url: &Url, value: &str) -> Option<Url> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }

    let resolved = base_url.join(value).ok()?;
    normalize_public_url(resolved.as_str())
}

fn normalize_public_url(value: &str) -> Option<Url> {
    let url = Url::parse(value.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }

    let host = url.host_str()?.trim().to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return None;
    }
    if host == "metadata.google.internal" {
        return None;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_blocked_ip(ip) {
            return None;
        }
    }

    Some(url)
}

fn fetch_favicon_url(client: &Client, url: &Url) -> Option<FaviconAsset> {
    let response = client
        .get(url.clone())
        .header(USER_AGENT, FAVICON_USER_AGENT)
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }

    let mime_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(normalize_favicon_mime_type)
        .or_else(|| favicon_mime_type_from_url(url))?;
    let bytes = response.bytes().ok()?;
    if bytes.is_empty() || bytes.len() > FAVICON_MAX_BYTES {
        return None;
    }

    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(FaviconAsset {
        data_url: format!("data:{mime_type};base64,{encoded}"),
        mime_type,
    })
}

fn fetch_html_favicon_candidates(client: &Client, page_url: &Url) -> Vec<Url> {
    let mut response = match client
        .get(page_url.clone())
        .header(USER_AGENT, FAVICON_USER_AGENT)
        .send()
    {
        Ok(response) => response,
        Err(_) => return Vec::new(),
    };
    if !response.status().is_success() {
        return Vec::new();
    }
    if !response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(is_html_content_type)
        .unwrap_or(true)
    {
        return Vec::new();
    }

    let mut bytes = Vec::new();
    let max_bytes = FAVICON_HTML_MAX_BYTES as u64;
    if response
        .by_ref()
        .take(max_bytes)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return Vec::new();
    }
    let html = match std::str::from_utf8(&bytes) {
        Ok(html) => html,
        Err(_) => return Vec::new(),
    };

    html_favicon_candidates(html, page_url)
}

fn is_html_content_type(content_type: &str) -> bool {
    let mime_type = content_type
        .split(';')
        .next()
        .map(str::trim)
        .unwrap_or_default()
        .to_ascii_lowercase();

    matches!(mime_type.as_str(), "text/html" | "application/xhtml+xml")
}

fn html_favicon_candidates(html: &str, page_url: &Url) -> Vec<Url> {
    let lower_html = html.to_ascii_lowercase();
    let mut candidates = Vec::new();
    let mut offset = 0;

    while let Some(relative_start) = lower_html[offset..].find("<link") {
        let tag_start = offset + relative_start;
        let Some(relative_end) = lower_html[tag_start..].find('>') else {
            break;
        };
        let tag_end = tag_start + relative_end + 1;
        let tag = &html[tag_start..tag_end];

        if html_link_rel_has_icon(tag) {
            if let Some(href) = html_attr_value(tag, "href")
                .and_then(|href| resolve_public_url(page_url, &href))
            {
                push_unique_url(&mut candidates, href);
            }
        }

        offset = tag_end;
    }

    candidates
}

fn html_link_rel_has_icon(tag: &str) -> bool {
    html_attr_value(tag, "rel")
        .map(|rel| {
            rel.to_ascii_lowercase()
                .split_ascii_whitespace()
                .any(|token| {
                    matches!(
                        token,
                        "icon" | "apple-touch-icon" | "apple-touch-icon-precomposed"
                    )
                })
        })
        .unwrap_or(false)
}

fn html_attr_value(tag: &str, attr_name: &str) -> Option<String> {
    let bytes = tag.as_bytes();
    let attr_name = attr_name.to_ascii_lowercase();
    let mut index = 0;

    while index < bytes.len() {
        while index < bytes.len() && !is_html_attr_name_char(bytes[index]) {
            index += 1;
        }
        let name_start = index;
        while index < bytes.len() && is_html_attr_name_char(bytes[index]) {
            index += 1;
        }
        if name_start == index {
            break;
        }

        let name = tag[name_start..index].to_ascii_lowercase();
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index >= bytes.len() || bytes[index] != b'=' {
            continue;
        }
        index += 1;
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index >= bytes.len() {
            break;
        }

        let value = if bytes[index] == b'\'' || bytes[index] == b'"' {
            let quote = bytes[index];
            index += 1;
            let value_start = index;
            while index < bytes.len() && bytes[index] != quote {
                index += 1;
            }
            let value = tag[value_start..index].to_string();
            if index < bytes.len() {
                index += 1;
            }
            value
        } else {
            let value_start = index;
            while index < bytes.len()
                && !bytes[index].is_ascii_whitespace()
                && bytes[index] != b'>'
            {
                index += 1;
            }
            tag[value_start..index].to_string()
        };

        if name == attr_name {
            return Some(decode_html_attr_value(&value));
        }
    }

    None
}

fn is_html_attr_name_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':')
}

fn decode_html_attr_value(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&#038;", "&")
        .replace("&#38;", "&")
        .trim()
        .to_string()
}

fn normalize_favicon_mime_type(content_type: &str) -> Option<String> {
    let mime_type = content_type
        .split(';')
        .next()
        .map(str::trim)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(
        mime_type.as_str(),
        "image/png"
            | "image/jpeg"
            | "image/gif"
            | "image/webp"
            | "image/x-icon"
            | "image/vnd.microsoft.icon"
    ) {
        return Some(if mime_type == "image/vnd.microsoft.icon" {
            "image/x-icon".to_string()
        } else {
            mime_type
        });
    }

    None
}

fn favicon_mime_type_from_url(url: &Url) -> Option<String> {
    let path = url.path().to_ascii_lowercase();
    let mime_type = if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        "image/jpeg"
    } else if path.ends_with(".gif") {
        "image/gif"
    } else if path.ends_with(".webp") {
        "image/webp"
    } else if path.ends_with(".ico") {
        "image/x-icon"
    } else {
        return None;
    };

    Some(mime_type.to_string())
}

fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_blocked_ipv4(ip),
        IpAddr::V6(ip) => is_blocked_ipv6(ip),
    }
}

fn is_blocked_ipv4(ip: Ipv4Addr) -> bool {
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_unspecified()
        || ip.octets()[0] == 0
        || ip.octets()[0] == 127
        || ip.octets()[0] == 169 && ip.octets()[1] == 254
        || ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1])
}

fn is_blocked_ipv6(ip: Ipv6Addr) -> bool {
    ip.is_loopback()
        || ip.is_multicast()
        || ip.is_unspecified()
        || is_unique_local_ipv6(ip)
        || is_unicast_link_local_ipv6(ip)
}

fn is_unique_local_ipv6(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xfe00) == 0xfc00
}

fn is_unicast_link_local_ipv6(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xffc0) == 0xfe80
}

fn clean_domains(domains: Vec<String>) -> Vec<String> {
    domains
        .into_iter()
        .map(|domain| domain.trim().to_string())
        .filter(|domain| !domain.is_empty())
        .take(20)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_bounded_tavily_payload() {
        let request = TavilySearchRequest::from_args(WebSearchArgs {
            query: " rust tauri ".to_string(),
            max_results: Some(999),
            search_depth: Some("advanced".to_string()),
            topic: Some("general".to_string()),
            time_range: Some("week".to_string()),
            include_answer: None,
            include_raw_content: Some(true),
            include_domains: Some(vec![" docs.rs ".to_string(), "".to_string()]),
            exclude_domains: None,
        })
        .unwrap();
        let payload = request.to_payload();

        assert_eq!(request.max_results, MAX_RESULTS);
        assert_eq!(payload["query"], "rust tauri");
        assert_eq!(payload["search_depth"], "advanced");
        assert_eq!(payload["include_answer"], true);
        assert_eq!(payload["include_raw_content"], true);
        assert_eq!(payload["include_domains"][0], "docs.rs");
    }

    #[test]
    fn rejects_invalid_search_depth() {
        let error = TavilySearchRequest::from_args(WebSearchArgs {
            query: "rust".to_string(),
            max_results: None,
            search_depth: Some("deep".to_string()),
            topic: None,
            time_range: None,
            include_answer: None,
            include_raw_content: None,
            include_domains: None,
            exclude_domains: None,
        })
        .unwrap_err();

        assert!(error.to_string().contains("searchDepth"));
    }

    #[test]
    fn extracts_favicon_candidates_from_html_links() {
        let page_url = Url::parse(
            "https://understandingwar.org/research/russia-ukraine/russian-offensive-campaign-assessment-july-1-2026",
        )
        .unwrap();
        let candidates = html_favicon_candidates(
            r#"
            <link rel="canonical" href="https://understandingwar.org/research/russia-ukraine/russian-offensive-campaign-assessment-july-1-2026/" />
            <link rel="stylesheet" href="/theme.css" />
            <link rel="icon" href="https://understandingwar.org/wp-content/uploads/2024/10/cropped-ISW-Favicon-32x32.png" sizes="32x32" />
            <link rel="apple-touch-icon" href="/wp-content/uploads/2024/10/cropped-ISW-Favicon-180x180.png" />
            "#,
            &page_url,
        );

        let candidate_urls = candidates
            .iter()
            .map(Url::as_str)
            .collect::<Vec<_>>();
        assert_eq!(
            candidate_urls,
            vec![
                "https://understandingwar.org/wp-content/uploads/2024/10/cropped-ISW-Favicon-32x32.png",
                "https://understandingwar.org/wp-content/uploads/2024/10/cropped-ISW-Favicon-180x180.png",
            ],
        );
    }
}
