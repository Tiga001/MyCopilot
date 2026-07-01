import { useCallback, useEffect, useRef, useState } from "react";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { ResizeHandle } from "../components/layout/ResizeHandle";
import { LeftSidebar } from "../components/sidebar/LeftSidebar";
import { RightSidebar } from "../components/sidebar/RightSidebar";
import { SettingsPage } from "../features/settings/SettingsPage";

const LEFT_DEFAULT_WIDTH = 288;
const RIGHT_DEFAULT_WIDTH = 360;
const LEFT_MIN_WIDTH = 220;
const RIGHT_MIN_WIDTH = 280;
const SIDE_MAX_WIDTH = 560;
const CENTER_MIN_WIDTH = 480;

type Side = "left" | "right";
type AppView = "workspace" | "settings";

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function App() {
  const shellRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<AppView>("workspace");
  const [leftWidth, setLeftWidth] = useState(LEFT_DEFAULT_WIDTH);
  const [rightWidth, setRightWidth] = useState(RIGHT_DEFAULT_WIDTH);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  const resizeSide = useCallback(
    (side: Side, deltaX: number) => {
      const shellWidth = shellRef.current?.clientWidth ?? window.innerWidth;
      const otherWidth = side === "left" ? (rightOpen ? rightWidth : 0) : leftOpen ? leftWidth : 0;
      const minimum = side === "left" ? LEFT_MIN_WIDTH : RIGHT_MIN_WIDTH;
      const availableMax = Math.max(minimum, shellWidth - otherWidth - CENTER_MIN_WIDTH);
      const maximum = Math.min(SIDE_MAX_WIDTH, availableMax);

      if (side === "left") {
        setLeftWidth((current) => clamp(current + deltaX, minimum, maximum));
      } else {
        setRightWidth((current) => clamp(current - deltaX, minimum, maximum));
      }
    },
    [leftOpen, leftWidth, rightOpen, rightWidth],
  );

  useEffect(() => {
    const keepCenterVisible = () => {
      const shellWidth = shellRef.current?.clientWidth ?? window.innerWidth;
      if (shellWidth < 920 && rightOpen) setRightOpen(false);
      if (shellWidth < 680 && leftOpen) setLeftOpen(false);
    };

    keepCenterVisible();
    window.addEventListener("resize", keepCenterVisible);
    return () => window.removeEventListener("resize", keepCenterVisible);
  }, [leftOpen, rightOpen]);

  if (view === "settings") {
    return <SettingsPage onBack={() => setView("workspace")} />;
  }

  return (
    <div
      ref={shellRef}
      className="app-shell"
      data-left-open={leftOpen}
      data-right-open={rightOpen}
      style={{
        "--left-panel-width": `${leftOpen ? leftWidth : 0}px`,
        "--right-panel-width": `${rightOpen ? rightWidth : 0}px`,
      } as React.CSSProperties}
    >
      <header className="window-toolbar" data-tauri-drag-region />

      <div className="side-panel side-panel--left">
        <LeftSidebar onOpenSettings={() => setView("settings")} />
      </div>

      {leftOpen && (
        <ResizeHandle
          side="left"
          onResize={(deltaX) => resizeSide("left", deltaX)}
        />
      )}

      <main className="main-panel" aria-label="主工作区">
        <div className="main-panel__toolbar" data-tauri-drag-region>
          <button
            className="panel-toggle panel-toggle--left"
            type="button"
            aria-label={leftOpen ? "折叠左侧栏" : "展开左侧栏"}
            aria-pressed={leftOpen}
            onClick={() => setLeftOpen((value) => !value)}
          >
            {leftOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
          </button>

          <button
            className="panel-toggle panel-toggle--right"
            type="button"
            aria-label={rightOpen ? "折叠右侧栏" : "展开右侧栏"}
            aria-pressed={rightOpen}
            onClick={() => setRightOpen((value) => !value)}
          >
            {rightOpen ? <PanelRightClose /> : <PanelRightOpen />}
          </button>
        </div>
        <div className="main-panel__surface" />
      </main>

      {rightOpen && (
        <ResizeHandle
          side="right"
          onResize={(deltaX) => resizeSide("right", deltaX)}
        />
      )}

      <div className="side-panel side-panel--right">
        <RightSidebar />
      </div>
    </div>
  );
}
