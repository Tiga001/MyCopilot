import {
  Archive,
  ChevronDown,
  FolderOpen,
  MoreHorizontal,
  NotebookText,
  PencilLine,
  Pin,
  Settings,
  SquarePen,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useFrontendConfig } from "../../config/FrontendConfigProvider";
import type { AppProject } from "../../config/projectConfig";
import type { ChatConversation } from "../../features/chat/chatTypes";
import "./LeftSidebar.css";

interface LeftSidebarProps {
  activeConversationId: string | null;
  conversations: ChatConversation[];
  isNewConversationActive: boolean;
  onArchiveConversation: (conversationId: string) => void;
  onArchiveProjectConversations: (projectId: string) => void;
  onNewConversation: (projectId?: string | null) => void;
  onOpenSettings: () => void;
  onRemoveProject: (projectId: string) => void;
  onRenameProject: (projectId: string, name: string) => void;
  onSelectConversation: (conversationId: string) => void;
  onShowProjectInFolder: (projectId: string) => void;
  onTogglePinConversation: (conversationId: string) => void;
  onTogglePinProject: (projectId: string) => void;
  projects: AppProject[];
}

function formatTemplate(template: string, values: Record<string, number | string>) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.split(`{${key}}`).join(String(value)),
    template,
  );
}

function formatConversationAge(updatedAt: number, now: number, language: string, justNow: string) {
  const elapsed = Math.max(0, now - updatedAt);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return justNow;

  if (minutes < 60) {
    return language === "zh-CN" ? `${minutes} 分` : `${minutes}m`;
  }

  const hours = Math.floor(elapsed / 3_600_000);
  if (hours < 24) {
    return language === "zh-CN" ? `${hours} 小时` : `${hours}h`;
  }

  const days = Math.floor(elapsed / 86_400_000);
  if (days < 7) {
    return language === "zh-CN" ? `${days} 天` : `${days}d`;
  }

  const weeks = Math.floor(days / 7);
  if (weeks < 5) {
    return language === "zh-CN" ? `${weeks} 周` : `${weeks}w`;
  }

  const months = Math.floor(days / 30);
  if (months < 12) {
    return language === "zh-CN" ? `${months} 个月` : `${months}mo`;
  }

  const years = Math.floor(days / 365);
  return language === "zh-CN" ? `${Math.max(1, years)} 年` : `${Math.max(1, years)}y`;
}

function sortConversations(conversations: ChatConversation[]) {
  return [...conversations].sort((a, b) => {
    const aPinned = a.pinnedAt ?? 0;
    const bPinned = b.pinnedAt ?? 0;

    if (aPinned || bPinned) {
      if (aPinned && bPinned) return bPinned - aPinned;
      return aPinned ? -1 : 1;
    }

    return b.updatedAt - a.updatedAt;
  });
}

function sortPinnedProjects(projects: AppProject[]) {
  return [...projects]
    .filter((project) => project.pinnedAt)
    .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
}

function sortRegularProjects(projects: AppProject[]) {
  return [...projects]
    .filter((project) => !project.pinnedAt)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function ConversationPinIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      className="left-sidebar__conversation-pin-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 17v5" />
      <path
        d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"
        fill={filled ? "currentColor" : "none"}
      />
    </svg>
  );
}

