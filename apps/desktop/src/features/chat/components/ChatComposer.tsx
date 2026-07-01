import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  FileText,
  ImageIcon,
  NotebookText,
  Paperclip,
  Plus,
  Search,
  ShieldAlert,
  ShieldPlus,
  X,
} from "lucide-react";
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
const READABLE_FILE_ACCEPT = [
  "text/*",
  "application/json",
  "application/javascript",
  "application/xml",
  "application/x-httpd-php",
  "application/x-sh",
  "application/x-sql",
  "application/x-toml",
  "application/x-yaml",
  "text/csv",
  "text/html",
  "text/javascript",
  "text/markdown",
  "text/plain",
  "text/x-c",
  "text/x-c++",
  "text/x-csharp",
  "text/x-go",
  "text/x-java-source",
  "text/x-kotlin",
  "text/x-php",
  "text/x-python",
  "text/x-ruby",
  "text/x-rust",
  "text/x-scss",
  "text/x-shellscript",
  "text/x-sql",
  "text/x-swift",
  "text/xml",
  "text/yaml",
  "text/tab-separated-values",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pdf",
  ".docx",
  ".doc",
  ".pptx",
  ".ppt",
  ".xlsx",
  ".xls",
  ".csv",
  ".tsv",
  ".txt",
  ".text",
  ".md",
  ".markdown",
  ".mdx",
  ".rst",
  ".log",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".env",
  ".lock",
  ".properties",
  ".plist",
  ".rc",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".py",
  ".pyi",
  ".ipynb",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".d.ts",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".xml",
  ".svg",
  ".sql",
  ".graphql",
  ".gql",
  ".proto",
  ".prisma",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".bat",
  ".cmd",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".kts",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
  ".hh",
  ".hxx",
  ".cs",
  ".php",
  ".rb",
  ".swift",
  ".scala",
  ".r",
  ".m",
  ".pl",
  ".pm",
  ".lua",
  ".dart",
  ".ex",
  ".exs",
  ".erl",
  ".hrl",
  ".clj",
  ".cljs",
  ".cljc",
  ".edn",
  ".fs",
  ".fsi",
  ".fsx",
  ".elm",
  ".hs",
  ".lhs",
  ".jl",
  ".ml",
  ".mli",
  ".nim",
  ".nims",
  ".zig",
  ".v",
  ".vh",
  ".sv",
  ".svh",
  ".sol",
  ".tf",
  ".tfvars",
  ".hcl",
  ".gradle",
  ".groovy",
  ".dockerfile",
  ".cmake",
  ".make",
  ".mk",
  ".tex",
  ".bib",
  ".vue",
  ".svelte",
  ".astro",
].join(",");

type ComposerAttachmentKind = "file" | "image";

interface ComposerAttachment {
  id: string;
  kind: ComposerAttachmentKind;
  name: string;
  previewUrl?: string;
}

interface ChatComposerProps {
  defaultProjectId?: string | null;
  isGenerating?: boolean;
  onSubmitMessage?: (message: string, options: ChatSubmitOptions) => void;
  onStopGenerating?: () => void;
  showProjectSelector?: boolean;
}

