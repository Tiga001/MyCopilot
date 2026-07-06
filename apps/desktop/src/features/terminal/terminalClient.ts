// Implements the right-sidebar embedded command-line terminal feature.
// This client keeps terminal IPC separate from agent command execution.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  TerminalCreateSessionRequest,
  TerminalExitEvent,
  TerminalOutputEvent,
  TerminalSessionSnapshot,
} from "./terminalTypes";

export function createTerminalSession(
  request: TerminalCreateSessionRequest,
): Promise<TerminalSessionSnapshot> {
  return invoke<TerminalSessionSnapshot>("terminal_create_session", { request });
}

export function writeTerminalInput(sessionId: string, data: string): Promise<void> {
  return invoke("terminal_write_input", { sessionId, data });
}

export function resizeTerminalSession(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("terminal_resize_session", { sessionId, cols, rows });
}

export function killTerminalSession(sessionId: string): Promise<boolean> {
  return invoke<boolean>("terminal_kill_session", { sessionId });
}

export function listenToTerminalOutput(
  handler: (event: TerminalOutputEvent) => void,
): Promise<() => void> {
  return listen<TerminalOutputEvent>("terminal_output", (event) => handler(event.payload));
}

export function listenToTerminalExit(
  handler: (event: TerminalExitEvent) => void,
): Promise<() => void> {
  return listen<TerminalExitEvent>("terminal_exit", (event) => handler(event.payload));
}
