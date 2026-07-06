// Implements the right-sidebar embedded browser feature.
// Provides native Webview navigation helpers used by the Browser module.

use serde::Serialize;
use tauri::{AppHandle, Manager};
use url::Url;

const BROWSER_METADATA_MAX_BYTES: usize = 1_000_000;
const BROWSER_METADATA_TIMEOUT_SECS: u64 = 6;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageMetadata {
    title: Option<String>,
    icon_url: Option<String>,
}

fn get_browser_webview(app: &AppHandle, label: &str) -> Result<tauri::Webview, String> {
    app.get_webview(label)
        .ok_or_else(|| format!("Browser webview not found: {label}"))
}

fn parse_browser_url(url: &str) -> Result<Url, String> {
    let parsed_url = Url::parse(url).map_err(|error| format!("Invalid URL: {error}"))?;
    match parsed_url.scheme() {
        "http" | "https" => Ok(parsed_url),
        scheme => Err(format!("Unsupported browser URL scheme: {scheme}")),
    }
}

fn normalize_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn decode_basic_html_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

fn extract_html_title(html: &str) -> Option<String> {
    let lower_html = html.to_ascii_lowercase();
    let title_start = lower_html.find("<title")?;
    let title_open_end = lower_html[title_start..].find('>')? + title_start + 1;
    let title_close = lower_html[title_open_end..].find("</title>")? + title_open_end;
    let title = decode_basic_html_entities(&normalize_whitespace(&html[title_open_end..title_close]));

    if title.is_empty() {
        None
    } else {
        Some(title)
    }
}

fn is_attr_name_char(value: u8) -> bool {
    value.is_ascii_alphanumeric() || value == b'-' || value == b'_'
}

fn extract_tag_attribute(tag: &str, attribute_name: &str) -> Option<String> {
    let lower_tag = tag.to_ascii_lowercase();
    let lower_bytes = lower_tag.as_bytes();
    let original_bytes = tag.as_bytes();
    let attribute = attribute_name.as_bytes();
    let mut cursor = 0;

    while let Some(relative_index) = lower_tag[cursor..].find(attribute_name) {
        let index = cursor + relative_index;
        let previous_is_attr_char = index > 0 && is_attr_name_char(lower_bytes[index - 1]);
        let next_index = index + attribute.len();
        let next_is_attr_char =
            next_index < lower_bytes.len() && is_attr_name_char(lower_bytes[next_index]);

        if previous_is_attr_char || next_is_attr_char {
            cursor = next_index;
            continue;
        }

        let mut value_start = next_index;
        while value_start < lower_bytes.len() && lower_bytes[value_start].is_ascii_whitespace() {
            value_start += 1;
        }
        if value_start >= lower_bytes.len() || lower_bytes[value_start] != b'=' {
            cursor = next_index;
            continue;
        }
        value_start += 1;
        while value_start < lower_bytes.len() && lower_bytes[value_start].is_ascii_whitespace() {
            value_start += 1;
        }
        if value_start >= lower_bytes.len() {
            return None;
        }

        let quote = lower_bytes[value_start];
        let (raw_value_start, raw_value_end) = if quote == b'"' || quote == b'\'' {
            let raw_value_start = value_start + 1;
            let raw_value_end = original_bytes[raw_value_start..]
                .iter()
                .position(|byte| *byte == quote)
                .map(|position| raw_value_start + position)?;
            (raw_value_start, raw_value_end)
        } else {
            let raw_value_start = value_start;
            let raw_value_end = original_bytes[raw_value_start..]
                .iter()
                .position(|byte| byte.is_ascii_whitespace() || *byte == b'>')
                .map(|position| raw_value_start + position)
                .unwrap_or(original_bytes.len());
            (raw_value_start, raw_value_end)
        };

        let value = decode_basic_html_entities(tag[raw_value_start..raw_value_end].trim());
        return if value.is_empty() { None } else { Some(value) };
    }

    None
}

