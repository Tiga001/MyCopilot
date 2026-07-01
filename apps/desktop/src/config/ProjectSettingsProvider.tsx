import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { deleteStoredProject, loadProjects, saveProject as saveStoredProject } from "../features/storage/storageClient";
import { createProjectId, projectConfig } from "./projectConfig";
import type { AppProject } from "./projectConfig";

interface ProjectSettingsContextValue {
  addProject: (name: string, path?: string) => AppProject;
  deleteProject: (projectId: string) => void;
  hasLoadedProjects: boolean;
  projects: AppProject[];
}

const ProjectSettingsContext = createContext<ProjectSettingsContextValue | null>(null);

export function ProjectSettingsProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<AppProject[]>(projectConfig.initialProjects);
  const [hasLoadedProjects, setHasLoadedProjects] = useState(false);

  useEffect(() => {
    let isCancelled = false;

    void loadProjects()
      .then((storedProjects) => {
        if (!isCancelled) {
          setProjects(storedProjects);
        }
      })
      .catch((error) => {
        console.error("Failed to load projects from SQLite", error);
      })
      .finally(() => {
        if (!isCancelled) {
          setHasLoadedProjects(true);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, []);

  const value = useMemo<ProjectSettingsContextValue>(
    () => ({
      addProject: (name, path) => {
        const normalizedName = name.trim();
        const existingProject = projects.find((project) => project.name === normalizedName);
        if (existingProject) return existingProject;

        const project: AppProject = {
          id: createProjectId(normalizedName),
          name: normalizedName,
          path,
          createdAt: Date.now(),
        };

        setProjects((currentProjects) => [...currentProjects, project]);
        void saveStoredProject(project).catch((error) => {
          console.error("Failed to save project to SQLite", error);
        });
        return project;
      },
      deleteProject: (projectId) => {
        setProjects((currentProjects) => currentProjects.filter((project) => project.id !== projectId));
        void deleteStoredProject(projectId).catch((error) => {
          console.error("Failed to delete project from SQLite", error);
        });
      },
      hasLoadedProjects,
      projects,
    }),
    [hasLoadedProjects, projects],
  );

  return <ProjectSettingsContext.Provider value={value}>{children}</ProjectSettingsContext.Provider>;
}

export function useProjectSettings() {
  const context = useContext(ProjectSettingsContext);

  if (!context) {
    throw new Error("useProjectSettings must be used within ProjectSettingsProvider");
  }

  return context;
}
