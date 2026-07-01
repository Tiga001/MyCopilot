import { ChevronDown, MoreHorizontal, NotebookText, Settings, SquarePen } from "lucide-react";
import { useEffect, useState } from "react";
import { useFrontendConfig } from "../../config/FrontendConfigProvider";
import type { AppProject } from "../../config/projectConfig";
import type { ChatConversation } from "../../features/chat/chatTypes";
import "./LeftSidebar.css";

interface LeftSidebarProps {
  activeConversationId: string | null;
  conversations: ChatConversation[];
  isNewConversationActive: boolean;
  onNewConversation: (projectId?: string | null) => void;
  onOpenSettings: () => void;
  onSelectConversation: (conversationId: string) => void;
  projects: AppProject[];
}

function formatConversationAge(updatedAt: number, language: string, justNow: string) {
  const days = Math.floor((Date.now() - updatedAt) / 86_400_000);
  if (days <= 0) return justNow;
  return language === "zh-CN" ? `${days} 天` : `${days}d`;
}

export function LeftSidebar({
  activeConversationId,
  conversations,
  isNewConversationActive,
  onNewConversation,
  onOpenSettings,
  onSelectConversation,
  projects,
}: LeftSidebarProps) {
  const { language, t } = useFrontendConfig();
  const [areProjectsOpen, setAreProjectsOpen] = useState(true);
  const [areConversationsOpen, setAreConversationsOpen] = useState(true);
  const [openProjectIds, setOpenProjectIds] = useState<Set<string>>(new Set());
  const projectIds = new Set(projects.map((project) => project.id));
  const rootConversations = conversations.filter((conversation) => !conversation.projectId || !projectIds.has(conversation.projectId));
  const conversationsByProjectId = projects.reduce<Record<string, ChatConversation[]>>((accumulator, project) => {
    accumulator[project.id] = conversations.filter((conversation) => conversation.projectId === project.id);
    return accumulator;
  }, {});
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);

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

        {areProjectsOpen && projects.length > 0 && (
          <div className="left-sidebar__project-list">
            {projects.map((project) => {
              const isProjectOpen = openProjectIds.has(project.id);
              const projectConversations = conversationsByProjectId[project.id] ?? [];

              return (
                <div className="left-sidebar__project-group" key={project.id}>
                  <div className="left-sidebar__project-row">
                    <button className="left-sidebar__project-main" type="button" onClick={() => toggleProject(project.id)}>
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
                      <button className="left-sidebar__project-action" type="button" aria-label={t("project.moreActions")}>
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

                  {isProjectOpen && projectConversations.length > 0 && (
                    <div className="left-sidebar__project-conversations">
                      {projectConversations.map((conversation) => (
                        <button
                          className="left-sidebar__conversation-item left-sidebar__conversation-item--nested"
                          data-active={conversation.id === activeConversationId || undefined}
                          type="button"
                          key={conversation.id}
                          onClick={() => onSelectConversation(conversation.id)}
                        >
                          <span className="left-sidebar__conversation-name">{conversation.title}</span>
                          <span className="left-sidebar__conversation-age">
                            {formatConversationAge(conversation.updatedAt, language, t("sidebar.justNow"))}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
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
              {rootConversations.map((conversation) => (
                <button
                  className="left-sidebar__conversation-item"
                  data-active={conversation.id === activeConversationId || undefined}
                  type="button"
                  key={conversation.id}
                  onClick={() => onSelectConversation(conversation.id)}
                >
                  <span className="left-sidebar__conversation-name">{conversation.title}</span>
                  <span className="left-sidebar__conversation-age">
                    {formatConversationAge(conversation.updatedAt, language, t("sidebar.justNow"))}
                  </span>
                </button>
              ))}
            </div>
          ))}
      </section>

      <button className="left-sidebar__settings" type="button" onClick={onOpenSettings}>
        <Settings aria-hidden="true" />
        <span>{t("sidebar.settings")}</span>
      </button>
    </aside>
  );
}
