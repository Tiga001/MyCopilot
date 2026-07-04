use super::{
    relative_display, sanitize_limit, walk_workspace_with_cancellation, AgentTool,
    ToolExecutionContext, MAX_SEARCH_LIMIT,
};
use crate::protocol::{AgentError, AgentResult, AgentToolDefinition, AgentToolSafety};
use serde::Deserialize;
use serde_json::{json, Value};

pub(super) struct SearchFilesTool;

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
        let cancellation_token = context.cancellation_token();
        let walk = walk_workspace_with_cancellation(&root, &cancellation_token)?;

        for entry in walk.entries {
            cancellation_token.check()?;
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchFilesArgs {
    query: String,
    limit: Option<usize>,
}

#[cfg(test)]
mod tests {
    use super::super::{ToolExecutionContext, ToolRegistry};
    use crate::protocol::{
        AgentApprovalStatus, AgentRunContext, AgentToolCall, AgentWorkspaceContext,
    };
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_WORKSPACE_COUNTER: AtomicU64 = AtomicU64::new(1);

    #[test]
    fn search_files_finds_paths_by_name() {
        let fixture = TestWorkspace::new();
        fixture.write_file("src/main.rs", "fn main() {}\n");
        fixture.write_file("README.md", "hello\n");
        let context = fixture.context();
        let registry = ToolRegistry::read_only_defaults_with_search(None);
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

    struct TestWorkspace {
        root: PathBuf,
    }

    impl TestWorkspace {
        fn new() -> Self {
            let unique = TEST_WORKSPACE_COUNTER.fetch_add(1, Ordering::Relaxed);
            let root =
                std::env::temp_dir().join(format!("my-copilot-agent-test-search-files-{unique}"));
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
                attachment_library: None,
            }))
        }
    }

    impl Drop for TestWorkspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}
