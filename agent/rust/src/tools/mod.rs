mod git_diff;
mod read_file;
mod read_pdf;
mod read_presentation;
mod read_spreadsheet;
mod read_word;
mod search_code;
mod search_files;
mod web_fetch;
mod web_search;

use crate::protocol::{
    AgentError, AgentResult, AgentRunContext, AgentSearchConfig, AgentSearchMode, AgentToolCall,
    AgentToolDefinition, AgentToolResult,
};
use git_diff::GitDiffTool;
use read_file::ReadFileTool;
use read_pdf::ReadPdfTool;
use read_presentation::ReadPresentationTool;
use read_spreadsheet::ReadSpreadsheetTool;
use read_word::ReadWordTool;
use search_code::SearchCodeTool;
use search_files::SearchFilesTool;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use web_fetch::WebFetchTool;
use web_search::WebSearchTool;

pub(super) const MAX_READ_FILE_BYTES: u64 = 512 * 1024;
pub(super) const MAX_SEARCH_FILE_BYTES: u64 = 512 * 1024;
pub(super) const DEFAULT_READ_MAX_LINES: usize = 400;
pub(super) const MAX_READ_LINES: usize = 2_000;
pub(super) const DEFAULT_SEARCH_LIMIT: usize = 40;
pub(super) const MAX_SEARCH_LIMIT: usize = 200;
pub(super) const MAX_WALK_ENTRIES: usize = 20_000;
pub(super) const MAX_GIT_DIFF_BYTES: usize = 200 * 1024;
pub(super) const MAX_DOCUMENT_FILE_BYTES: u64 = 25 * 1024 * 1024;
pub(super) const DEFAULT_DOCUMENT_MAX_CHARS: usize = 40_000;
pub(super) const MAX_DOCUMENT_TEXT_CHARS: usize = 120_000;

const EXCLUDED_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    "dist",
    "build",
    ".venv",
    "__pycache__",
    ".next",
    "target",
];

pub struct ToolRegistry {
    tools: BTreeMap<String, Box<dyn AgentTool>>,
}

impl ToolRegistry {
    pub fn read_only_defaults_with_search(search_config: Option<&AgentSearchConfig>) -> Self {
        let mut registry = Self {
            tools: BTreeMap::new(),
        };
        registry.register(ReadFileTool);
        registry.register(ReadPdfTool);
        registry.register(ReadWordTool);
        registry.register(ReadPresentationTool);
        registry.register(ReadSpreadsheetTool);
        registry.register(SearchFilesTool);
        registry.register(SearchCodeTool);
        if let Some(api_key) = tavily_api_key(search_config) {
            registry.register(WebSearchTool::new(api_key.clone()));
            registry.register(WebFetchTool::new(api_key));
        }
        registry.register(GitDiffTool);
        registry
    }

    pub fn definitions(&self) -> Vec<AgentToolDefinition> {
        self.tools.values().map(|tool| tool.definition()).collect()
    }

    pub fn execute(&self, context: &ToolExecutionContext, call: &AgentToolCall) -> AgentToolResult {
        let Some(tool) = self.tools.get(&call.tool) else {
            return AgentToolResult {
                call_id: call.id.clone(),
                tool: call.tool.clone(),
                ok: false,
                result: None,
                error: Some(format!("未知工具：{}", call.tool)),
            };
        };

        match tool.execute(context, call.args.clone()) {
            Ok(result) => AgentToolResult {
                call_id: call.id.clone(),
                tool: call.tool.clone(),
                ok: true,
                result: Some(result),
                error: None,
            },
            Err(error) => AgentToolResult {
                call_id: call.id.clone(),
                tool: call.tool.clone(),
                ok: false,
                result: None,
                error: Some(error.to_string()),
            },
        }
    }

    fn register<T: AgentTool + 'static>(&mut self, tool: T) {
        self.tools
            .insert(tool.definition().name, Box::new(tool) as Box<dyn AgentTool>);
    }
}

