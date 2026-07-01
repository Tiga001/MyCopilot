import { Maximize, Plus } from "lucide-react";
import "./RightSidebar.css";

const RIGHT_PANEL_ACTIONS = [
  {
    title: "审查",
    description: "Review proposed edits and change sets",
  },
  {
    title: "终端",
    description: "Run commands in the current workspace",
  },
] as const;

export function RightSidebar() {
  return (
    <aside className="right-sidebar" aria-label="右侧栏">
      <header className="right-sidebar__toolbar" data-tauri-drag-region>
        <div className="right-sidebar__toolbar-actions">
          <button className="right-sidebar__icon-button" type="button" aria-label="新建面板">
            <Plus aria-hidden="true" />
          </button>
          <button className="right-sidebar__icon-button" type="button" aria-label="最大化右侧栏">
            <Maximize aria-hidden="true" />
          </button>
        </div>
      </header>

      <nav className="right-sidebar__home" aria-label="右侧栏工具">
        {RIGHT_PANEL_ACTIONS.map((action) => (
          <button className="right-sidebar__tool-card" type="button" key={action.title}>
            <span className="right-sidebar__tool-title">{action.title}</span>
            <span className="right-sidebar__tool-description">{action.description}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
