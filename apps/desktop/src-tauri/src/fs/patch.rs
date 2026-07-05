use crate::fs::{canonical_workspace_root, clean_relative_path, relative_display};
use crate::permissions::require_patch_write;
use my_copilot_agent::{content_revision, AgentPatchOperation, AgentPermissions};
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
    operation: AgentPatchOperation,
    expected_file_path: &str,
    patch: &str,
    expected_base_revision: Option<&str>,
    permissions: AgentPermissions,
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
    let target = resolve_patch_target(&root, expected_file_path)?;
    require_patch_write(permissions, target.outside_workspace)?;
    reject_unsupported_extension(&target.display_path)?;
    validate_patch_operation(&target, operation, patch)?;
    validate_base_revision(&target, operation, expected_base_revision)?;
    let paths = validate_patch_paths(&root, &target, patch)?;

    let (apply_root, apply_patch) = if target.outside_workspace {
        let parent = target
            .absolute_path
            .parent()
            .ok_or_else(|| "外部 patch 目标缺少父目录。".to_string())?
            .canonicalize()
            .map_err(|error| format!("外部 patch 目标父目录不可访问：{error}"))?;
        (parent, rewrite_patch_for_external_target(patch, &target)?)
    } else {
        (root.clone(), patch.to_string())
    };

    run_git_apply(&apply_root, &apply_patch, true)?;
    run_git_apply(&apply_root, &apply_patch, false)?;

    Ok(PatchApplyResult {
        file_paths: paths.into_iter().collect(),
    })
}

fn validate_base_revision(
    target: &ResolvedPatchTarget,
    operation: AgentPatchOperation,
    expected: Option<&str>,
) -> Result<(), String> {
    let Some(expected) = expected.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    if operation == AgentPatchOperation::Create {
        return Err("create 操作不能携带 baseRevision。".to_string());
    }
    let bytes = std::fs::read(&target.absolute_path)
        .map_err(|error| format!("校验 patch baseRevision 时读取文件失败：{error}"))?;
    let actual = content_revision(&bytes);
    if actual != expected {
        return Err(format!(
            "文件在审批前已发生变化：expected baseRevision `{expected}`，current `{actual}`。请重新读取并生成编辑。"
        ));
    }
    Ok(())
}

fn validate_patch_operation(
    target: &ResolvedPatchTarget,
    operation: AgentPatchOperation,
    patch: &str,
) -> Result<(), String> {
    let old_path = patch_header_path(patch, "--- ")?;
    let new_path = patch_header_path(patch, "+++ ")?;
    let old_is_null = old_path == "/dev/null";
    let new_is_null = new_path == "/dev/null";
    let target_exists = target.absolute_path.exists();

    match operation {
        AgentPatchOperation::Create if target_exists => {
            return Err("create 操作要求目标文件当前不存在。".to_string())
        }
        AgentPatchOperation::Create if !old_is_null || new_is_null => {
            return Err("create patch 必须使用 --- /dev/null 和目标文件 +++ 路径。".to_string())
        }
        AgentPatchOperation::Update if !target_exists => {
            return Err("update 操作要求目标文件当前存在。".to_string())
        }
        AgentPatchOperation::Update if old_is_null || new_is_null => {
            return Err("update patch 的 --- 和 +++ 都必须指向目标文件。".to_string())
        }
        AgentPatchOperation::Delete if !target_exists => {
            return Err("delete 操作要求目标文件当前存在。".to_string())
        }
        AgentPatchOperation::Delete if old_is_null || !new_is_null => {
            return Err("delete patch 必须使用目标文件 --- 路径和 +++ /dev/null。".to_string())
        }
        _ => {}
    }

    Ok(())
}

fn patch_header_path(patch: &str, prefix: &str) -> Result<String, String> {
    patch
        .lines()
        .find_map(|line| line.strip_prefix(prefix))
        .map(|value| {
            value
                .split('\t')
                .next()
                .unwrap_or(value)
                .trim()
                .trim_matches('"')
                .to_string()
        })
        .ok_or_else(|| format!("patch 缺少 {prefix}header。"))
}

