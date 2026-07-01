use crate::fs::{canonical_workspace_root, clean_relative_path, relative_display};
use my_copilot_agent::{AgentCommandRequest, AgentCommandRiskLevel};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MAX_TIMEOUT_MS: u64 = 600_000;
const MAX_OUTPUT_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandExecutionResult {
    pub command: String,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub cancelled: bool,
    pub duration_ms: u64,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

#[derive(Default)]
pub struct CommandRunState {
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl CommandRunState {
    pub fn register(&self, action_id: &str) -> CommandRunGuard<'_> {
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let mut running = self
            .running
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        running.insert(action_id.to_string(), cancel_flag.clone());

        CommandRunGuard {
            action_id: action_id.to_string(),
            cancel_flag,
            state: self,
        }
    }

    pub fn cancel(&self, action_id: &str) -> Result<bool, String> {
        let running = self
            .running
            .lock()
            .map_err(|_| "命令运行状态不可用。".to_string())?;
        let Some(cancel_flag) = running.get(action_id) else {
            return Ok(false);
        };

        cancel_flag.store(true, Ordering::SeqCst);
        Ok(true)
    }

    fn unregister(&self, action_id: &str) {
        let mut running = self
            .running
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        running.remove(action_id);
    }
}

pub struct CommandRunGuard<'a> {
    action_id: String,
    cancel_flag: Arc<AtomicBool>,
    state: &'a CommandRunState,
}

impl CommandRunGuard<'_> {
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        self.cancel_flag.clone()
    }
}

impl Drop for CommandRunGuard<'_> {
    fn drop(&mut self) {
        self.state.unregister(&self.action_id);
    }
}

pub fn run_approved_command(
    workspace_root: &Path,
    request: &AgentCommandRequest,
    cancel_flag: Option<Arc<AtomicBool>>,
) -> Result<CommandExecutionResult, String> {
    let root = canonical_workspace_root(workspace_root)?;
    let cwd = resolve_command_cwd(&root, request.cwd.as_deref())?;
    validate_command_request(request)?;
    run_shell_command(&cwd, &root, request, cancel_flag)
}

fn resolve_command_cwd(root: &Path, cwd: Option<&str>) -> Result<PathBuf, String> {
    let root = canonical_workspace_root(root)?;
    let Some(cwd) = cwd
        .map(str::trim)
        .filter(|cwd| !cwd.is_empty() && *cwd != ".")
    else {
        return Ok(root);
    };
    let relative = clean_relative_path(cwd)?;
    let resolved = root.join(relative);
    let canonical = resolved
        .canonicalize()
        .map_err(|error| format!("命令工作目录不可访问：{error}"))?;

    if !canonical.starts_with(&root) {
        return Err("命令工作目录必须位于已选择的 workspace 内。".to_string());
    }
    if !canonical.is_dir() {
        return Err("命令工作目录不是目录。".to_string());
    }

    Ok(canonical)
}

fn validate_command_request(request: &AgentCommandRequest) -> Result<(), String> {
    let command = request.command.trim();
    if command.is_empty() {
        return Err("命令不能为空。".to_string());
    }
    if command.contains('\0') || command.contains('\n') || command.contains('\r') {
        return Err("命令不能包含空字符或换行符。".to_string());
    }

    let risk_level = request.risk_level.unwrap_or(AgentCommandRiskLevel::Unknown);
    if risk_level == AgentCommandRiskLevel::Network {
        return Err("当前 command runner 阻止 network 风险命令。".to_string());
    }
    if risk_level == AgentCommandRiskLevel::Destructive {
        return Err("当前 command runner 阻止 destructive 风险命令。".to_string());
    }

    let lower = command.to_ascii_lowercase();
    if has_blocked_command_pattern(&lower) {
        return Err("命令包含被阻止的高风险操作。".to_string());
    }

    Ok(())
}

fn has_blocked_command_pattern(command: &str) -> bool {
    let program = command.split_whitespace().next().unwrap_or_default();
    matches!(
        program,
        "rm" | "mv"
            | "cp"
            | "chmod"
            | "chown"
            | "ln"
            | "truncate"
            | "dd"
            | "mkfs"
            | "curl"
            | "wget"
            | "ssh"
            | "scp"
            | "rsync"
            | "brew"
            | "pip"
            | "pip3"
            | "uv"
    ) || command.contains(" -delete")
        || command.contains(" git reset")
        || command.contains(" git checkout")
        || command.contains(" git clean")
        || command.contains(" git merge")
        || command.contains(" git rebase")
        || command.contains(" git commit")
        || command.contains(" git push")
        || command.contains(" npm install")
        || command.contains(" pnpm install")
        || command.contains(" yarn install")
        || command.contains(" cargo install")
}