function ConversationRow({
  activeConversationId,
  archiveLabel,
  conversation,
  justNow,
  language,
  now,
  onArchiveConversation,
  onSelectConversation,
  onTogglePinConversation,
  pinLabel,
  unpinLabel,
  nested = false,
}: {
  activeConversationId: string | null;
  archiveLabel: string;
  conversation: ChatConversation;
  justNow: string;
  language: string;
  now: number;
  onArchiveConversation: (conversationId: string) => void;
  onSelectConversation: (conversationId: string) => void;
  onTogglePinConversation: (conversationId: string) => void;
  pinLabel: string;
  unpinLabel: string;
  nested?: boolean;
}) {
  const isPinned = Boolean(conversation.pinnedAt);

  return (
    <div
      className={`left-sidebar__conversation-row${nested ? " left-sidebar__conversation-row--nested" : ""}`}
      data-active={conversation.id === activeConversationId || undefined}
    >
      <button
        className="left-sidebar__conversation-main"
        type="button"
        onClick={() => onSelectConversation(conversation.id)}
      >
        <span className="left-sidebar__conversation-name">{conversation.title}</span>
      </button>

      <span className="left-sidebar__conversation-age">
        {formatConversationAge(conversation.updatedAt, now, language, justNow)}
      </span>

      <div className="left-sidebar__conversation-item-actions" aria-label={archiveLabel}>
        <button
          className="left-sidebar__conversation-item-action"
          type="button"
          data-pinned={isPinned || undefined}
          aria-label={isPinned ? unpinLabel : pinLabel}
          title={isPinned ? unpinLabel : pinLabel}
          onClick={() => onTogglePinConversation(conversation.id)}
        >
          <ConversationPinIcon filled={isPinned} />
        </button>
        <button
          className="left-sidebar__conversation-item-action"
          type="button"
          aria-label={archiveLabel}
          title={archiveLabel}
          onClick={() => onArchiveConversation(conversation.id)}
        >
          <Archive aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function LeftSidebar({
  activeConversationId,
  conversations,
  isNewConversationActive,
  onArchiveConversation,
  onArchiveProjectConversations,
  onNewConversation,
  onOpenSettings,
  onRemoveProject,
  onRenameProject,
  onSelectConversation,
  onShowProjectInFolder,
  onTogglePinConversation,
  onTogglePinProject,
  projects,
}: LeftSidebarProps) {
  const { language, t } = useFrontendConfig();
  const [areProjectsOpen, setAreProjectsOpen] = useState(true);
  const [areConversationsOpen, setAreConversationsOpen] = useState(true);
  const [openProjectIds, setOpenProjectIds] = useState<Set<string>>(new Set());
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null);
  const [renamingProject, setRenamingProject] = useState<AppProject | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pendingArchiveProject, setPendingArchiveProject] = useState<AppProject | null>(null);
  const [pendingRemoveProject, setPendingRemoveProject] = useState<AppProject | null>(null);
  const [now, setNow] = useState(Date.now());
  const projectIds = new Set(projects.map((project) => project.id));
  const visibleConversations = conversations.filter((conversation) => !conversation.archivedAt);
  const pinnedProjects = sortPinnedProjects(projects);
  const regularProjects = sortRegularProjects(projects);
  const pinnedRootConversations = sortConversations(
    visibleConversations.filter(
      (conversation) =>
        conversation.pinnedAt && (!conversation.projectId || !projectIds.has(conversation.projectId)),
    ),
  );
  const rootConversations = sortConversations(
    visibleConversations.filter(
      (conversation) =>
        !conversation.pinnedAt && (!conversation.projectId || !projectIds.has(conversation.projectId)),
    ),
  );
  const conversationsByProjectId = projects.reduce<Record<string, ChatConversation[]>>((accumulator, project) => {
    accumulator[project.id] = sortConversations(
      visibleConversations.filter((conversation) => conversation.projectId === project.id),
    );
    return accumulator;
  }, {});
  const activeConversation = visibleConversations.find((conversation) => conversation.id === activeConversationId);
  const hasPinnedItems = pinnedProjects.length > 0 || pinnedRootConversations.length > 0;

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (!activeConversation?.projectId) return;

    setOpenProjectIds((currentIds) => {
      if (currentIds.has(activeConversation.projectId!)) return currentIds;
      const nextIds = new Set(currentIds);
      nextIds.add(activeConversation.projectId!);
      return nextIds;
    });
  }, [activeConversation?.projectId]);

  const toggleProject = (projectId: string) => {
    setOpenProjectIds((currentIds) => {
      const nextIds = new Set(currentIds);
      if (nextIds.has(projectId)) {
        nextIds.delete(projectId);
      } else {
        nextIds.add(projectId);
      }
      return nextIds;
    });
  };

  const startRenamingProject = (project: AppProject) => {
    setRenameValue(project.name);
    setRenamingProject(project);
    setOpenProjectMenuId(null);
  };

  const submitRenameProject = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!renamingProject) return;

    const normalizedName = renameValue.trim();
    if (!normalizedName) return;

    onRenameProject(renamingProject.id, normalizedName);
    setRenamingProject(null);
    setRenameValue("");
  };

  const archiveProjectCount = pendingArchiveProject
    ? visibleConversations.filter((conversation) => conversation.projectId === pendingArchiveProject.id).length
    : 0;

  const renderConversationRow = (conversation: ChatConversation, nested = false) => (
    <ConversationRow
      activeConversationId={activeConversationId}
      archiveLabel={t("conversation.archiveConversation")}
      conversation={conversation}
      key={conversation.id}
      language={language}
      nested={nested}
      now={now}
      onArchiveConversation={onArchiveConversation}
      onSelectConversation={onSelectConversation}
      onTogglePinConversation={onTogglePinConversation}
      pinLabel={t("conversation.pinConversation")}
      unpinLabel={t("conversation.unpinConversation")}
      justNow={t("sidebar.justNow")}
    />
  );

  const renderProjectGroup = (project: AppProject, pinnedSection = false) => {
    const isProjectOpen = openProjectIds.has(project.id);
    const isProjectPinned = Boolean(project.pinnedAt);
    const projectConversations = conversationsByProjectId[project.id] ?? [];
    const visibleProjectConversationCount = projectConversations.length;

    return (
      <div
        className={`left-sidebar__project-group${pinnedSection ? " left-sidebar__project-group--pinned" : ""}`}
        key={project.id}
      >
        <div className="left-sidebar__project-row">
          <button
            className="left-sidebar__project-main"
            type="button"
            onClick={() => toggleProject(project.id)}
          >
            <NotebookText aria-hidden="true" />
            <span>{project.name}</span>
          </button>

          <div className="left-sidebar__project-actions">
            <button
              className="left-sidebar__project-action"
              type="button"
              aria-expanded={isProjectOpen}
              onClick={() => toggleProject(project.id)}
            >
              <ChevronDown data-open={isProjectOpen || undefined} aria-hidden="true" />
            </button>
            <button
              className="left-sidebar__project-action"
              type="button"
              aria-label={t("project.moreActions")}
              data-open={openProjectMenuId === project.id || undefined}
              onClick={() => setOpenProjectMenuId((currentId) => (currentId === project.id ? null : project.id))}
            >
              <MoreHorizontal aria-hidden="true" />
            </button>
            <button
              className="left-sidebar__project-action"
              type="button"
              aria-label={t("project.newProjectConversation")}
              onClick={() => onNewConversation(project.id)}
            >
              <SquarePen aria-hidden="true" />
            </button>
          </div>
        </div>

        {openProjectMenuId === project.id && (
          <div className="left-sidebar__project-menu" role="menu">
            <button
              className="left-sidebar__project-menu-item"
              type="button"
              role="menuitem"
              onClick={() => {
                onTogglePinProject(project.id);
                setOpenProjectMenuId(null);
              }}
            >
              <Pin aria-hidden="true" />
              <span>{isProjectPinned ? t("project.unpinProject") : t("project.pinProject")}</span>
            </button>
            <button
              className="left-sidebar__project-menu-item"
              type="button"
              role="menuitem"
              disabled={!project.path}
              onClick={() => {
                onShowProjectInFolder(project.id);
                setOpenProjectMenuId(null);
              }}
            >
              <FolderOpen aria-hidden="true" />
              <span>{t("project.showInFolder")}</span>
            </button>
            <button
              className="left-sidebar__project-menu-item"
              type="button"
              role="menuitem"
              onClick={() => startRenamingProject(project)}
            >
              <PencilLine aria-hidden="true" />
              <span>{t("project.renameProject")}</span>
            </button>
            <button
              className="left-sidebar__project-menu-item"
              type="button"
              role="menuitem"
              disabled={visibleProjectConversationCount === 0}
              onClick={() => {
                setPendingArchiveProject(project);
                setOpenProjectMenuId(null);
              }}
            >
              <Archive aria-hidden="true" />
              <span>{t("project.archiveConversations")}</span>
            </button>
            <button
              className="left-sidebar__project-menu-item left-sidebar__project-menu-item--danger"
              type="button"
              role="menuitem"
              onClick={() => {
                setPendingRemoveProject(project);
                setOpenProjectMenuId(null);
              }}
            >
              <X aria-hidden="true" />
              <span>{t("project.removeProject")}</span>
            </button>
          </div>
        )}

        {isProjectOpen && projectConversations.length > 0 && (
          <div className="left-sidebar__project-conversations">
            {projectConversations.map((conversation) => renderConversationRow(conversation, true))}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="left-sidebar" aria-label={t("app.leftSidebar")}>
      <button
        className="left-sidebar__primary-action"
        data-active={isNewConversationActive || undefined}
        type="button"
        onClick={() => onNewConversation(null)}
      >
        <SquarePen aria-hidden="true" />
        <span>{t("sidebar.newConversation")}</span>
      </button>

      {hasPinnedItems && (
        <section className="left-sidebar__section left-sidebar__pinned" aria-labelledby="pinned-heading">
          <h2 id="pinned-heading" className="left-sidebar__section-title left-sidebar__standalone-title">
            {t("sidebar.pinned")}
          </h2>
          <div className="left-sidebar__pinned-list">
            {pinnedRootConversations.map((conversation) => renderConversationRow(conversation))}
            {pinnedProjects.map((project) => renderProjectGroup(project, true))}
          </div>
        </section>
      )}

      <section className="left-sidebar__section left-sidebar__projects" aria-labelledby="projects-heading">
        <div className="left-sidebar__section-header">
          <button
            className="left-sidebar__section-title-button"
            type="button"
            aria-expanded={areProjectsOpen}
            onClick={() => setAreProjectsOpen((open) => !open)}
          >
            <h2 id="projects-heading" className="left-sidebar__section-title">
              {t("sidebar.projects")}
            </h2>
            <ChevronDown data-open={areProjectsOpen || undefined} aria-hidden="true" />
          </button>

          <div className="left-sidebar__section-actions">
            <button className="left-sidebar__section-action" type="button" aria-label={t("project.moreActions")}>
              <MoreHorizontal aria-hidden="true" />
            </button>
          </div>
        </div>

        {areProjectsOpen && regularProjects.length > 0 && (
          <div className="left-sidebar__project-list">
            {regularProjects.map((project) => renderProjectGroup(project))}
          </div>
        )}
      </section>

      <section className="left-sidebar__section left-sidebar__conversations" aria-labelledby="conversations-heading">
        <div className="left-sidebar__conversation-header">
          <button
            className="left-sidebar__conversation-title-button"
            type="button"
            aria-expanded={areConversationsOpen}
            onClick={() => setAreConversationsOpen((open) => !open)}
          >
            <h2 id="conversations-heading" className="left-sidebar__section-title">
              {t("sidebar.conversations")}
            </h2>
            <ChevronDown data-open={areConversationsOpen || undefined} aria-hidden="true" />
          </button>

          <div className="left-sidebar__conversation-actions">
            <button
              className="left-sidebar__conversation-action"
              type="button"
              aria-label={t("sidebar.moreConversationActions")}
            >
              <MoreHorizontal aria-hidden="true" />
            </button>
            <button
              className="left-sidebar__conversation-action"
              type="button"
              aria-label={t("sidebar.newConversationAction")}
              onClick={() => onNewConversation(null)}
            >
              <SquarePen aria-hidden="true" />
            </button>
          </div>
        </div>

        {areConversationsOpen &&
          (rootConversations.length === 0 ? (
            <p className="left-sidebar__empty-state">{t("sidebar.emptyConversations")}</p>
          ) : (
            <div className="left-sidebar__conversation-list">
              {rootConversations.map((conversation) => renderConversationRow(conversation))}
            </div>
          ))}
      </section>

      <button className="left-sidebar__settings" type="button" onClick={onOpenSettings}>
        <Settings aria-hidden="true" />
        <span>{t("sidebar.settings")}</span>
      </button>

      {renamingProject && (
        <div
          className="left-sidebar__dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setRenamingProject(null);
          }}
        >
          <form className="left-sidebar__dialog" onSubmit={submitRenameProject}>
            <button
              className="left-sidebar__dialog-close"
              type="button"
              aria-label={t("project.cancel")}
              onClick={() => setRenamingProject(null)}
            >
              <X aria-hidden="true" />
            </button>
            <h3>{t("project.renameTitle")}</h3>
            <p>{t("project.renameDescription")}</p>
            <input
              autoFocus
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
            />
            <div className="left-sidebar__dialog-actions">
              <button
                className="left-sidebar__dialog-button left-sidebar__dialog-button--secondary"
                type="button"
                onClick={() => setRenamingProject(null)}
              >
                {t("project.cancel")}
              </button>
              <button
                className="left-sidebar__dialog-button left-sidebar__dialog-button--primary"
                type="submit"
                disabled={!renameValue.trim()}
              >
                {t("project.save")}
              </button>
            </div>
          </form>
        </div>
      )}

      {pendingArchiveProject && (
        <div
          className="left-sidebar__dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setPendingArchiveProject(null);
          }}
        >
          <div className="left-sidebar__dialog left-sidebar__dialog--confirm" role="dialog" aria-modal="true">
            <button
              className="left-sidebar__dialog-close"
              type="button"
              aria-label={t("project.cancel")}
              onClick={() => setPendingArchiveProject(null)}
            >
              <X aria-hidden="true" />
            </button>
            <h3>{formatTemplate(t("project.archiveTitle"), { count: archiveProjectCount })}</h3>
            <p>
              {formatTemplate(t("project.archiveDescription"), {
                projectName: pendingArchiveProject.name,
              })}
            </p>
            <div className="left-sidebar__dialog-actions">
              <button
                className="left-sidebar__dialog-button left-sidebar__dialog-button--secondary"
                type="button"
                onClick={() => setPendingArchiveProject(null)}
              >
                {t("project.cancel")}
              </button>
              <button
                className="left-sidebar__dialog-button left-sidebar__dialog-button--danger"
                type="button"
                onClick={() => {
                  onArchiveProjectConversations(pendingArchiveProject.id);
                  setPendingArchiveProject(null);
                }}
              >
                {t("project.archiveAll")}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingRemoveProject && (
        <div
          className="left-sidebar__dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setPendingRemoveProject(null);
          }}
        >
          <div className="left-sidebar__dialog left-sidebar__dialog--confirm" role="dialog" aria-modal="true">
            <button
              className="left-sidebar__dialog-close"
              type="button"
              aria-label={t("project.cancel")}
              onClick={() => setPendingRemoveProject(null)}
            >
              <X aria-hidden="true" />
            </button>
            <h3>{formatTemplate(t("project.removeTitle"), { projectName: pendingRemoveProject.name })}</h3>
            <p>{t("project.removeDescription")}</p>
            <div className="left-sidebar__dialog-actions">
              <button
                className="left-sidebar__dialog-button left-sidebar__dialog-button--secondary"
                type="button"
                onClick={() => setPendingRemoveProject(null)}
              >
                {t("project.cancel")}
              </button>
              <button
                className="left-sidebar__dialog-button left-sidebar__dialog-button--danger"
                type="button"
                onClick={() => {
                  onRemoveProject(pendingRemoveProject.id);
                  setPendingRemoveProject(null);
                }}
              >
                {t("project.confirmRemove")}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
