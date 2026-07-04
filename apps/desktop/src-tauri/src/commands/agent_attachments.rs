use base64::Engine;
use my_copilot_agent::{
    AgentInputAttachment, AgentInputAttachmentEncoding, AgentInputAttachmentKind,
};
use std::fs;
use std::path::{Path, PathBuf};

const MAX_ATTACHMENT_BYTES: u64 = 8 * 1024 * 1024;

#[tauri::command]
pub fn select_agent_input_attachments(
    kind: AgentInputAttachmentKind,
) -> Result<Vec<AgentInputAttachment>, String> {
    let dialog = match kind {
        AgentInputAttachmentKind::Image => rfd::FileDialog::new().add_filter(
            "Images",
            &[
                "apng", "avif", "bmp", "gif", "heic", "heif", "ico", "jpg", "jpeg", "png", "svg",
                "tif", "tiff", "webp",
            ],
        ),
        AgentInputAttachmentKind::File => rfd::FileDialog::new().add_filter(
            "Readable files",
            &[
                "pdf",
                "docx",
                "doc",
                "pptx",
                "ppt",
                "xlsx",
                "xls",
                "csv",
                "tsv",
                "txt",
                "text",
                "md",
                "markdown",
                "mdx",
                "rst",
                "log",
                "json",
                "jsonl",
                "yaml",
                "yml",
                "toml",
                "ini",
                "cfg",
                "conf",
                "env",
                "lock",
                "properties",
                "plist",
                "rc",
                "gitignore",
                "gitattributes",
                "editorconfig",
                "py",
                "pyi",
                "ipynb",
                "js",
                "jsx",
                "ts",
                "tsx",
                "mjs",
                "cjs",
                "html",
                "htm",
                "css",
                "scss",
                "sass",
                "less",
                "xml",
                "svg",
                "sql",
                "graphql",
                "gql",
                "proto",
                "prisma",
                "sh",
                "bash",
                "zsh",
                "fish",
                "ps1",
                "bat",
                "cmd",
                "rs",
                "go",
                "java",
                "kt",
                "kts",
                "c",
                "h",
                "cpp",
                "cc",
                "cxx",
                "hpp",
                "hh",
                "hxx",
                "cs",
                "php",
                "rb",
                "swift",
                "scala",
                "r",
                "m",
                "pl",
                "pm",
                "lua",
                "dart",
                "ex",
                "exs",
                "erl",
                "hrl",
                "clj",
                "cljs",
                "cljc",
                "edn",
                "fs",
                "fsi",
                "fsx",
                "elm",
                "hs",
                "lhs",
                "jl",
                "ml",
                "mli",
                "nim",
                "nims",
                "zig",
                "v",
                "vh",
                "sv",
                "svh",
                "sol",
                "tf",
                "tfvars",
                "hcl",
                "gradle",
                "groovy",
                "dockerfile",
                "cmake",
                "make",
                "mk",
                "tex",
                "bib",
                "vue",
                "svelte",
                "astro",
            ],
        ),
    };

    let Some(paths) = dialog.pick_files() else {
        return Ok(Vec::new());
    };

    paths
        .iter()
        .enumerate()
        .map(|(index, path)| attachment_from_path(kind, path, index))
        .collect()
}

#[tauri::command]
pub fn load_agent_input_attachments_from_paths(
    paths: Vec<String>,
) -> Result<Vec<AgentInputAttachment>, String> {
    paths
        .iter()
        .enumerate()
        .map(|(index, path)| {
            let path = PathBuf::from(path);
            let kind = infer_attachment_kind(&path).ok_or_else(|| {
                format!(
                    "不支持的附件类型：{}",
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("未知文件")
                )
            })?;
            attachment_from_path(kind, &path, index)
        })
        .collect()
}

fn attachment_from_path(
    kind: AgentInputAttachmentKind,
    path: &Path,
    index: usize,
) -> Result<AgentInputAttachment, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("读取附件元数据失败：{error}"))?;
    if !metadata.is_file() {
        return Err("只能添加文件附件。".to_string());
    }
    if metadata.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "附件「{}」过大，单个附件最大 8 MB。",
            file_name(path)
        ));
    }

    let name = file_name(path);
    let mime_type = infer_mime_type(path, kind);
    let bytes = fs::read(path).map_err(|error| format!("读取附件失败：{error}"))?;
    let encoding = AgentInputAttachmentEncoding::Base64;
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);

    Ok(AgentInputAttachment {
        id: format!(
            "attachment-{}-{index}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or(0)
        ),
        kind,
        name,
        mime_type,
        size_bytes: metadata.len(),
        encoding,
        data,
        truncated: None,
    })
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(ToString::to_string)
        .unwrap_or_else(|| "attachment".to_string())
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .unwrap_or_default()
}

