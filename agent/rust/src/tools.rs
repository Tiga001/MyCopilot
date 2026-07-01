use crate::protocol::{
    AgentError, AgentResult, AgentRunContext, AgentToolCall, AgentToolDefinition, AgentToolResult,
    AgentToolSafety,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

const MAX_READ_FILE_BYTES: u64 = 512 * 1024;
const MAX_SEARCH_FILE_BYTES: u64 = 512 * 1024;
const DEFAULT_READ_MAX_LINES: usize = 400;
const MAX_READ_LINES: usize = 2_000;
const DEFAULT_SEARCH_LIMIT: usize = 40;
const MAX_SEARCH_LIMIT: usize = 200;
const MAX_WALK_ENTRIES: usize = 20_000;
const MAX_GIT_DIFF_BYTES: usize = 200 * 1024;
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
    pub fn read_only_defaults() -> Self {
        let mut registry = Self {
            tools: BTreeMap::new(),
        };
        registry.register(ReadFileTool);
        registry.register(SearchFilesTool);
        registry.register(SearchCodeTool);
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

    fn workspace_root(&self) -> AgentResult<PathBuf> {
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

    fn resolve_existing_path(&self, input_path: &str) -> AgentResult<PathBuf> {
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

    fn validate_relative_path_for_git(&self, input_path: &str) -> AgentResult<PathBuf> {
        clean_relative_path(input_path)
    }
}

trait AgentTool: Send + Sync {
    fn definition(&self) -> AgentToolDefinition;
    fn execute(&self, context: &ToolExecutionContext, args: Value) -> AgentResult<Value>;
}

struct ReadFileTool;

impl AgentTool for ReadFileTool {
    fn definition(&self) -> AgentToolDefinition {
        AgentToolDefinition {
            name: "read_file".to_string(),
            description:
                "Read a UTF-8 text file inside the selected workspace with optional line bounds."
                    .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Workspace-relative file path." },
                    "filePath": { "type": "string", "description": "Alias for path." },
                    "startLine": { "type": "integer", "minimum": 1 },
                    "maxLines": { "type": "integer", "minimum": 1, "maximum": MAX_READ_LINES }
                },
                "required": ["path"]
            }),
            safety: AgentToolSafety::ReadOnly,
            requires_workspace: true,
            requires_approval: false,
        }
    }

    fn execute(&self, context: &ToolExecutionContext, args: Value) -> AgentResult<Value> {
        let args: ReadFileArgs = serde_json::from_value(args)
            .map_err(|error| AgentError::new(format!("read_file 参数无效：{error}")))?;
        let path = args.path()?;
        let file_path = context.resolve_existing_path(path)?;
        let metadata = fs::metadata(&file_path)
            .map_err(|error| AgentError::new(format!("读取文件元数据失败：{error}")))?;

        if !metadata.is_file() {
            return Err(AgentError::new("read_file 只能读取文件。"));
        }

        if metadata.len() > MAX_READ_FILE_BYTES {
            return Err(AgentError::new(format!(
                "文件过大：{} bytes，超过 {} bytes 限制。",
                metadata.len(),
                MAX_READ_FILE_BYTES
            )));
        }

        let content = fs::read_to_string(&file_path)
            .map_err(|error| AgentError::new(format!("读取文件失败：{error}")))?;
        let lines: Vec<&str> = content.lines().collect();
        let total_lines = lines.len();
        let start_line = args.start_line.unwrap_or(1).max(1);
        let max_lines = args
            .max_lines
            .unwrap_or(DEFAULT_READ_MAX_LINES)
            .clamp(1, MAX_READ_LINES);
        let start_index = start_line.saturating_sub(1).min(total_lines);
        let end_index = (start_index + max_lines).min(total_lines);
        let selected = lines[start_index..end_index].join("\n");

        Ok(json!({
            "path": relative_display(&context.workspace_root()?, &file_path),
            "startLine": start_index + 1,
            "endLine": end_index,
            "totalLines": total_lines,
            "truncated": end_index < total_lines,
            "content": selected
        }))
    }
}

struct SearchFilesTool;

