import { MessageSquarePlus, Settings } from "lucide-react";
import "./LeftSidebar.css";

interface LeftSidebarProps {
  onOpenSettings: () => void;
}

export function LeftSidebar({ onOpenSettings }: LeftSidebarProps) {
  return (
    <aside className="left-sidebar" aria-label="左侧栏">
      <button className="left-sidebar__primary-action" type="button">
        <MessageSquarePlus aria-hidden="true" />
        <span>新对话</span>
      </button>

      <section className="left-sidebar__section left-sidebar__projects" aria-labelledby="projects-heading">
        <h2 id="projects-heading" className="left-sidebar__section-title">
          项目
        </h2>
        <div className="left-sidebar__project-space" aria-hidden="true" />
      </section>

      <section className="left-sidebar__section left-sidebar__conversations" aria-labelledby="conversations-heading">
        <h2 id="conversations-heading" className="left-sidebar__section-title">
          对话
        </h2>
        <p className="left-sidebar__empty-state">暂无聊天</p>
      </section>

      <button className="left-sidebar__settings" type="button" onClick={onOpenSettings}>
        <Settings aria-hidden="true" />
        <span>设置</span>
      </button>
    </aside>
  );
}