fn run_shell_command(
    cwd: &Path,
    root: &Path,
    request: &AgentCommandRequest,
    cancel_flag: Option<Arc<AtomicBool>>,
) -> Result<CommandExecutionResult, String> {
    let timeout_ms = request
        .timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1, MAX_TIMEOUT_MS);
    let started = Instant::now();
    let mut child = Command::new("/bin/sh")
        .arg("-lc")
        .arg(&request.command)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("启动命令失败：{error}"))?;

    let deadline = Duration::from_millis(timeout_ms);
    let mut timed_out = false;
    let mut cancelled = false;
    loop {
        if cancel_flag
            .as_ref()
            .map(|cancel_flag| cancel_flag.load(Ordering::SeqCst))
            .unwrap_or(false)
        {
            cancelled = true;
            let _ = child.kill();
            break;
        }

        match child
            .try_wait()
            .map_err(|error| format!("等待命令失败：{error}"))?
        {
            Some(_) => break,
            None if started.elapsed() >= deadline => {
                timed_out = true;
                let _ = child.kill();
                break;
            }
            None => thread::sleep(Duration::from_millis(50)),
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("读取命令输出失败：{error}"))?;
    let (stdout, stdout_truncated) = truncate_output(&output.stdout);
    let (stderr, stderr_truncated) = truncate_output(&output.stderr);

    Ok(CommandExecutionResult {
        command: request.command.clone(),
        cwd: relative_cwd(root, cwd),
        exit_code: output.status.code(),
        stdout,
        stderr,
        timed_out,
        cancelled,
        duration_ms: started.elapsed().as_millis() as u64,
        stdout_truncated,
        stderr_truncated,
    })
}

fn relative_cwd(root: &Path, cwd: &Path) -> String {
    cwd.strip_prefix(root)
        .map(relative_display)
        .ok()
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| ".".to_string())
}

fn truncate_output(output: &[u8]) -> (String, bool) {
    if output.len() <= MAX_OUTPUT_BYTES {
        return (String::from_utf8_lossy(output).to_string(), false);
    }

    let mut end = MAX_OUTPUT_BYTES;
    while end > 0 && std::str::from_utf8(&output[..end]).is_err() {
        end -= 1;
    }
    let mut value = String::from_utf8_lossy(&output[..end]).to_string();
    value.push_str("\n...[truncated]");
    (value, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use my_copilot_agent::AgentApprovalStatus;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(1);

    #[test]
    fn resolves_cwd_inside_workspace() {
        let workspace = TestWorkspace::new();
        std::fs::create_dir_all(workspace.path.join("agent/rust")).unwrap();
        let cwd = resolve_command_cwd(&workspace.path, Some("agent/rust")).unwrap();

        assert!(cwd.ends_with("agent/rust"));
    }

    #[test]
    fn rejects_cwd_outside_workspace() {
        let workspace = TestWorkspace::new();
        let error = resolve_command_cwd(&workspace.path, Some("../outside")).unwrap_err();

        assert!(error.contains("路径不能包含"));
    }

    #[test]
    fn blocks_network_and_destructive_commands() {
        for (command, risk_level) in [
            ("pnpm install", AgentCommandRiskLevel::Network),
            ("rm -rf target", AgentCommandRiskLevel::Destructive),
        ] {
            let error = validate_command_request(&AgentCommandRequest {
                id: "tool-1".to_string(),
                command: command.to_string(),
                cwd: None,
                timeout_ms: None,
                approval_status: AgentApprovalStatus::Required,
                risk_level: Some(risk_level),
                reason: None,
            })
            .unwrap_err();

            assert!(error.contains("阻止"));
        }
    }

    #[test]
    fn runs_simple_command_in_workspace() {
        let workspace = TestWorkspace::new();
        let result = run_approved_command(
            &workspace.path,
            &AgentCommandRequest {
                id: "tool-1".to_string(),
                command: "printf hello".to_string(),
                cwd: None,
                timeout_ms: Some(5_000),
                approval_status: AgentApprovalStatus::Required,
                risk_level: Some(AgentCommandRiskLevel::ReadOnly),
                reason: None,
            },
            None,
        )
        .unwrap();

        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout, "hello");
        assert_eq!(result.cwd, ".");
        assert!(!result.cancelled);
    }

    struct TestWorkspace {
        path: PathBuf,
    }

    impl TestWorkspace {
        fn new() -> Self {
            let unique = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("my-copilot-command-runner-test-{unique}"));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();

            Self { path }
        }
    }

    impl Drop for TestWorkspace {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}
