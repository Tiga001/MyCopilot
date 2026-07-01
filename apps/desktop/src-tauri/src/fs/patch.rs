use crate::fs::{canonical_workspace_root, clean_relative_path, relative_display};
use serde::Serialize;
use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const MAX_PATCH_BYTES: usize = 512 * 1024;
const UNSUPPORTED_PATCH_EXTENSIONS: &[&str] = &["pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchApplyResult {
    pub file_paths: Vec<String>,
}

pub fn apply_unified_diff(
    workspace_root: &Path,
    expected_file_path: &str,
    patch: &str,
) -> Result<PatchApplyResult, String> {
    if patch.as_bytes().len() > MAX_PATCH_BYTES {
        return Err(format!(
            "patch 过大：{} bytes，超过 {} bytes 限制。",
            patch.as_bytes().len(),
            MAX_PATCH_BYTES
        ));
    }
    if patch.contains('\0') {
        return Err("patch 不能包含空字符。".to_string());
    }

    let root = canonical_workspace_root(workspace_root)?;
    let expected = normalize_patch_path(expected_file_path)?;
    reject_unsupported_extension(&expected)?;
    let paths = validate_patch_paths(&root, &expected, patch)?;

    run_git_apply(&root, patch, true)?;
    run_git_apply(&root, patch, false)?;

    Ok(PatchApplyResult {
        file_paths: paths.into_iter().collect(),
    })
}

fn validate_patch_paths(
    root: &Path,
    expected_file_path: &str,
    patch: &str,
) -> Result<BTreeSet<String>, String> {
    let paths = extract_patch_paths(patch)?;
    if paths.is_empty() {
        return Err("patch 没有声明目标文件路径。".to_string());
    }

    let mut normalized_paths = BTreeSet::new();
    for path in paths {
        let normalized = normalize_patch_path(&path)?;
        reject_unsupported_extension(&normalized)?;
        if normalized != expected_file_path {
            return Err(format!(
                "patch 只能修改声明的文件：expected `{expected_file_path}`，found `{normalized}`。"
            ));
        }

        validate_no_symlink_parent(root, &normalized)?;
        normalized_paths.insert(normalized);
    }

    Ok(normalized_paths)
}

fn extract_patch_paths(patch: &str) -> Result<BTreeSet<String>, String> {
    let mut paths = BTreeSet::new();
    let mut has_hunk = false;

    for line in patch.lines() {
        if line.starts_with("@@ ") {
            has_hunk = true;
            continue;
        }

        if let Some(rest) = line.strip_prefix("diff --git ") {
            let mut parts = rest.split_whitespace();
            let left = parts.next();
            let right = parts.next();
            for candidate in [left, right].into_iter().flatten() {
                add_patch_path(&mut paths, candidate)?;
            }
            continue;
        }

        if let Some(candidate) = line
            .strip_prefix("--- ")
            .or_else(|| line.strip_prefix("+++ "))
        {
            add_patch_path(&mut paths, candidate)?;
        }
    }

    if !has_hunk {
        return Err("patch 必须包含 unified diff hunk（@@）。".to_string());
    }

    Ok(paths)
}

fn add_patch_path(paths: &mut BTreeSet<String>, candidate: &str) -> Result<(), String> {
    let candidate = candidate
        .split('\t')
        .next()
        .unwrap_or(candidate)
        .trim()
        .trim_matches('"');

    if candidate == "/dev/null" {
        return Ok(());
    }

    let candidate = candidate
        .strip_prefix("a/")
        .or_else(|| candidate.strip_prefix("b/"))
        .unwrap_or(candidate);
    if candidate.is_empty() {
        return Err("patch 路径不能为空。".to_string());
    }

    paths.insert(candidate.to_string());
    Ok(())
}

fn normalize_patch_path(path: &str) -> Result<String, String> {
    Ok(relative_display(&clean_relative_path(path)?))
}

fn reject_unsupported_extension(path: &str) -> Result<(), String> {
    let extension = Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();

    if UNSUPPORTED_PATCH_EXTENSIONS
        .iter()
        .any(|unsupported| extension == *unsupported)
    {
        return Err(format!(
            "不支持直接应用 .{extension} patch。PDF/Office 文件需要专用编辑工具。"
        ));
    }

    Ok(())
}

fn validate_no_symlink_parent(root: &Path, relative_path: &str) -> Result<(), String> {
    let relative = clean_relative_path(relative_path)?;
    let mut current = root.to_path_buf();
    let mut components = relative.components().peekable();

    while let Some(component) = components.next() {
        current.push(component.as_os_str());
        if !current.exists() {
            continue;
        }

        let metadata = std::fs::symlink_metadata(&current)
            .map_err(|error| format!("读取路径元数据失败：{error}"))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "patch 目标路径不能包含符号链接：{}",
                relative_display(&path_relative_to(root, &current)?)
            ));
        }

        if components.peek().is_some() && !metadata.is_dir() {
            return Err(format!(
                "patch 目标父路径不是目录：{}",
                relative_display(&path_relative_to(root, &current)?)
            ));
        }
    }

    Ok(())
}

fn path_relative_to(root: &Path, path: &Path) -> Result<PathBuf, String> {
    path.strip_prefix(root)
        .map(Path::to_path_buf)
        .map_err(|_| "路径不在 workspace 内。".to_string())
}

fn run_git_apply(root: &Path, patch: &str, check_only: bool) -> Result<(), String> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .arg("apply")
        .arg("--whitespace=nowarn");
    if check_only {
        command.arg("--check");
    }

    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("启动 git apply 失败：{error}"))?;

    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| "无法写入 git apply stdin。".to_string())?;
        stdin
            .write_all(patch.as_bytes())
            .map_err(|error| format!("写入 git apply patch 失败：{error}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("等待 git apply 完成失败：{error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let details = [stderr.trim(), stdout.trim()]
            .into_iter()
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!(
            "git apply{} 失败：{}",
            if check_only { " --check" } else { "" },
            if details.is_empty() {
                format!("exit status {}", output.status)
            } else {
                details
            }
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(1);

    #[test]
    fn extracts_and_validates_single_patch_path() {
        let paths = extract_patch_paths(
            "diff --git a/src/main.rs b/src/main.rs\n--- a/src/main.rs\n+++ b/src/main.rs\n@@ -1 +1 @@\n-old\n+new\n",
        )
        .unwrap();

        assert!(paths.contains("src/main.rs"));
    }

    #[test]
    fn rejects_path_mismatch() {
        let root = TestWorkspace::new();
        let error = validate_patch_paths(
            &root.path,
            "src/main.rs",
            "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-old\n+new\n",
        )
        .unwrap_err();

        assert!(error.contains("只能修改声明的文件"));
    }

    #[test]
    fn rejects_office_and_pdf_patch_targets() {
        let error = reject_unsupported_extension("report.pdf").unwrap_err();

        assert!(error.contains("专用编辑工具"));
    }

    struct TestWorkspace {
        path: PathBuf,
    }

    impl TestWorkspace {
        fn new() -> Self {
            let unique = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!("my-copilot-desktop-patch-test-{unique}"));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(path.join("src")).unwrap();

            Self { path }
        }
    }

    impl Drop for TestWorkspace {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}
