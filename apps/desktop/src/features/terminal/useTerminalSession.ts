// Implements the right-sidebar embedded command-line terminal feature.
// Wires xterm.js to a Rust PTY session and owns cleanup on unmount.

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  createTerminalSession,
  killTerminalSession,
  listenToTerminalExit,
  listenToTerminalOutput,
  resizeTerminalSession,
  writeTerminalInput,
} from "./terminalClient";
import type {
  TerminalExitEvent,
  TerminalSessionSnapshot,
  TerminalSessionStatus,
} from "./terminalTypes";

interface UseTerminalSessionOptions {
  containerRef: RefObject<HTMLDivElement>;
  initialCwd?: string;
}

interface UseTerminalSessionResult {
  errorMessage: string | null;
  fitTerminal: () => void;
  session: TerminalSessionSnapshot | null;
  status: TerminalSessionStatus;
}

function formatExitMessage(event: TerminalExitEvent) {
  if (event.signal) {
    return `\r\n[terminal exited by ${event.signal}]\r\n`;
  }
  if (typeof event.exitCode === "number") {
    return `\r\n[terminal exited with code ${event.exitCode}]\r\n`;
  }
  return "\r\n[terminal exited]\r\n";
}

function createLocalSessionId() {
  const randomValue = Math.random().toString(36).slice(2, 10);
  return `terminal-${Date.now().toString(36)}-${randomValue}`;
}

function getCssColor(name: string, fallback: string) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function getTerminalTheme() {
  const foreground = getCssColor("--mc-color-text-primary", "#d7dce2");
  const muted = getCssColor("--mc-color-text-muted", "#8b949e");
  const background = getCssColor("--mc-color-surface-right-panel", "#0f1011");
  const accent = getCssColor("--mc-color-text-accent", "#6cb6ff");
  const danger = getCssColor("--mc-color-text-danger", "#ff7b72");

  return {
    background,
    black: getCssColor("--mc-color-surface-muted", "#1f2328"),
    blue: accent,
    brightBlack: muted,
    brightBlue: accent,
    brightCyan: accent,
    brightGreen: getCssColor("--mc-color-icon-success", "#7ee787"),
    brightMagenta: getCssColor("--mc-color-icon-accent", "#d2a8ff"),
    brightRed: danger,
    brightWhite: foreground,
    brightYellow: getCssColor("--mc-color-text-strong", "#ffdf8b"),
    cursor: foreground,
    cyan: accent,
    foreground,
    green: getCssColor("--mc-color-icon-success", "#7ee787"),
    magenta: getCssColor("--mc-color-icon-accent", "#d2a8ff"),
    red: danger,
    selectionBackground: getCssColor("--mc-color-surface-selected", "#365a7d"),
    white: foreground,
    yellow: getCssColor("--mc-color-text-strong", "#f2cc60"),
  };
}

export function useTerminalSession({
  containerRef,
  initialCwd,
}: UseTerminalSessionOptions): UseTerminalSessionResult {
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const initialCwdRef = useRef(initialCwd);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [session, setSession] = useState<TerminalSessionSnapshot | null>(null);
  const [status, setStatus] = useState<TerminalSessionStatus>("starting");

  const fitTerminal = useCallback(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;

    try {
      fitAddon.fit();
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        void resizeTerminalSession(sessionId, terminal.cols, terminal.rows).catch((error) => {
          console.error("Failed to resize embedded terminal", error);
        });
      }
    } catch (error) {
      console.error("Failed to fit embedded terminal", error);
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    let isDisposed = false;
    let resizeFrame = 0;
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      macOptionIsMeta: true,
      scrollback: 8000,
      theme: getTerminalTheme(),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const queueFit = () => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(fitTerminal);
    };

    const resizeObserver = new ResizeObserver(queueFit);
    resizeObserver.observe(container);

    const inputSubscription = terminal.onData((data) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;

      void writeTerminalInput(sessionId, data).catch((error) => {
        console.error("Failed to write embedded terminal input", error);
      });
    });

    let unlistenOutput: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;

    const startSession = async () => {
      const requestedSessionId = createLocalSessionId();
      sessionIdRef.current = requestedSessionId;

      try {
        fitAddon.fit();
        const nextSession = await createTerminalSession({
          cols: terminal.cols,
          cwd: initialCwdRef.current,
          rows: terminal.rows,
          sessionId: requestedSessionId,
        });

        if (isDisposed) {
          sessionIdRef.current = null;
          void killTerminalSession(nextSession.sessionId).catch((error) => {
            console.error("Failed to clean up embedded terminal session", error);
          });
          return;
        }

        sessionIdRef.current = nextSession.sessionId;
        setSession(nextSession);
        setStatus("running");
        terminal.focus();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sessionIdRef.current = null;
        terminal.write(`\r\n[terminal start failed: ${message}]\r\n`);
        setErrorMessage(message);
        setStatus("error");
      }
    };

    const initializeTerminalBridge = async () => {
      const [outputUnlisten, exitUnlisten] = await Promise.all([
        listenToTerminalOutput((event) => {
          if (event.sessionId !== sessionIdRef.current) return;
          terminal.write(new Uint8Array(event.data));
        }),
        listenToTerminalExit((event) => {
          if (event.sessionId !== sessionIdRef.current) return;
          terminal.write(formatExitMessage(event));
          sessionIdRef.current = null;
          setStatus("exited");
        }),
      ]);

      if (isDisposed) {
        outputUnlisten();
        exitUnlisten();
        return;
      }

      unlistenOutput = outputUnlisten;
      unlistenExit = exitUnlisten;
      await startSession();
    };

    queueFit();
    void initializeTerminalBridge().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      terminal.write(`\r\n[terminal bridge failed: ${message}]\r\n`);
      setErrorMessage(message);
      setStatus("error");
    });

    return () => {
      isDisposed = true;
      window.cancelAnimationFrame(resizeFrame);
      resizeObserver.disconnect();
      inputSubscription.dispose();
      unlistenOutput?.();
      unlistenExit?.();

      const sessionId = sessionIdRef.current;
      sessionIdRef.current = null;
      if (sessionId) {
        void killTerminalSession(sessionId).catch((error) => {
          console.error("Failed to kill embedded terminal session", error);
        });
      }

      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [containerRef, fitTerminal]);

  return {
    errorMessage,
    fitTerminal,
    session,
    status,
  };
}