fn tavily_api_key(search_config: Option<&AgentSearchConfig>) -> Option<String> {
    let search_config = search_config?;
    if search_config.mode == AgentSearchMode::Disabled {
        return None;
    }

    let api_key = search_config
        .tavily_api_key
        .as_deref()
        .map(str::trim)
        .filter(|api_key| !api_key.is_empty())?;

    Some(api_key.to_string())
}

pub struct ToolExecutionContext {
    workspace_root: Option<PathBuf>,
}

impl ToolExecutionContext {
    pub fn from_run_context(context: Option<&AgentRunContext>) -> Self {
        let workspace_root = context
            .and_then(|context| context.workspace.as_ref())
            .and_then(|workspace| workspace.root_path.as_ref())
            .map(PathBuf::from);

        Self { workspace_root }
    }

    pub(super) fn workspace_root(&self) -> AgentResult<PathBuf> {
        let Some(root) = &self.workspace_root else {
            return Err(AgentError::new(
                "没有已选择的 workspace，无法使用文件或 Git 只读工具。",
            ));
        };

        let root = root
            .canonicalize()
            .map_err(|error| AgentError::new(format!("workspace 路径不可访问：{error}")))?;
        if !root.is_dir() {
            return Err(AgentError::new("workspace 路径不是目录。"));
        }

        Ok(root)
    }

    pub(super) fn resolve_existing_path(&self, input_path: &str) -> AgentResult<PathBuf> {
        let root = self.workspace_root()?;
        let relative = clean_relative_path(input_path)?;
        let resolved = root.join(relative);
        let canonical = resolved
            .canonicalize()
            .map_err(|error| AgentError::new(format!("路径不可访问：{error}")))?;

        if !canonical.starts_with(&root) {
            return Err(AgentError::new("路径必须位于已选择的 workspace 内。"));
        }

        Ok(canonical)
    }

    pub(super) fn validate_relative_path_for_git(&self, input_path: &str) -> AgentResult<PathBuf> {
        clean_relative_path(input_path)
    }
}

pub(super) trait AgentTool: Send + Sync {
    fn definition(&self) -> AgentToolDefinition;
    fn execute(&self, context: &ToolExecutionContext, args: Value) -> AgentResult<Value>;
}

pub(super) struct WalkEntry {
    pub path: PathBuf,
    pub is_dir: bool,
    pub size_bytes: u64,
}

pub(super) struct WalkResult {
    pub entries: Vec<WalkEntry>,
    pub truncated: bool,
}

pub(super) fn walk_workspace(root: &Path) -> AgentResult<WalkResult> {
    let mut entries = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut truncated = false;

    while let Some(directory) = stack.pop() {
        let read_dir = fs::read_dir(&directory)
            .map_err(|error| AgentError::new(format!("读取目录失败：{error}")))?;

        for item in read_dir {
            if entries.len() >= MAX_WALK_ENTRIES {
                truncated = true;
                break;
            }

            let item = item.map_err(|error| AgentError::new(format!("读取目录项失败：{error}")))?;
            let path = item.path();
            let file_name = item.file_name().to_string_lossy().to_string();
            if should_exclude_name(&file_name) {
                continue;
            }

            let file_type = item
                .file_type()
                .map_err(|error| AgentError::new(format!("读取文件类型失败：{error}")))?;
            if file_type.is_symlink() {
                continue;
            }

            let metadata = item
                .metadata()
                .map_err(|error| AgentError::new(format!("读取文件元数据失败：{error}")))?;
            let is_dir = metadata.is_dir();
            entries.push(WalkEntry {
                path: path.clone(),
                is_dir,
                size_bytes: metadata.len(),
            });

            if is_dir {
                stack.push(path);
            }
        }

        if truncated {
            break;
        }
    }

    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(WalkResult { entries, truncated })
}

