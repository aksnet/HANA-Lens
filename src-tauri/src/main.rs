// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::time::UNIX_EPOCH;
use tauri::Manager;

#[derive(Serialize)]
struct DirEntry {
    name: String,
    kind: String, // "file" or "directory"
    size: Option<u64>,
    #[serde(rename = "lastModified")]
    last_modified: Option<u64>,
}

#[derive(Serialize)]
struct FileMetadata {
    size: u64,
    #[serde(rename = "lastModified")]
    last_modified: u64,
}

// List directory contents with name, kind, size, lastModified
#[tauri::command]
fn read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let entries = fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = entry.metadata().ok();
        let name = entry.file_name().to_string_lossy().to_string();
        let kind = if entry.path().is_dir() { "directory" } else { "file" }.to_string();
        let size = meta.as_ref().filter(|m| m.is_file()).map(|m| m.len());
        let last_modified = meta.as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);
        result.push(DirEntry { name, kind, size, last_modified });
    }
    Ok(result)
}

// Read entire file as UTF-8 text (with lossy conversion for non-UTF-8)
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

// Read a byte range from a file and return as UTF-8 text (for chunked trace file viewing)
#[tauri::command]
fn read_file_range(path: String, offset: u64, length: u64) -> Result<String, String> {
    let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; length as usize];
    let n = file.read(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(n);
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

// Get file size and last-modified timestamp
#[tauri::command]
fn get_file_metadata(path: String) -> Result<FileMetadata, String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    let size = meta.len();
    let last_modified = meta.modified().ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileMetadata { size, last_modified })
}

// Check whether a path exists with the given kind ("file" or "directory")
#[tauri::command]
fn entry_exists(path: String, kind: String) -> bool {
    let p = std::path::Path::new(&path);
    if kind == "file" { p.is_file() } else { p.is_dir() }
}

// Open an http/https URL in the system default browser
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Only http/https URLs are supported".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url.as_str()])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url.as_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Read .txt filter files from filter_pre-defined and filter_custom folders
// Search order: executable_dir (Windows portable, next to .exe), resource_dir (macOS .app bundle),
//               app_data_dir (user-writable: %APPDATA%\com.sap.hana-lens\ / ~/Library/Application Support/com.sap.hana-lens/)
#[tauri::command]
fn read_filter_files(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    use std::collections::HashSet;
    let mut result: Vec<serde_json::Value> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut bases: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(p) = app.path().executable_dir() { bases.push(p); }
    if let Ok(p) = app.path().resource_dir() { bases.push(p); }
    if let Ok(p) = app.path().app_data_dir() { bases.push(p); }
    for base in bases {
        for folder in &["filter_pre-defined", "filter_custom"] {
            let dir = base.join(folder);
            let entries = match fs::read_dir(&dir) { Ok(e) => e, Err(_) => continue };
            let mut folder_items: Vec<serde_json::Value> = Vec::new();
            for entry in entries.flatten() {
                let path = entry.path();
                let ext = path.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase());
                if ext.as_deref() != Some("txt") { continue; }
                let stem = match path.file_stem().and_then(|s| s.to_str()) {
                    Some(s) => s.to_string(), None => continue,
                };
                let key = format!("{}/{}", folder, stem);
                if seen.contains(&key) { continue; }
                seen.insert(key);
                let content = fs::read_to_string(&path).unwrap_or_default().trim().to_string();
                folder_items.push(serde_json::json!({
                    "name": stem, "source": folder.to_string(), "content": content
                }));
            }
            folder_items.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
            result.extend(folder_items);
        }
    }
    result
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_dir,
            read_text_file,
            read_file_range,
            get_file_metadata,
            entry_exists,
            open_external_url,
            read_filter_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
