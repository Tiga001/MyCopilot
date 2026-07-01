export interface AppProject {
  id: string;
  name: string;
  path?: string;
  createdAt: number;
}

export const projectConfig = {
  initialProjects: [] satisfies AppProject[],
} as const;

export function createProjectId(name: string) {
  const normalizedName = name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-");
  return `project-${normalizedName || "local"}-${Date.now()}`;
}

export function getFolderNameFromFileList(files: FileList | null) {
  const firstFile = files?.[0];
  if (!firstFile) return null;

  const relativePath = firstFile.webkitRelativePath;
  return relativePath.split("/")[0] || firstFile.name;
}
