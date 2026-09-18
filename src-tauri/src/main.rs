// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::time::UNIX_EPOCH;

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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_dir,
            read_text_file,
            read_file_range,
            get_file_metadata,
            entry_exists,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
