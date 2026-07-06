// Implements the right-sidebar embedded command-line terminal feature.
// Shared TypeScript shapes for the xterm UI and Tauri PTY bridge.

export interface TerminalCreateSessionRequest {
  cwd?: string;
  cols?: number;
  rows?: number;
  sessionId?: string;
}

export interface TerminalSessionSnapshot {
  sessionId: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  processId?: number | null;
}

export interface TerminalOutputEvent {
  sessionId: string;
  data: number[];
}

export interface TerminalExitEvent {
  sessionId: string;
  exitCode?: number | null;
  signal?: string | null;
}

export type TerminalSessionStatus = "starting" | "running" | "exited" | "error";
