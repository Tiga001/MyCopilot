import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowUp, Check, ChevronDown, NotebookText, Plus, Search, ShieldAlert, ShieldPlus, X } from "lucide-react";
import { useFrontendConfig } from "../../../config/FrontendConfigProvider";
import { useModelSettings } from "../../../config/ModelSettingsProvider";
import { useProjectSettings } from "../../../config/ProjectSettingsProvider";
import type { TranslationKey } from "../../../config/frontendConfig";
import { modelConfig } from "../../../config/modelConfig";
import { getFolderNameFromFileList } from "../../../config/projectConfig";
import type { ChatSubmitOptions } from "../chatTypes";
import "./ChatComposer.css";

type PermissionMode = "default" | "full";

interface PermissionOption {
  id: PermissionMode;
  labelKey: TranslationKey;
  icon: LucideIcon;
}

const PERMISSION_OPTIONS: PermissionOption[] = [
  { id: "default", labelKey: "chat.defaultPermission", icon: ShieldPlus },
  { id: "full", labelKey: "chat.fullPermission", icon: ShieldAlert },
];

const TEXTAREA_MAX_HEIGHT = 220;

interface ChatComposerProps {
  defaultProjectId?: string | null;
  onSubmitMessage?: (message: string, options: ChatSubmitOptions) => void;
  showProjectSelector?: boolean;
}