fn validate_patch_paths(
    root: &Path,
    target: &ResolvedPatchTarget,
    patch: &str,
) -> Result<BTreeSet<String>, String> {
    let paths = extract_patch_paths(patch)?;
    if paths.is_empty() {
        return Err("patch 没有声明目标文件路径。".to_string());
    }

    let mut normalized_paths = BTreeSet::new();
    for path in paths {
        let normalized = normalize_declared_patch_path(root, target, &path)?;
        reject_unsupported_extension(&normalized)?;
        if normalized != target.display_path {
            return Err(format!(
                "patch 只能修改声明的文件：expected `{}`，found `{normalized}`。",
                target.display_path
            ));
        }

        if target.outside_workspace {
            validate_external_target(target)?;
        } else {
            validate_no_symlink_parent(root, &normalized)?;
        }
        normalized_paths.insert(normalized);
    }

    Ok(normalized_paths)
}

fn extract_patch_paths(patch: &str) -> Result<BTreeSet<String>, String> {
    let mut paths = BTreeSet::new();
    let mut has_hunk = false;
    let mut has_file_mode_change = false;

    for line in patch.lines() {
        if line.starts_with("@@ ") {
            has_hunk = true;
            continue;
        }
        if line.starts_with("new file mode ") || line.starts_with("deleted file mode ") {
            has_file_mode_change = true;
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

    if !has_hunk && !has_file_mode_change {
        return Err("patch 必须包含 unified diff hunk（@@）或文件模式变更。".to_string());
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

struct ResolvedPatchTarget {
    absolute_path: PathBuf,
    display_path: String,
    outside_workspace: bool,
}

fn resolve_patch_target(root: &Path, path: &str) -> Result<ResolvedPatchTarget, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("patch 目标路径不能为空。".to_string());
    }

    let candidate = Path::new(path);
    if !candidate.is_absolute() {
        let display_path = normalize_patch_path(path)?;
        return Ok(ResolvedPatchTarget {
            absolute_path: root.join(&display_path),
            display_path,
            outside_workspace: false,
        });
    }

    let absolute_path = normalize_absolute_target(candidate)?;
    let outside_workspace = !absolute_path.starts_with(root);
    let display_path = if outside_workspace {
        absolute_path.to_string_lossy().to_string()
    } else {
        relative_display(
            &absolute_path
                .strip_prefix(root)
                .map(Path::to_path_buf)
                .map_err(|_| "无法解析 workspace 内 patch 路径。".to_string())?,
        )
    };

    Ok(ResolvedPatchTarget {
        absolute_path,
        display_path,
        outside_workspace,
    })
}

fn normalize_absolute_target(path: &Path) -> Result<PathBuf, String> {
    let file_name = path
        .file_name()
        .ok_or_else(|| "patch 目标必须是文件路径。".to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "patch 目标缺少父目录。".to_string())?
        .canonicalize()
        .map_err(|error| format!("patch 目标父目录不可访问：{error}"))?;
    Ok(parent.join(file_name))
}

fn normalize_declared_patch_path(
    root: &Path,
    target: &ResolvedPatchTarget,
    path: &str,
) -> Result<String, String> {
    if target.outside_workspace {
        let declared = Path::new(path);
        if !declared.is_absolute() {
            return Err("工作区外 patch 的 diff header 必须使用目标绝对路径。".to_string());
        }
        return Ok(normalize_absolute_target(declared)?
            .to_string_lossy()
            .to_string());
    }

    let declared = Path::new(path);
    if declared.is_absolute() {
        let absolute = normalize_absolute_target(declared)?;
        return absolute
            .strip_prefix(root)
            .map(relative_display)
            .map_err(|_| "patch header 路径不在 workspace 内。".to_string());
    }
    normalize_patch_path(path)
}

fn validate_external_target(target: &ResolvedPatchTarget) -> Result<(), String> {
    if target.absolute_path.exists() {
        let metadata = std::fs::symlink_metadata(&target.absolute_path)
            .map_err(|error| format!("读取外部 patch 目标元数据失败：{error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("外部 patch 目标不能是符号链接。".to_string());
        }
        if !metadata.is_file() {
            return Err("外部 patch 目标必须是文件。".to_string());
        }
    }
    Ok(())
}

fn rewrite_patch_for_external_target(
    patch: &str,
    target: &ResolvedPatchTarget,
) -> Result<String, String> {
    let file_name = target
        .absolute_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "外部 patch 目标文件名不是有效 UTF-8。".to_string())?;
    let mut output = String::with_capacity(patch.len());

    for line in patch.split_inclusive('\n') {
        let newline = if line.ends_with('\n') { "\n" } else { "" };
        let content = line.strip_suffix('\n').unwrap_or(line);
        let rewritten = if content.starts_with("diff --git ") {
            format!("diff --git a/{file_name} b/{file_name}")
        } else if let Some(value) = content.strip_prefix("--- ") {
            rewrite_external_header("--- ", value, file_name)
        } else if let Some(value) = content.strip_prefix("+++ ") {
            rewrite_external_header("+++ ", value, file_name)
        } else {
            content.to_string()
        };
        output.push_str(&rewritten);
        output.push_str(newline);
    }

    Ok(output)
}

fn rewrite_external_header(prefix: &str, value: &str, file_name: &str) -> String {
    let (path, suffix) = value
        .split_once('\t')
        .map(|(path, suffix)| (path, format!("\t{suffix}")))
        .unwrap_or((value, String::new()));
    if path.trim_matches('"') == "/dev/null" {
        format!("{prefix}/dev/null{suffix}")
    } else {
        format!("{prefix}{file_name}{suffix}")
    }
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
    use my_copilot_agent::{AgentCommandPermission, AgentReadPermission, AgentWritePermission};
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
        let target = resolve_patch_target(&root.path, "src/main.rs").unwrap();
        let error = validate_patch_paths(
            &root.path,
            &target,
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

    #[test]
    fn external_patch_requires_all_write_permission() {
        let workspace = TestWorkspace::new();
        let external_root = std::env::temp_dir().join(format!(
            "my-copilot-desktop-external-patch-test-{}",
            TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&external_root);
        std::fs::create_dir_all(&external_root).unwrap();
        let target = external_root.join("notes.txt");
        std::fs::write(&target, "old\n").unwrap();
        let target_display = target.to_string_lossy();
        let patch =
            format!("--- {target_display}\n+++ {target_display}\n@@ -1 +1 @@\n-old\n+new\n");
        let workspace_only = AgentPermissions {
            read: AgentReadPermission::WorkspaceOnly,
            write: AgentWritePermission::WorkspaceOnly,
            command: AgentCommandPermission::RequireApproval,
        };

        let error = apply_unified_diff(
            &workspace.path,
            AgentPatchOperation::Update,
            &target_display,
            &patch,
            None,
            workspace_only,
        )
        .unwrap_err();
        assert!(error.contains("仅允许修改 workspace"));

        let all = AgentPermissions {
            write: AgentWritePermission::All,
            ..workspace_only
        };
        let result = apply_unified_diff(
            &workspace.path,
            AgentPatchOperation::Update,
            &target_display,
            &patch,
            None,
            all,
        )
        .unwrap();
        assert_eq!(
            result.file_paths,
            vec![target.canonicalize().unwrap().to_string_lossy().to_string()]
        );
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new\n");

        let _ = std::fs::remove_dir_all(external_root);
    }

    #[test]
    fn applies_create_and_delete_operations() {
        let workspace = TestWorkspace::new();
        let permissions = AgentPermissions {
            read: AgentReadPermission::WorkspaceOnly,
            write: AgentWritePermission::WorkspaceOnly,
            command: AgentCommandPermission::RequireApproval,
        };
        let create = "--- /dev/null\n+++ b/src/new.txt\n@@ -0,0 +1 @@\n+created\n";
        apply_unified_diff(
            &workspace.path,
            AgentPatchOperation::Create,
            "src/new.txt",
            create,
            None,
            permissions,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(workspace.path.join("src/new.txt")).unwrap(),
            "created\n"
        );

        let delete = "--- a/src/new.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-created\n";
        apply_unified_diff(
            &workspace.path,
            AgentPatchOperation::Delete,
            "src/new.txt",
            delete,
            None,
            permissions,
        )
        .unwrap();
        assert!(!workspace.path.join("src/new.txt").exists());
    }

    #[test]
    fn rejects_patch_when_base_revision_is_stale() {
        let workspace = TestWorkspace::new();
        let target = workspace.path.join("src/notes.txt");
        std::fs::write(&target, "changed\n").unwrap();
        let permissions = AgentPermissions {
            read: AgentReadPermission::WorkspaceOnly,
            write: AgentWritePermission::WorkspaceOnly,
            command: AgentCommandPermission::RequireApproval,
        };
        let patch = "--- a/src/notes.txt\n+++ b/src/notes.txt\n@@ -1 +1 @@\n-old\n+new\n";
        let stale = content_revision(b"old\n");

        let error = apply_unified_diff(
            &workspace.path,
            AgentPatchOperation::Update,
            "src/notes.txt",
            patch,
            Some(&stale),
            permissions,
        )
        .unwrap_err();

        assert!(error.contains("审批前已发生变化"));
        assert_eq!(std::fs::read_to_string(target).unwrap(), "changed\n");
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