pub(super) fn clean_relative_path(input_path: &str) -> AgentResult<PathBuf> {
    let trimmed = input_path.trim();
    if trimmed.is_empty() {
        return Err(AgentError::new("路径不能为空。"));
    }

    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err(AgentError::new("路径必须是 workspace 相对路径。"));
    }

    let mut cleaned = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => cleaned.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(AgentError::new("路径不能包含 .. 或系统根路径。"));
            }
        }
    }

    if cleaned.as_os_str().is_empty() {
        return Err(AgentError::new("路径不能为空。"));
    }

    Ok(cleaned)
}

pub(super) fn sanitize_limit(limit: Option<usize>) -> usize {
    limit
        .unwrap_or(DEFAULT_SEARCH_LIMIT)
        .clamp(1, MAX_SEARCH_LIMIT)
}

pub(super) fn relative_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

pub(super) fn truncate_chars(value: &str, max_chars: usize) -> (String, bool) {
    let mut output = value.chars().take(max_chars).collect::<String>();
    let truncated = value.chars().count() > max_chars;
    if truncated {
        output.push_str("\n...[truncated]");
    }

    (output, truncated)
}

pub(super) struct ResolvedDocumentPath {
    pub file_path: PathBuf,
    pub relative_path: String,
    pub extension: String,
    pub size_bytes: u64,
}

pub(super) struct NamedText {
    pub name: String,
    pub text: String,
}

pub(super) fn resolve_document_path(
    context: &ToolExecutionContext,
    input_path: &str,
    allowed_extensions: &[&str],
) -> AgentResult<ResolvedDocumentPath> {
    let root = context.workspace_root()?;
    let file_path = context.resolve_existing_path(input_path)?;
    let metadata = fs::metadata(&file_path)
        .map_err(|error| AgentError::new(format!("读取文件元数据失败：{error}")))?;

    if !metadata.is_file() {
        return Err(AgentError::new("文档读取工具只能读取文件。"));
    }

    if metadata.len() > MAX_DOCUMENT_FILE_BYTES {
        return Err(AgentError::new(format!(
            "文档过大：{} bytes，超过 {} bytes 限制。",
            metadata.len(),
            MAX_DOCUMENT_FILE_BYTES
        )));
    }

    let extension = file_path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .ok_or_else(|| AgentError::new("文件缺少扩展名，无法判断文档类型。"))?;

    if !allowed_extensions
        .iter()
        .any(|allowed| extension == allowed.to_ascii_lowercase())
    {
        return Err(AgentError::new(format!(
            "不支持的文件类型：.{extension}。支持：{}",
            allowed_extensions
                .iter()
                .map(|extension| format!(".{extension}"))
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }

    let relative_path = relative_display(&root, &file_path);

    Ok(ResolvedDocumentPath {
        file_path,
        relative_path,
        extension,
        size_bytes: metadata.len(),
    })
}

pub(super) fn sanitize_document_max_chars(max_chars: Option<usize>) -> usize {
    max_chars
        .unwrap_or(DEFAULT_DOCUMENT_MAX_CHARS)
        .clamp(1, MAX_DOCUMENT_TEXT_CHARS)
}

pub(super) fn read_zip_xml_text_parts(
    file_path: &Path,
    include_entry: impl Fn(&str) -> bool,
) -> AgentResult<Vec<NamedText>> {
    let file = File::open(file_path)
        .map_err(|error| AgentError::new(format!("打开 OOXML 文档失败：{error}")))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| AgentError::new(format!("读取 OOXML 压缩包失败：{error}")))?;
    let mut parts = Vec::new();

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| AgentError::new(format!("读取 OOXML 条目失败：{error}")))?;
        let name = entry.name().to_string();
        if !include_entry(&name) {
            continue;
        }

        let mut xml = String::new();
        entry
            .read_to_string(&mut xml)
            .map_err(|error| AgentError::new(format!("读取 OOXML XML 失败：{error}")))?;
        let text = xml_text_content(&xml)?;
        if !text.trim().is_empty() {
            parts.push(NamedText { name, text });
        }
    }

    parts.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(parts)
}