fn infer_attachment_kind(path: &Path) -> Option<AgentInputAttachmentKind> {
    if is_image_extension(path) {
        return Some(AgentInputAttachmentKind::Image);
    }

    if is_readable_file_extension(path) {
        return Some(AgentInputAttachmentKind::File);
    }

    None
}

fn is_image_extension(path: &Path) -> bool {
    matches!(
        extension(path).as_str(),
        "apng"
            | "avif"
            | "bmp"
            | "gif"
            | "heic"
            | "heif"
            | "ico"
            | "jpg"
            | "jpeg"
            | "png"
            | "svg"
            | "tif"
            | "tiff"
            | "webp"
    )
}

fn is_readable_file_extension(path: &Path) -> bool {
    matches!(
        extension(path).as_str(),
        "pdf"
            | "doc"
            | "docx"
            | "ppt"
            | "pptx"
            | "xls"
            | "xlsx"
            | "csv"
            | "tsv"
    ) || is_text_extension(path)
}

fn infer_mime_type(path: &Path, kind: AgentInputAttachmentKind) -> Option<String> {
    let mime = match extension(path).as_str() {
        "pdf" => "application/pdf",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "html" | "htm" => "text/html",
        "json" | "jsonl" => "application/json",
        "xml" => "application/xml",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "avif" => "image/avif",
        "heic" => "image/heic",
        "heif" => "image/heif",
        _ if kind == AgentInputAttachmentKind::Image => "application/octet-stream",
        _ if is_text_extension(path) => "text/plain",
        _ => "application/octet-stream",
    };

    Some(mime.to_string())
}

fn is_text_extension(path: &Path) -> bool {
    matches!(
        extension(path).as_str(),
        "txt"
            | "text"
            | "md"
            | "markdown"
            | "mdx"
            | "rst"
            | "log"
            | "json"
            | "jsonl"
            | "yaml"
            | "yml"
            | "toml"
            | "ini"
            | "cfg"
            | "conf"
            | "env"
            | "lock"
            | "properties"
            | "plist"
            | "rc"
            | "gitignore"
            | "gitattributes"
            | "editorconfig"
            | "py"
            | "pyi"
            | "ipynb"
            | "js"
            | "jsx"
            | "ts"
            | "tsx"
            | "mjs"
            | "cjs"
            | "html"
            | "htm"
            | "css"
            | "scss"
            | "sass"
            | "less"
            | "xml"
            | "svg"
            | "sql"
            | "graphql"
            | "gql"
            | "proto"
            | "prisma"
            | "sh"
            | "bash"
            | "zsh"
            | "fish"
            | "ps1"
            | "bat"
            | "cmd"
            | "rs"
            | "go"
            | "java"
            | "kt"
            | "kts"
            | "c"
            | "h"
            | "cpp"
            | "cc"
            | "cxx"
            | "hpp"
            | "hh"
            | "hxx"
            | "cs"
            | "php"
            | "rb"
            | "swift"
            | "scala"
            | "r"
            | "m"
            | "pl"
            | "pm"
            | "lua"
            | "dart"
            | "ex"
            | "exs"
            | "erl"
            | "hrl"
            | "clj"
            | "cljs"
            | "cljc"
            | "edn"
            | "fs"
            | "fsi"
            | "fsx"
            | "elm"
            | "hs"
            | "lhs"
            | "jl"
            | "ml"
            | "mli"
            | "nim"
            | "nims"
            | "zig"
            | "v"
            | "vh"
            | "sv"
            | "svh"
            | "sol"
            | "tf"
            | "tfvars"
            | "hcl"
            | "gradle"
            | "groovy"
            | "dockerfile"
            | "cmake"
            | "make"
            | "mk"
            | "tex"
            | "bib"
            | "vue"
            | "svelte"
            | "astro"
            | "csv"
            | "tsv"
    )
}