impl AgentTool for SearchFilesTool {
    fn definition(&self) -> AgentToolDefinition {
        AgentToolDefinition {
            name: "search_files".to_string(),
            description: "Find files or directories by workspace-relative path or file name."
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Case-insensitive path or file-name substring." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": MAX_SEARCH_LIMIT }
                },
                "required": ["query"]
            }),
            safety: AgentToolSafety::ReadOnly,
            requires_workspace: true,
            requires_approval: false,
        }
    }

    fn execute(&self, context: &ToolExecutionContext, args: Value) -> AgentResult<Value> {
        let args: SearchFilesArgs = serde_json::from_value(args)
            .map_err(|error| AgentError::new(format!("search_files 参数无效：{error}")))?;
        let query = args.query.trim();
        if query.is_empty() {
            return Err(AgentError::new("search_files.query 不能为空。"));
        }

        let limit = sanitize_limit(args.limit);
        let root = context.workspace_root()?;
        let needle = query.to_ascii_lowercase();
        let mut matches = Vec::new();
        let walk = walk_workspace(&root)?;

        for entry in walk.entries {
            let relative = relative_display(&root, &entry.path);
            if !relative.to_ascii_lowercase().contains(&needle) {
                continue;
            }

            matches.push(json!({
                "path": relative,
                "kind": if entry.is_dir { "directory" } else { "file" },
                "sizeBytes": entry.size_bytes
            }));

            if matches.len() >= limit {
                break;
            }
        }

        Ok(json!({
            "query": query,
            "matches": matches,
            "truncated": walk.truncated || matches.len() >= limit
        }))
    }
}

struct SearchCodeTool;

impl AgentTool for SearchCodeTool {
    fn definition(&self) -> AgentToolDefinition {
        AgentToolDefinition {
            name: "search_code".to_string(),
            description: "Search UTF-8 text content inside workspace files.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Text to search for." },
                    "path": { "type": "string", "description": "Optional workspace-relative directory or file to search within." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": MAX_SEARCH_LIMIT },
                    "caseSensitive": { "type": "boolean" }
                },
                "required": ["query"]
            }),
            safety: AgentToolSafety::ReadOnly,
            requires_workspace: true,
            requires_approval: false,
        }
    }

    fn execute(&self, context: &ToolExecutionContext, args: Value) -> AgentResult<Value> {
        let args: SearchCodeArgs = serde_json::from_value(args)
            .map_err(|error| AgentError::new(format!("search_code 参数无效：{error}")))?;
        let query = args.query.trim();
        if query.is_empty() {
            return Err(AgentError::new("search_code.query 不能为空。"));
        }

        let root = context.workspace_root()?;
        let search_root = match args.path.as_deref().filter(|path| !path.trim().is_empty()) {
            Some(path) => context.resolve_existing_path(path)?,
            None => root.clone(),
        };
        let limit = sanitize_limit(args.limit);
        let case_sensitive = args.case_sensitive.unwrap_or(false);
        let needle = if case_sensitive {
            query.to_string()
        } else {
            query.to_ascii_lowercase()
        };
        let mut matches = Vec::new();
        let walk = if search_root.is_file() {
            WalkResult {
                entries: vec![WalkEntry {
                    path: search_root.clone(),
                    is_dir: false,
                    size_bytes: fs::metadata(&search_root)
                        .map(|metadata| metadata.len())
                        .unwrap_or(0),
                }],
                truncated: false,
            }
        } else {
            walk_workspace(&search_root)?
        };

        for entry in walk.entries.iter().filter(|entry| !entry.is_dir) {
            if entry.size_bytes > MAX_SEARCH_FILE_BYTES {
                continue;
            }

            let Ok(content) = fs::read_to_string(&entry.path) else {
                continue;
            };

            for (line_index, line) in content.lines().enumerate() {
                let haystack = if case_sensitive {
                    line.to_string()
                } else {
                    line.to_ascii_lowercase()
                };

                if !haystack.contains(&needle) {
                    continue;
                }

                matches.push(json!({
                    "path": relative_display(&root, &entry.path),
                    "lineNumber": line_index + 1,
                    "line": line.trim()
                }));

                if matches.len() >= limit {
                    break;
                }
            }

            if matches.len() >= limit {
                break;
            }
        }

        Ok(json!({
            "query": query,
            "matches": matches,
            "truncated": walk.truncated || matches.len() >= limit
        }))
    }
}

struct GitDiffTool;

impl AgentTool for GitDiffTool {
    fn definition(&self) -> AgentToolDefinition {
        AgentToolDefinition {
            name: "git_diff".to_string(),
            description: "Return the current read-only git diff for the selected workspace, optionally scoped to one relative path.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Optional workspace-relative path." }
                }
            }),
            safety: AgentToolSafety::ReadOnly,
            requires_workspace: true,
            requires_approval: false,
        }
    }

    fn execute(&self, context: &ToolExecutionContext, args: Value) -> AgentResult<Value> {
        let args: GitDiffArgs = serde_json::from_value(args)
            .map_err(|error| AgentError::new(format!("git_diff 参数无效：{error}")))?;
        let root = context.workspace_root()?;
        let mut command = Command::new("git");
        command.arg("-C").arg(&root).arg("diff").arg("--");

        if let Some(path) = args.path.as_deref().filter(|path| !path.trim().is_empty()) {
            command.arg(context.validate_relative_path_for_git(path)?);
        }

        let output = command
            .output()
            .map_err(|error| AgentError::new(format!("执行 git diff 失败：{error}")))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(AgentError::new(format!(
                "git diff 返回失败：{}",
                stderr.trim()
            )));
        }

        let diff = String::from_utf8_lossy(&output.stdout);
        let (patch, truncated) = truncate_chars(&diff, MAX_GIT_DIFF_BYTES);

        Ok(json!({
            "path": args.path,
            "patch": patch,
            "truncated": truncated
        }))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadFileArgs {
    path: Option<String>,
    file_path: Option<String>,
    start_line: Option<usize>,
    max_lines: Option<usize>,
}