pub(super) fn xml_text_content(xml: &str) -> AgentResult<String> {
    let document = roxmltree::Document::parse(xml)
        .map_err(|error| AgentError::new(format!("解析 XML 失败：{error}")))?;
    let mut output = String::new();

    for node in document.descendants() {
        if node.is_element() {
            match node.tag_name().name() {
                "p" | "br" | "tr" | "row" => push_newline(&mut output),
                "tab" => output.push('\t'),
                _ => {}
            }
            continue;
        }

        if node.is_text() {
            let text = node.text().unwrap_or("").trim();
            if text.is_empty() {
                continue;
            }

            if !output.is_empty()
                && !output.ends_with([' ', '\n', '\t'])
                && !text.starts_with([',', '.', ';', ':', ')', ']', '}'])
            {
                output.push(' ');
            }
            output.push_str(text);
        }
    }

    Ok(normalize_text_output(&output))
}

pub(super) fn join_named_text(parts: &[NamedText]) -> String {
    parts
        .iter()
        .map(|part| format!("## {}\n{}", part.name, part.text))
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub(super) fn extract_with_textutil(file_path: &Path) -> AgentResult<String> {
    let output = Command::new("textutil")
        .arg("-convert")
        .arg("txt")
        .arg("-stdout")
        .arg(file_path)
        .output()
        .map_err(|error| {
            AgentError::new(format!(
                "读取旧版二进制 Office 文档需要系统 textutil 转换器，但启动失败：{error}"
            ))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AgentError::new(format!(
            "textutil 转换失败：{}",
            stderr.trim()
        )));
    }

    let text = String::from_utf8(output.stdout)
        .map_err(|error| AgentError::new(format!("textutil 输出不是 UTF-8：{error}")))?;
    Ok(normalize_text_output(&text))
}

pub(super) fn normalize_text_output(value: &str) -> String {
    let mut output = String::new();
    let mut previous_blank = false;

    for line in value.lines() {
        let line = line.trim();
        if line.is_empty() {
            if !previous_blank && !output.is_empty() {
                output.push('\n');
                previous_blank = true;
            }
            continue;
        }

        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(line);
        previous_blank = false;
    }

    output
}

fn push_newline(output: &mut String) {
    if !output.is_empty() && !output.ends_with('\n') {
        output.push('\n');
    }
}

fn should_exclude_name(name: &str) -> bool {
    EXCLUDED_NAMES.iter().any(|excluded| name == *excluded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{
        AgentRunContext, AgentSearchConfig, AgentSearchMode, AgentWorkspaceContext,
    };
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_WORKSPACE_COUNTER: AtomicU64 = AtomicU64::new(1);

    #[test]
    fn rejects_paths_outside_workspace() {
        let fixture = TestWorkspace::new();
        let context = fixture.context();
        let error = context.resolve_existing_path("../outside.txt").unwrap_err();

        assert!(error.to_string().contains("路径不能包含"));
    }

    #[test]
    fn registers_tavily_tools_when_configured() {
        let registry = ToolRegistry::read_only_defaults_with_search(Some(&AgentSearchConfig {
            mode: AgentSearchMode::Tavily,
            tavily_api_key: Some("tvly-test".to_string()),
        }));
        let tools = registry
            .definitions()
            .into_iter()
            .map(|definition| definition.name)
            .collect::<Vec<_>>();

        assert!(tools.contains(&"web_search".to_string()));
        assert!(tools.contains(&"web_fetch".to_string()));
    }

    struct TestWorkspace {
        root: PathBuf,
    }

    impl TestWorkspace {
        fn new() -> Self {
            let unique = TEST_WORKSPACE_COUNTER.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!("my-copilot-agent-test-tools-{unique}"));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn context(&self) -> ToolExecutionContext {
            ToolExecutionContext::from_run_context(Some(&AgentRunContext {
                conversation_id: None,
                project_id: None,
                workspace: Some(AgentWorkspaceContext {
                    project_id: None,
                    display_name: Some("test".to_string()),
                    root_path: Some(self.root.to_string_lossy().to_string()),
                }),
            }))
        }
    }

    impl Drop for TestWorkspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}
