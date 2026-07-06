// Implements the right-sidebar embedded command-line terminal feature.
// These Tauri commands expose PTY-backed terminal sessions to the React UI.

use super::session::{TerminalCreateSessionRequest, TerminalSessionSnapshot, TerminalSessionState};
use tauri::{State, Window};

#[tauri::command]
pub fn terminal_create_session(
    request: TerminalCreateSessionRequest,
    state: State<'_, TerminalSessionState>,
    window: Window,
) -> Result<TerminalSessionSnapshot, String> {
    state.create_session(window, request)
}

#[tauri::command]
pub fn terminal_write_input(
    session_id: String,
    data: String,
    state: State<'_, TerminalSessionState>,
) -> Result<(), String> {
    state.write_input(&session_id, &data)
}

#[tauri::command]
pub fn terminal_resize_session(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, TerminalSessionState>,
) -> Result<(), String> {
    state.resize_session(&session_id, cols, rows)
}

#[tauri::command]
pub fn terminal_kill_session(
    session_id: String,
    state: State<'_, TerminalSessionState>,
) -> Result<bool, String> {
    state.kill_session(&session_id)
}
