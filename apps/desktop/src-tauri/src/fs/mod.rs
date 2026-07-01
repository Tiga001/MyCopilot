pub mod patch;

use std::path::{Component, Path, PathBuf};

pub fn canonical_workspace_root(workspace_root: &Path) -> Result<PathBuf, String> {
    let root = workspace_root
        .canonicalize()
        .map_err(|error| format!("workspace 路径不可访问：{error}"))?;
    if !root.is_dir() {
        return Err("workspace 路径不是目录。".to_string());
    }

    Ok(root)
}

pub fn clean_relative_path(input_path: &str) -> Result<PathBuf, String> {
    let trimmed = input_path.trim();
    if trimmed.is_empty() {
        return Err("路径不能为空。".to_string());
    }

    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err("路径必须是 workspace 相对路径。".to_string());
    }

    let mut cleaned = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => cleaned.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("路径不能包含 .. 或系统根路径。".to_string());
            }
        }
    }

    if cleaned.as_os_str().is_empty() {
        return Err("路径不能为空。".to_string());
    }

    Ok(cleaned)
}

pub fn relative_display(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}
