import { NotebookText, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { useFrontendConfig } from "../../../config/FrontendConfigProvider";
import { useProjectSettings } from "../../../config/ProjectSettingsProvider";
import { getFolderNameFromFileList } from "../../../config/projectConfig";
import type { AppProject } from "../../../config/projectConfig";
import "./EnvironmentSettingsPage.css";

export function EnvironmentSettingsPage() {
  const { t } = useFrontendConfig();
  const { addProject, deleteProject, projects } = useProjectSettings();
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [pendingDeleteProject, setPendingDeleteProject] = useState<AppProject | null>(null);

  const addProjectFromFolder = () => {
    folderInputRef.current?.click();
  };

  const handleFolderChange = (files: FileList | null) => {
    const folderName = getFolderNameFromFileList(files);
    if (!folderName) return;
    addProject(folderName);
  };

  return (
    <article className="environment-settings-page">
      <h1>{t("settings.page.environment")}</h1>

      <section className="environment-projects" aria-labelledby="environment-projects-heading">
        <div className="environment-projects__header">
          <h2 id="environment-projects-heading">{t("environment.selectProject")}</h2>
          <button className="environment-projects__add-button" type="button" onClick={addProjectFromFolder}>
            {t("environment.addProject")}
          </button>
          <input
            ref={folderInputRef}
            className="environment-projects__folder-input"
            type="file"
            multiple
            aria-label={t("environment.folderInput")}
            onClick={(event) => {
              event.currentTarget.setAttribute("webkitdirectory", "");
              event.currentTarget.setAttribute("directory", "");
              event.currentTarget.value = "";
            }}
            onChange={(event) => handleFolderChange(event.currentTarget.files)}
          />
        </div>

        <div className="environment-projects__list">
          {projects.map((project) => (
            <div className="environment-project-card" key={project.id}>
              <NotebookText aria-hidden="true" />
              <span className="environment-project-card__name">{project.name}</span>
              {project.path && <span className="environment-project-card__detail">{project.path}</span>}
              <button
                className="environment-project-card__delete"
                type="button"
                aria-label={`${t("environment.deleteProject")} ${project.name}`}
                onClick={() => setPendingDeleteProject(project)}
              >
                <Trash2 aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      </section>

      {pendingDeleteProject && (
        <div className="environment-remove-dialog" role="dialog" aria-modal="true">
          <div className="environment-remove-dialog__card">
            <button
              className="environment-remove-dialog__close"
              type="button"
              aria-label={t("environment.cancelRemoveProject")}
              onClick={() => setPendingDeleteProject(null)}
            >
              ×
            </button>
            <h2>{t("environment.removeProjectTitle").replace("{projectName}", pendingDeleteProject.name)}</h2>
            <p>{t("environment.removeProjectDescription")}</p>
            <div className="environment-remove-dialog__actions">
              <button
                className="environment-remove-dialog__cancel"
                type="button"
                onClick={() => setPendingDeleteProject(null)}
              >
                {t("environment.cancelRemoveProject")}
              </button>
              <button
                className="environment-remove-dialog__confirm"
                type="button"
                onClick={() => {
                  deleteProject(pendingDeleteProject.id);
                  setPendingDeleteProject(null);
                }}
              >
                {t("environment.confirmRemoveProject")}
              </button>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