fn icon_url_from_href(base_url: &Url, href: &str) -> Option<String> {
    let icon_url = base_url.join(href).ok()?;
    match icon_url.scheme() {
        "http" | "https" => Some(icon_url.to_string()),
        _ => None,
    }
}

fn extract_favicon_url(html: &str, base_url: &Url) -> Option<String> {
    let lower_html = html.to_ascii_lowercase();
    let head_end = lower_html.find("</head>").unwrap_or_else(|| html.len().min(200_000));
    let head_html = &html[..head_end];
    let lower_head = head_html.to_ascii_lowercase();
    let mut cursor = 0;
    let mut fallback_icon: Option<String> = None;

    while let Some(relative_index) = lower_head[cursor..].find("<link") {
        let link_start = cursor + relative_index;
        let Some(relative_end) = lower_head[link_start..].find('>') else {
            break;
        };
        let link_end = link_start + relative_end + 1;
        let tag = &head_html[link_start..link_end];
        cursor = link_end;

        let rel = extract_tag_attribute(tag, "rel")
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        if !rel.split_whitespace().any(|token| token.contains("icon")) {
            continue;
        }

        let Some(href) = extract_tag_attribute(tag, "href") else {
            continue;
        };
        let Some(icon_url) = icon_url_from_href(base_url, &href) else {
            continue;
        };

        if rel.split_whitespace().any(|token| token == "icon" || token == "shortcut") {
            return Some(icon_url);
        }

        fallback_icon.get_or_insert(icon_url);
    }

    fallback_icon.or_else(|| icon_url_from_href(base_url, "/favicon.ico"))
}

#[tauri::command]
pub async fn browser_fetch_page_metadata(url: String) -> Result<BrowserPageMetadata, String> {
    let parsed_url = parse_browser_url(&url)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(8))
        .timeout(std::time::Duration::from_secs(BROWSER_METADATA_TIMEOUT_SECS))
        .user_agent("Mozilla/5.0 MyCopilot/0.1")
        .build()
        .map_err(|error| format!("Failed to create browser metadata client: {error}"))?;

    let response = client
        .get(parsed_url.clone())
        .send()
        .await
        .map_err(|error| format!("Failed to fetch browser page metadata: {error}"))?;
    let final_url = response.url().clone();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Failed to read browser page metadata: {error}"))?;
    let limited_bytes = if bytes.len() > BROWSER_METADATA_MAX_BYTES {
        &bytes[..BROWSER_METADATA_MAX_BYTES]
    } else {
        &bytes[..]
    };
    let html = String::from_utf8_lossy(limited_bytes);

    Ok(BrowserPageMetadata {
        title: extract_html_title(&html),
        icon_url: extract_favicon_url(&html, &final_url),
    })
}

#[tauri::command]
pub fn browser_navigate_url(
    app: AppHandle,
    webview_label: String,
    url: String,
) -> Result<(), String> {
    let parsed_url = parse_browser_url(&url)?;
    let webview = get_browser_webview(&app, &webview_label)?;
    webview
        .navigate(parsed_url)
        .map_err(|error| format!("Failed to navigate browser webview: {error}"))
}

#[tauri::command]
pub fn browser_reload(app: AppHandle, webview_label: String) -> Result<(), String> {
    let webview = get_browser_webview(&app, &webview_label)?;
    webview
        .reload()
        .map_err(|error| format!("Failed to reload browser webview: {error}"))
}

#[tauri::command]
pub fn browser_go_back(app: AppHandle, webview_label: String) -> Result<(), String> {
    let webview = get_browser_webview(&app, &webview_label)?;
    webview
        .eval("history.back();")
        .map_err(|error| format!("Failed to go back in browser webview: {error}"))
}

#[tauri::command]
pub fn browser_go_forward(app: AppHandle, webview_label: String) -> Result<(), String> {
    let webview = get_browser_webview(&app, &webview_label)?;
    webview
        .eval("history.forward();")
        .map_err(|error| format!("Failed to go forward in browser webview: {error}"))
}
