use super::{clean_relative_path, AgentTool, ToolExecutionContext};
use crate::protocol::{
    AgentApprovalStatus, AgentDiffProposal, AgentError, AgentProposedAction, AgentResult,
    AgentToolCall, AgentToolDefinition, AgentToolSafety,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;

const MAX_PATCH_CHARS: usize = 240_000;
const MAX_SUMMARY_CHARS: usize = 2_000;

const TEXT_PATCH_EXTENSIONS: &[&str] = &[
    "astro",
    "bash",
    "bat",
    "bib",
    "c",
    "cc",
    "cfg",
    "cjs",
    "clj",
    "cljc",
    "cljs",
    "cmd",
    "cmake",
    "conf",
    "cpp",
    "cs",
    "css",
    "csv",
    "cxx",
    "dart",
    "dockerfile",
    "d.ts",
    "edn",
    "elm",
    "env",
    "erl",
    "ex",
    "exs",
    "fish",
    "fs",
    "fsi",
    "fsx",
    "gitattributes",
    "gitignore",
    "gql",
    "gradle",
    "graphql",
    "groovy",
    "go",
    "h",
    "hcl",
    "hh",
    "hrl",
    "hs",
    "htm",
    "html",
    "hxx",
    "hpp",
    "ini",
    "ipynb",
    "java",
    "jl",
    "js",
    "json",
    "jsonl",
    "jsx",
    "kt",
    "kts",
    "less",
    "lhs",
    "lock",
    "log",
    "lua",
    "m",
    "make",
    "markdown",
    "md",
    "mdx",
    "mk",
    "ml",
    "mli",
    "mjs",
    "nim",
    "nims",
    "php",
    "pl",
    "plist",
    "pm",
    "prisma",
    "properties",
    "proto",
    "ps1",
    "py",
    "pyi",
    "r",
    "rb",
    "rc",
    "rs",
    "rst",
    "sass",
    "scala",
    "scss",
    "sh",
    "sol",
    "sql",
    "sv",
    "svelte",
    "svg",
    "svh",
    "swift",
    "tex",
    "text",
    "tf",
    "tfvars",
    "toml",
    "ts",
    "tsx",
    "tsv",
    "txt",
    "v",
    "vh",
    "vue",
    "xml",
    "yaml",
    "yml",
    "zig",
    "zsh",
];

const TEXT_PATCH_BASENAMES: &[&str] = &[
    ".dockerignore",
    ".editorconfig",
    ".env",
    ".gitattributes",
    ".gitignore",
    ".npmrc",
    ".prettierrc",
    ".stylelintrc",
    "Brewfile",
    "CMakeLists.txt",
    "Dockerfile",
    "Gemfile",
    "Justfile",
    "Makefile",
    "Podfile",
    "Rakefile",
];

const UNSUPPORTED_DOCUMENT_EXTENSIONS: &[&str] =
    &["pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx"];

pub(super) struct ApplyPatchTool;
pub(super) struct GeneratePatchTool;

impl AgentTool for ApplyPatchTool {
    fn definition(&self) -> AgentToolDefinition {
        AgentToolDefinition {
            name: "apply_patch".to_string(),
            description: "Request approval to apply a unified diff to a text/code/config file inside the selected workspace. This tool never writes files automatically.".to_string(),
            input_schema: patch_input_schema(),
            safety: AgentToolSafety::RequiresApproval,
            requires_workspace: true,
            requires_approval: true,
        }
    }

    fn execute(&self, _context: &ToolExecutionContext, _args: Value) -> AgentResult<Value> {
        Err(AgentError::new(
            "apply_patch 需要用户审批和 host 执行层，不能由 agent runtime 自动应用。",
        ))
    }

    fn proposed_action(&self, call: &AgentToolCall) -> AgentResult<AgentProposedAction> {
        Ok(AgentProposedAction::Diff {
            diff: diff_proposal_from_call(call)?,
        })
    }
}

impl AgentTool for GeneratePatchTool {
    fn definition(&self) -> AgentToolDefinition {
        AgentToolDefinition {
            name: "generate_patch".to_string(),
            description: "Propose a unified diff for a text/code/config file inside the selected workspace. This tool does not write files; it returns a diff action for user review.".to_string(),
            input_schema: patch_input_schema(),
            safety: AgentToolSafety::RequiresApproval,
            requires_workspace: true,
            requires_approval: true,
        }
    }

    fn execute(&self, _context: &ToolExecutionContext, _args: Value) -> AgentResult<Value> {
        Err(AgentError::new(
            "generate_patch 只生成待审批 diff proposal，不能由 agent runtime 自动应用。",
        ))
    }

    fn proposed_action(&self, call: &AgentToolCall) -> AgentResult<AgentProposedAction> {
        Ok(AgentProposedAction::Diff {
            diff: diff_proposal_from_call(call)?,
        })
    }
}

fn patch_input_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "filePath": { "type": "string", "description": "Workspace-relative file path to modify or create." },
            "path": { "type": "string", "description": "Alias for filePath." },
            "patch": { "type": "string", "description": "Unified diff for exactly this file." },
            "diff": { "type": "string", "description": "Alias for patch." },
            "summary": { "type": "string", "description": "Short human-readable summary of the proposed change." }
        },
        "anyOf": [
            { "required": ["filePath", "patch"] },
            { "required": ["filePath", "diff"] },
            { "required": ["path", "patch"] },
            { "required": ["path", "diff"] }
        ]
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeneratePatchArgs {
    path: Option<String>,
    file_path: Option<String>,
    patch: Option<String>,
    diff: Option<String>,
    summary: Option<String>,
}

