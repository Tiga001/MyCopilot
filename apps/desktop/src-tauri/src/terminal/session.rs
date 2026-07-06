// Implements the right-sidebar embedded command-line terminal feature.
// Owns real PTY sessions so the UI can embed a terminal like an IDE.

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{Emitter, Window};

const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;
const MIN_COLS: u16 = 20;
const MIN_ROWS: u16 = 4;
const MAX_COLS: u16 = 500;
const MAX_ROWS: u16 = 300;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCreateSessionRequest {
    pub cwd: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionSnapshot {
    pub session_id: String,
    pub cwd: String,
    pub shell: String,
    pub cols: u16,
    pub rows: u16,
    pub process_id: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputEvent {
    session_id: String,
    data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitEvent {
    session_id: String,
    exit_code: Option<u32>,
    signal: Option<String>,
}

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        let _ = self.killer.kill();
    }
}

#[derive(Clone, Default)]
pub struct TerminalSessionState {
    next_id: Arc<AtomicU64>,
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
}

impl TerminalSessionState {
    pub fn create_session(
        &self,
        window: Window,
        request: TerminalCreateSessionRequest,
    ) -> Result<TerminalSessionSnapshot, String> {
        let cwd = resolve_cwd(request.cwd.as_deref())?;
        let shell = resolve_shell();
        let size = pty_size(request.cols, request.rows);
        let session_id = match request.session_id.as_deref() {
            Some(value) => validate_requested_session_id(value)?,
            None => self.next_session_id(),
        };
        {
            let sessions = self.lock_sessions()?;
            if sessions.contains_key(&session_id) {
                return Err("终端会话 ID 已存在。".to_string());
            }
        }

        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(size)
            .map_err(|error| format!("创建终端 PTY 失败：{error}"))?;

        let mut command = CommandBuilder::new(&shell);
        command.cwd(&cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("TERM_PROGRAM", "MyCopilot");

        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("启动终端 shell 失败：{error}"))?;
        let process_id = child.process_id();
        let killer = child.clone_killer();
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("打开终端输出流失败：{error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("打开终端输入流失败：{error}"))?;

        let snapshot = TerminalSessionSnapshot {
            session_id: session_id.clone(),
            cwd: cwd.to_string_lossy().to_string(),
            shell,
            cols: size.cols,
            rows: size.rows,
            process_id,
        };

        {
            let mut sessions = self.lock_sessions()?;
            if sessions.contains_key(&session_id) {
                return Err("终端会话 ID 已存在。".to_string());
            }
            sessions.insert(
                session_id.clone(),
                TerminalSession {
                    master: pair.master,
                    writer,
                    killer,
                },
            );
        }

        self.spawn_reader(session_id, reader, child, window);
        Ok(snapshot)
    }

    pub fn write_input(&self, session_id: &str, data: &str) -> Result<(), String> {
        let mut sessions = self.lock_sessions()?;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| "终端会话不存在或已退出。".to_string())?;

        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|error| format!("写入终端输入失败：{error}"))?;
        session
            .writer
            .flush()
            .map_err(|error| format!("刷新终端输入失败：{error}"))?;
        Ok(())
    }

    pub fn resize_session(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.lock_sessions()?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| "终端会话不存在或已退出。".to_string())?;

        session
            .master
            .resize(pty_size(Some(cols), Some(rows)))
            .map_err(|error| format!("调整终端尺寸失败：{error}"))
    }

    pub fn kill_session(&self, session_id: &str) -> Result<bool, String> {
        let removed_session = {
            let mut sessions = self.lock_sessions()?;
            sessions.remove(session_id)
        };
        let Some(mut session) = removed_session else {
            return Ok(false);
        };

        session
            .killer
            .kill()
            .map_err(|error| format!("关闭终端会话失败：{error}"))?;
        Ok(true)
    }

    fn next_session_id(&self) -> String {
        let value = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        format!("terminal-{value}")
    }

    fn lock_sessions(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, TerminalSession>>, String> {
        self.sessions
            .lock()
            .map_err(|_| "终端会话状态不可用。".to_string())
    }

    fn remove_finished_session(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(session_id);
        }
    }

    fn spawn_reader(
        &self,
        session_id: String,
        mut reader: Box<dyn Read + Send>,
        mut child: Box<dyn portable_pty::Child + Send + Sync>,
        window: Window,
    ) {
        let state = self.clone();
        thread::spawn(move || {
            let mut buffer = [0_u8; 8192];

            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(byte_count) => {
                        let _ = window.emit(
                            "terminal_output",
                            TerminalOutputEvent {
                                session_id: session_id.clone(),
                                data: buffer[..byte_count].to_vec(),
                            },
                        );
                    }
                    Err(error) => {
                        let _ = window.emit(
                            "terminal_output",
                            TerminalOutputEvent {
                                session_id: session_id.clone(),
                                data: format!("\r\n[terminal output error: {error}]\r\n")
                                    .into_bytes(),
                            },
                        );
                        break;
                    }
                }
            }

            let exit_status = child.wait().ok();
            state.remove_finished_session(&session_id);
            let _ = window.emit(
                "terminal_exit",
                TerminalExitEvent {
                    session_id,
                    exit_code: exit_status.as_ref().map(|status| status.exit_code()),
                    signal: exit_status
                        .as_ref()
                        .and_then(|status| status.signal().map(ToOwned::to_owned)),
                },
            );
        });
    }
}

fn resolve_cwd(cwd: Option<&str>) -> Result<PathBuf, String> {
    let requested = cwd.map(str::trim).filter(|value| !value.is_empty());
    let path = match requested {
        Some(value) => PathBuf::from(value),
        None => std::env::var_os("HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .ok_or_else(|| "无法确定终端工作目录。".to_string())?,
    };

    let canonical = path
        .canonicalize()
        .map_err(|error| format!("终端工作目录不可访问：{error}"))?;
    if !canonical.is_dir() {
        return Err("终端工作目录不是目录。".to_string());
    }

    Ok(canonical)
}

fn resolve_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .map(|shell| shell.trim().to_string())
        .filter(|shell| !shell.is_empty())
        .unwrap_or_else(default_shell)
}

fn validate_requested_session_id(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 80 {
        return Err("终端会话 ID 无效。".to_string());
    }
    if !trimmed
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("终端会话 ID 包含不支持的字符。".to_string());
    }

    Ok(trimmed.to_string())
}

fn default_shell() -> String {
    if cfg!(windows) {
        "powershell.exe".to_string()
    } else if cfg!(target_os = "macos") {
        "/bin/zsh".to_string()
    } else {
        "/bin/sh".to_string()
    }
}

fn pty_size(cols: Option<u16>, rows: Option<u16>) -> PtySize {
    PtySize {
        cols: cols.unwrap_or(DEFAULT_COLS).clamp(MIN_COLS, MAX_COLS),
        rows: rows.unwrap_or(DEFAULT_ROWS).clamp(MIN_ROWS, MAX_ROWS),
        pixel_width: 0,
        pixel_height: 0,
    }
}