function createAttachmentId() {
  return `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createAttachmentSummary(attachments: ComposerAttachment[]) {
  if (attachments.length === 0) return "";
  return `附件：${attachments.map((attachment) => attachment.name).join("、")}`;
}

export function ChatComposer({
  defaultProjectId = null,
  isGenerating = false,
  onSubmitMessage,
  onStopGenerating,
  showProjectSelector = false,
}: ChatComposerProps) {
  const { t } = useFrontendConfig();
  const { enabledModels } = useModelSettings();
  const { addProject, projects } = useProjectSettings();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const projectFolderInputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [isAttachmentMenuOpen, setIsAttachmentMenuOpen] = useState(false);
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
  const hasImageAttachment = attachments.some((attachment) => attachment.kind === "image");
  const hasUnsupportedImageAttachment = hasImageAttachment && !selectedModel?.supportsImage;
  const hasSendableContent = message.trim().length > 0 || attachments.length > 0;
  const canSend = hasSendableContent && !hasUnsupportedImageAttachment && Boolean(selectedModel);
  const submitButtonState = isGenerating ? "stop" : canSend ? "ready" : "disabled";

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

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach((attachment) => {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      });
    };
  }, []);

  const submitMessage = () => {
    if (isGenerating || !canSend) return;

    const trimmedMessage = message.trim();
    const attachmentSummary = createAttachmentSummary(attachments);
    const messageContent = [trimmedMessage, attachmentSummary].filter(Boolean).join("\n\n");

    onSubmitMessage?.(messageContent, {
      modelId: selectedModel?.id ?? selectedModelId,
      projectId: selectedProject?.id ?? null,
    });
    setMessage("");
    clearAttachments();
    setIsAttachmentMenuOpen(false);
    setIsPermissionMenuOpen(false);
    setIsModelMenuOpen(false);
    setIsProjectMenuOpen(false);
  };

  const clearAttachments = () => {
    setAttachments((currentAttachments) => {
      currentAttachments.forEach((attachment) => {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      });

      return [];
    });
  };

  const removeAttachment = (attachmentId: string) => {
    setAttachments((currentAttachments) =>
      currentAttachments.filter((attachment) => {
        if (attachment.id !== attachmentId) return true;
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
        return false;
      }),
    );
  };

  const addAttachments = (files: FileList | null, kind: ComposerAttachmentKind) => {
    if (!files || files.length === 0) return;

    const nextAttachments = Array.from(files).map((file) => ({
      id: createAttachmentId(),
      kind,
      name: file.name,
      previewUrl: kind === "image" ? URL.createObjectURL(file) : undefined,
    }));

    if (nextAttachments.length === 0) {
      setIsAttachmentMenuOpen(false);
      return;
    }

    setAttachments((currentAttachments) => [...currentAttachments, ...nextAttachments]);
    setIsAttachmentMenuOpen(false);
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
      data-submit-state={submitButtonState}
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
          if (!isGenerating) {
            submitMessage();
          }
        }}
      />

      {attachments.length > 0 && (
        <div className="chat-composer__attachments" aria-label={t("chat.attachments")}>
          {attachments.map((attachment) => (
            <div className="composer-attachment" data-kind={attachment.kind} key={attachment.id}>
              {attachment.previewUrl ? (
                <img src={attachment.previewUrl} alt="" />
              ) : (
                <FileText aria-hidden="true" />
              )}
              <span>{attachment.name}</span>
              <button
                type="button"
                aria-label={`${t("chat.removeAttachment")} ${attachment.name}`}
                onClick={() => removeAttachment(attachment.id)}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}

      {hasUnsupportedImageAttachment && (
        <p className="chat-composer__warning">{t("chat.unsupportedImageWarning")}</p>
      )}

      <div className="chat-composer__toolbar">
        <div className="composer-add-picker">
          <button
            type="button"
            className="composer-icon-button"
            aria-haspopup="menu"
            aria-expanded={isAttachmentMenuOpen}
            aria-label={t("chat.addContext")}
            onClick={() => {
              setIsAttachmentMenuOpen((open) => !open);
              setIsPermissionMenuOpen(false);
              setIsModelMenuOpen(false);
              setIsProjectMenuOpen(false);
            }}
          >
            <Plus aria-hidden="true" />
          </button>

          {isAttachmentMenuOpen && (
            <div className="composer-add-menu" role="menu" aria-label={t("chat.addMenuTitle")}>
              <p>{t("chat.addMenuTitle")}</p>
              <button type="button" role="menuitem" onClick={() => fileInputRef.current?.click()}>
                <Paperclip aria-hidden="true" />
                <span>{t("chat.addFile")}</span>
              </button>
              <button type="button" role="menuitem" onClick={() => imageInputRef.current?.click()}>
                <ImageIcon aria-hidden="true" />
                <span>{t("chat.addImage")}</span>
              </button>
            </div>
          )}
        </div>

        <input
          ref={fileInputRef}
          className="composer-hidden-file-input"
          type="file"
          accept={READABLE_FILE_ACCEPT}
          multiple
          aria-label={t("chat.addFile")}
          onChange={(event) => {
            addAttachments(event.currentTarget.files, "file");
            event.currentTarget.value = "";
          }}
        />
        <input
          ref={imageInputRef}
          className="composer-hidden-file-input"
          type="file"
          accept="image/*,.apng,.avif,.bmp,.gif,.heic,.heif,.ico,.jpg,.jpeg,.png,.svg,.tif,.tiff,.webp"
          multiple
          aria-label={t("chat.addImage")}
          onChange={(event) => {
            addAttachments(event.currentTarget.files, "image");
            event.currentTarget.value = "";
          }}
        />

        <div className="composer-permission-picker">
          <button
            type="button"
            className="composer-permission-button"
            data-permission={selectedPermission.id}
            aria-haspopup="listbox"
            aria-expanded={isPermissionMenuOpen}
            aria-label={`${t("chat.permission")}：${t(selectedPermission.labelKey)}`}
            onClick={() => {
              setIsAttachmentMenuOpen(false);
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
              setIsAttachmentMenuOpen(false);
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

        <button
          type={isGenerating ? "button" : "submit"}
          className="composer-submit-button"
          data-state={submitButtonState}
          disabled={!isGenerating && !canSend}
          aria-label={isGenerating ? t("chat.stop") : t("chat.send")}
          onClick={() => {
            if (isGenerating) {
              onStopGenerating?.();
            }
          }}
        >
          {isGenerating ? <span className="composer-stop-square" aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}
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
                setIsAttachmentMenuOpen(false);
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