fn diff_proposal_from_call(call: &AgentToolCall) -> AgentResult<AgentDiffProposal> {
    let args: GeneratePatchArgs = serde_json::from_value(call.args.clone())
        .map_err(|error| AgentError::new(format!("generate_patch 参数无效：{error}")))?;
    let file_path = sanitize_file_path(args.path.or(args.file_path))?;
    let patch = sanitize_patch(args.patch.or(args.diff))?;
    validate_patch_target(&patch, &file_path)?;
    let summary = sanitize_summary(args.summary);

    Ok(AgentDiffProposal {
        id: call.id.clone(),
        file_path,
        patch,
        summary,
        approval_status: AgentApprovalStatus::Required,
    })
}

fn sanitize_file_path(path: Option<String>) -> AgentResult<String> {
    let path = path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| AgentError::new("generate_patch.filePath 不能为空。"))?;
    let cleaned = clean_relative_path(path)?;
    let normalized = cleaned
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(part) => Some(part.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");

    validate_text_patch_path(&normalized)?;

    Ok(normalized)
}

fn validate_text_patch_path(path: &str) -> AgentResult<()> {
    let file_name = Path::new(path)
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .unwrap_or_default();

    if TEXT_PATCH_BASENAMES
        .iter()
        .any(|basename| file_name == *basename)
    {
        return Ok(());
    }

    let lower_name = file_name.to_ascii_lowercase();
    if TEXT_PATCH_BASENAMES
        .iter()
        .any(|basename| lower_name == basename.to_ascii_lowercase())
    {
        return Ok(());
    }

    if lower_name.ends_with(".d.ts") {
        return Ok(());
    }

    let extension = Path::new(&lower_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default();
    if UNSUPPORTED_DOCUMENT_EXTENSIONS
        .iter()
        .any(|unsupported| extension == *unsupported)
    {
        return Err(AgentError::new(format!(
            "generate_patch 不支持直接修改 .{extension} 文档。PDF/Office 文件需要专用编辑工具。"
        )));
    }
    if TEXT_PATCH_EXTENSIONS
        .iter()
        .any(|allowed| extension == *allowed)
    {
        return Ok(());
    }

    Err(AgentError::new(format!(
        "generate_patch 暂不支持该文件类型：{path}。当前只支持文本、代码、配置、CSV/TSV、Markdown、JSON/YAML/TOML/XML/SVG/IPYNB 等可 diff 文件。"
    )))
}

fn sanitize_patch(patch: Option<String>) -> AgentResult<String> {
    let patch = patch.ok_or_else(|| AgentError::new("generate_patch.patch 不能为空。"))?;
    if patch.trim().is_empty() {
        return Err(AgentError::new("generate_patch.patch 不能为空。"));
    }
    if patch.chars().count() > MAX_PATCH_CHARS {
        return Err(AgentError::new(format!(
            "generate_patch.patch 过长，最多允许 {MAX_PATCH_CHARS} 个字符。"
        )));
    }
    if patch.contains('\0') {
        return Err(AgentError::new("generate_patch.patch 不能包含空字符。"));
    }
    if !looks_like_unified_diff(&patch) {
        return Err(AgentError::new(
            "generate_patch.patch 必须是 unified diff，至少包含 ---、+++ 和 @@ 行。",
        ));
    }

    Ok(patch)
}

fn looks_like_unified_diff(patch: &str) -> bool {
    let has_old = patch.lines().any(|line| line.starts_with("--- "));
    let has_new = patch.lines().any(|line| line.starts_with("+++ "));
    let has_hunk = patch.lines().any(|line| line.starts_with("@@ "));

    has_old && has_new && has_hunk
}

fn validate_patch_target(patch: &str, file_path: &str) -> AgentResult<()> {
    let target_is_mentioned = patch.lines().any(|line| {
        if line.starts_with("diff --git ") {
            return line.contains(&format!(" a/{file_path} "))
                || line.contains(&format!(" b/{file_path}"))
                || line.contains(file_path);
        }
        if line.starts_with("--- ") || line.starts_with("+++ ") {
            return line.contains(file_path) || line.contains("/dev/null");
        }

        false
    });

    if !target_is_mentioned {
        return Err(AgentError::new(
            "generate_patch.patch 必须引用 filePath 对应的目标文件。",
        ));
    }

    Ok(())
}

fn sanitize_summary(summary: Option<String>) -> Option<String> {
    summary
        .map(|summary| summary.trim().chars().take(MAX_SUMMARY_CHARS).collect())
        .filter(|summary: &String| !summary.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{AgentApprovalStatus, AgentToolCall};
    use serde_json::json;

    #[test]
    fn builds_diff_proposal_for_text_patch() {
        let call = AgentToolCall {
            id: "tool-1".to_string(),
            tool: "generate_patch".to_string(),
            args: json!({
                "filePath": "src/main.rs",
                "patch": "--- a/src/main.rs\n+++ b/src/main.rs\n@@ -1 +1 @@\n-fn main() {}\n+fn main() { println!(\"hi\"); }\n",
                "summary": "Add greeting"
            }),
            approval_status: AgentApprovalStatus::Required,
            reason: None,
        };
        let proposal = diff_proposal_from_call(&call).unwrap();

        assert_eq!(proposal.id, "tool-1");
        assert_eq!(proposal.file_path, "src/main.rs");
        assert_eq!(proposal.summary.as_deref(), Some("Add greeting"));
        assert_eq!(proposal.approval_status, AgentApprovalStatus::Required);
    }

    #[test]
    fn accepts_common_text_file_names_and_extensions() {
        for path in [
            ".env",
            ".gitignore",
            "Dockerfile",
            "CMakeLists.txt",
            "README.md",
            "notebook.ipynb",
            "data.csv",
            "types.d.ts",
            "src/App.tsx",
        ] {
            assert!(validate_text_patch_path(path).is_ok(), "{path}");
        }
    }

    #[test]
    fn rejects_office_and_pdf_paths() {
        for path in ["report.pdf", "slides.pptx", "sheet.xlsx", "legacy.doc"] {
            let error = validate_text_patch_path(path).unwrap_err();

            assert!(error.to_string().contains("专用编辑工具"), "{path}");
        }
    }

    #[test]
    fn rejects_non_unified_patch() {
        let error = sanitize_patch(Some("replace hello with world".to_string())).unwrap_err();

        assert!(error.to_string().contains("unified diff"));
    }

    #[test]
    fn rejects_patch_for_different_file() {
        let error = validate_patch_target(
            "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-old\n+new\n",
            "src/main.rs",
        )
        .unwrap_err();

        assert!(error.to_string().contains("目标文件"));
    }
}
