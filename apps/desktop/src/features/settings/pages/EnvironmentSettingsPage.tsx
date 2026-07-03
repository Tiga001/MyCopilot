import { NotebookText, Trash2 } from "lucide-react";
import { useState } from "react";
import { useFrontendConfig } from "../../../config/FrontendConfigProvider";
import { useProjectSettings } from "../../../config/ProjectSettingsProvider";
import type { AppProject } from "../../../config/projectConfig";
import "./EnvironmentSettingsPage.css";

export function EnvironmentSettingsPage() {
  const { t } = useFrontendConfig();
  const { deleteProject, projects, selectProjectDirectory } = useProjectSettings();
  const [pendingDeleteProject, setPendingDeleteProject] = useState<AppProject | null>(null);

  const addProjectFromFolder = () => {
    void selectProjectDirectory();
  };

  return (
    <article className="settings-list-page environment-settings-page">
      <h1>{t("settings.page.environment")}</h1>

      <section className="settings-list-section environment-projects" aria-labelledby="environment-projects-heading">
        <div className="settings-list-section__header environment-projects__header">
          <h2 id="environment-projects-heading">{t("environment.selectProject")}</h2>
          <button className="environment-projects__add-button" type="button" onClick={addProjectFromFolder}>
            {t("environment.addProject")}
          </button>
        </div>

        <div className="settings-list environment-projects__list">
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