impl ReadFileArgs {
    fn path(&self) -> AgentResult<&str> {
        self.path
            .as_deref()
            .or(self.file_path.as_deref())
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .ok_or_else(|| AgentError::new("read_file.path 不能为空。"))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchFilesArgs {
    query: String,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchCodeArgs {
    query: String,
    path: Option<String>,
    limit: Option<usize>,
    case_sensitive: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitDiffArgs {
    path: Option<String>,
}

struct WalkEntry {
    path: PathBuf,
    is_dir: bool,
    size_bytes: u64,
}

struct WalkResult {
    entries: Vec<WalkEntry>,
    truncated: bool,
}

fn walk_workspace(root: &Path) -> AgentResult<WalkResult> {
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

fn should_exclude_name(name: &str) -> bool {
    EXCLUDED_NAMES.iter().any(|excluded| name == *excluded)
}

fn clean_relative_path(input_path: &str) -> AgentResult<PathBuf> {
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

fn sanitize_limit(limit: Option<usize>) -> usize {
    limit
        .unwrap_or(DEFAULT_SEARCH_LIMIT)
        .clamp(1, MAX_SEARCH_LIMIT)
}

fn relative_display(root: &Path, path: &Path) -> String {
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

fn truncate_chars(value: &str, max_chars: usize) -> (String, bool) {
    let mut output = value.chars().take(max_chars).collect::<String>();
    let truncated = value.chars().count() > max_chars;
    if truncated {
        output.push_str("\n...[truncated]");
    }

    (output, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{AgentApprovalStatus, AgentRunContext, AgentWorkspaceContext};
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
    fn search_files_finds_paths_by_name() {
        let fixture = TestWorkspace::new();
        fixture.write_file("src/main.rs", "fn main() {}\n");
        fixture.write_file("README.md", "hello\n");
        let context = fixture.context();
        let registry = ToolRegistry::read_only_defaults();
        let call = AgentToolCall {
            id: "call-1".to_string(),
            tool: "search_files".to_string(),
            args: json!({ "query": "main", "limit": 10 }),
            approval_status: AgentApprovalStatus::NotRequired,
            reason: None,
        };

        let result = registry.execute(&context, &call);

        assert!(result.ok, "{:?}", result.error);
        assert_eq!(result.result.unwrap()["matches"][0]["path"], "src/main.rs");
    }

    #[test]
    fn search_code_finds_text_matches() {
        let fixture = TestWorkspace::new();
        fixture.write_file("src/lib.rs", "pub fn target_symbol() {}\n");
        let context = fixture.context();
        let registry = ToolRegistry::read_only_defaults();
        let call = AgentToolCall {
            id: "call-1".to_string(),
            tool: "search_code".to_string(),
            args: json!({ "query": "target_symbol" }),
            approval_status: AgentApprovalStatus::NotRequired,
            reason: None,
        };

        let result = registry.execute(&context, &call);

        assert!(result.ok, "{:?}", result.error);
        assert_eq!(result.result.unwrap()["matches"][0]["lineNumber"], 1);
    }

    #[test]
    fn read_file_respects_line_bounds() {
        let fixture = TestWorkspace::new();
        fixture.write_file("notes.txt", "one\ntwo\nthree\n");
        let context = fixture.context();
        let registry = ToolRegistry::read_only_defaults();
        let call = AgentToolCall {
            id: "call-1".to_string(),
            tool: "read_file".to_string(),
            args: json!({ "path": "notes.txt", "startLine": 2, "maxLines": 1 }),
            approval_status: AgentApprovalStatus::NotRequired,
            reason: None,
        };

        let result = registry.execute(&context, &call);

        assert!(result.ok, "{:?}", result.error);
        assert_eq!(result.result.unwrap()["content"], "two");
    }

    struct TestWorkspace {
        root: PathBuf,
    }

    impl TestWorkspace {
        fn new() -> Self {
            let unique = TEST_WORKSPACE_COUNTER.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!("my-copilot-agent-test-{unique}"));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn write_file(&self, path: &str, content: &str) {
            let file_path = self.root.join(path);
            fs::create_dir_all(file_path.parent().unwrap()).unwrap();
            fs::write(file_path, content).unwrap();
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