export function ChatComposer({ defaultProjectId = null, onSubmitMessage, showProjectSelector = false }: ChatComposerProps) {
  const { t } = useFrontendConfig();
  const { enabledModels } = useModelSettings();
  const { addProject, projects } = useProjectSettings();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const projectFolderInputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState("");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("full");
  const [isPermissionMenuOpen, setIsPermissionMenuOpen] = useState(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isProjectMenuOpen, setIsProjectMenuOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(defaultProjectId);
  const [selectedModelId, setSelectedModelId] = useState<string>(modelConfig.defaults.selectedModelId);
  const selectedPermission = PERMISSION_OPTIONS.find((option) => option.id === permissionMode) ?? PERMISSION_OPTIONS[0];
  const SelectedPermissionIcon = selectedPermission.icon;
  const selectedModel = useMemo(() => {
    return enabledModels.find((model) => model.id === selectedModelId) ?? enabledModels[0];
  }, [enabledModels, selectedModelId]);
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const filteredProjects = projects.filter((project) =>
    project.name.toLowerCase().includes(projectSearch.trim().toLowerCase()),
  );

  useEffect(() => {
    setSelectedProjectId(defaultProjectId);
  }, [defaultProjectId]);

  useEffect(() => {
    if (selectedProjectId && !projects.some((project) => project.id === selectedProjectId)) {
      setSelectedProjectId(null);
    }
  }, [projects, selectedProjectId]);

  useEffect(() => {
    if (!selectedModel && enabledModels.length > 0) {
      setSelectedModelId(enabledModels[0].id);
      return;
    }

    if (selectedModel) {
      setSelectedModelId(selectedModel.id);
    }
  }, [enabledModels, selectedModel]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    const nextHeight = Math.min(textarea.scrollHeight, TEXTAREA_MAX_HEIGHT);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > TEXTAREA_MAX_HEIGHT ? "auto" : "hidden";
  }, [message]);

  const submitMessage = () => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage) return;

    onSubmitMessage?.(trimmedMessage, {
      modelId: selectedModel?.id ?? selectedModelId,
      projectId: selectedProject?.id ?? null,
    });
    setMessage("");
    setIsPermissionMenuOpen(false);
    setIsModelMenuOpen(false);
    setIsProjectMenuOpen(false);
  };

  const handleNewProjectFromFolder = (files: FileList | null) => {
    const folderName = getFolderNameFromFileList(files);
    if (!folderName) return;

    const project = addProject(folderName);
    setSelectedProjectId(project.id);
    setProjectSearch("");
    setIsProjectMenuOpen(false);
  };

  return (
    <form
      className="chat-composer"
      aria-label={t("chat.composer")}
      onSubmit={(event) => {
        event.preventDefault();
        submitMessage();
      }}
    >
      <textarea
        ref={textareaRef}
        value={message}
        placeholder={t("chat.inputPlaceholder")}
        aria-label={t("chat.inputAria")}
        rows={1}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;

          event.preventDefault();
          submitMessage();
        }}
      />

      <div className="chat-composer__toolbar">
        <button type="button" className="composer-icon-button" aria-label={t("chat.addContext")}>
          <Plus aria-hidden="true" />
        </button>

        <div className="composer-permission-picker">
          <button
            type="button"
            className="composer-permission-button"
            data-permission={selectedPermission.id}
            aria-haspopup="listbox"
            aria-expanded={isPermissionMenuOpen}
            aria-label={`${t("chat.permission")}：${t(selectedPermission.labelKey)}`}
            onClick={() => {
              setIsModelMenuOpen(false);
              setIsPermissionMenuOpen((open) => !open);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setIsPermissionMenuOpen(false);
              }
            }}
          >
            <SelectedPermissionIcon aria-hidden="true" />
            <span>{t(selectedPermission.labelKey)}</span>
            <ChevronDown aria-hidden="true" />
          </button>

          {isPermissionMenuOpen && (
            <div className="composer-permission-menu" role="listbox" aria-label={t("chat.selectPermission")}>
              {PERMISSION_OPTIONS.map((option) => {
                const OptionIcon = option.icon;
                const isSelected = option.id === permissionMode;

                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className="composer-permission-option"
                    data-permission={option.id}
                    data-selected={isSelected || undefined}
                    key={option.id}
                    onClick={() => {
                      setPermissionMode(option.id);
                      setIsPermissionMenuOpen(false);
                    }}
                  >
                    <OptionIcon aria-hidden="true" />
                    <span>{t(option.labelKey)}</span>
                    {isSelected && <Check className="composer-permission-option__check" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <span className="chat-composer__spacer" />

        <div className="composer-model-picker">
          <button
            type="button"
            className="composer-model-button"
            aria-haspopup="listbox"
            aria-expanded={isModelMenuOpen}
            aria-label={t("chat.selectModel")}
            onClick={() => {
              setIsPermissionMenuOpen(false);
              setIsModelMenuOpen((open) => !open);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setIsModelMenuOpen(false);
              }
            }}
          >
            <span>{selectedModel?.shortName ?? selectedModel?.displayName ?? t("chat.noEnabledModels")}</span>
            <ChevronDown aria-hidden="true" />
          </button>

          {isModelMenuOpen && (
            <div className="composer-model-menu" role="listbox" aria-label={t("chat.selectModel")}>
              {enabledModels.length === 0 ? (
                <span className="composer-model-empty">{t("chat.noEnabledModels")}</span>
              ) : (
                enabledModels.map((model) => {
                  const isSelected = model.id === selectedModel?.id;

                  return (
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      className="composer-model-option"
                      data-selected={isSelected || undefined}
                      key={model.id}
                      onClick={() => {
                        setSelectedModelId(model.id);
                        setIsModelMenuOpen(false);
                      }}
                    >
                      <span className="composer-model-option__name">{model.shortName ?? model.displayName}</span>
                      <span className="composer-model-option__capability" data-supported={model.supportsImage || undefined}>
                        {model.supportsImage ? t("configuration.image") : t("configuration.text")}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>

        <button type="submit" className="composer-submit-button" aria-label={t("chat.send")}>
          <ArrowUp aria-hidden="true" />
        </button>
      </div>

      {showProjectSelector && (
        <div className="chat-composer__project-row">
          <div className="composer-project-picker">
            <button
              className="composer-project-button"
              type="button"
              aria-haspopup="listbox"
              aria-expanded={isProjectMenuOpen}
              onClick={() => {
                setIsPermissionMenuOpen(false);
                setIsModelMenuOpen(false);
                setIsProjectMenuOpen((open) => !open);
              }}
            >
              <NotebookText aria-hidden="true" />
              <span>{selectedProject?.name ?? t("project.chooseProject")}</span>
            </button>

            {isProjectMenuOpen && (
              <div className="composer-project-menu" role="listbox" aria-label={t("project.chooseProject")}>
                <label className="composer-project-menu__search">
                  <Search aria-hidden="true" />
                  <input
                    value={projectSearch}
                    placeholder={t("project.searchProject")}
                    onChange={(event) => setProjectSearch(event.target.value)}
                  />
                </label>

                <div className="composer-project-menu__items">
                  {filteredProjects.map((project) => {
                    const isSelected = project.id === selectedProjectId;

                    return (
                      <button
                        className="composer-project-option"
                        data-selected={isSelected || undefined}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        key={project.id}
                        onClick={() => {
                          setSelectedProjectId(project.id);
                          setProjectSearch("");
                          setIsProjectMenuOpen(false);
                        }}
                      >
                        <NotebookText aria-hidden="true" />
                        <span>{project.name}</span>
                        {isSelected && <Check aria-hidden="true" />}
                      </button>
                    );
                  })}
                </div>

                <div className="composer-project-menu__divider" />

                <button
                  className="composer-project-command"
                  type="button"
                  onClick={() => {
                    projectFolderInputRef.current?.click();
                  }}
                >
                  <Plus aria-hidden="true" />
                  <span>{t("project.newProject")}</span>
                  <ChevronDown aria-hidden="true" />
                </button>

                <button
                  className="composer-project-command"
                  type="button"
                  onClick={() => {
                    setSelectedProjectId(null);
                    setProjectSearch("");
                    setIsProjectMenuOpen(false);
                  }}
                >
                  <X aria-hidden="true" />
                  <span>{t("project.noProject")}</span>
                </button>
              </div>
            )}

            <input
              ref={projectFolderInputRef}
              className="composer-project-folder-input"
              type="file"
              multiple
              aria-label={t("project.folderInput")}
              onClick={(event) => {
                event.currentTarget.setAttribute("webkitdirectory", "");
                event.currentTarget.setAttribute("directory", "");
                event.currentTarget.value = "";
              }}
              onChange={(event) => handleNewProjectFromFolder(event.currentTarget.files)}
            />
          </div>
        </div>
      )}
    </form>
  );
}
