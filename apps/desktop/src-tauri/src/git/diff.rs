use crate::fs::{canonical_workspace_root, clean_relative_path, relative_display};
use my_copilot_agent::AgentGitDiffSnapshot;
use std::path::Path;
use std::process::Command;

const MAX_GIT_DIFF_BYTES: usize = 240 * 1024;

pub fn read_git_diff(
    workspace_root: &Path,
    relative_path: Option<&str>,
) -> Result<AgentGitDiffSnapshot, String> {
    let root = canonical_workspace_root(workspace_root)?;
    let mut command = Command::new("git");
    command.arg("-C").arg(&root).arg("diff").arg("--");

    if let Some(relative_path) = relative_path
        .map(str::trim)
        .filter(|relative_path| !relative_path.is_empty())
    {
        command.arg(relative_display(&clean_relative_path(relative_path)?));
    }

    let output = command
        .output()
        .map_err(|error| format!("执行 git diff 失败：{error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git diff 返回失败：{}", stderr.trim()));
    }

    let patch = String::from_utf8_lossy(&output.stdout);
    let (patch, truncated) = truncate_bytes(&patch, MAX_GIT_DIFF_BYTES);

    Ok(AgentGitDiffSnapshot { patch, truncated })
}

fn truncate_bytes(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_string(), false);
    }

    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }

    let mut output = value[..end].to_string();
    output.push_str("\n...[truncated]");
    (output, true)
}
