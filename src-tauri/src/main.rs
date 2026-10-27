// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::sync::{Arc, OnceLock, RwLock};
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

// ── Trace file index cache ────────────────────────────────────────────────────

struct TraceFile {
    content: Vec<u8>,
    offsets: Vec<u32>, // byte offset of each line's start in content
}

static TRACE_CACHE: OnceLock<RwLock<HashMap<String, Arc<TraceFile>>>> = OnceLock::new();

fn trace_cache() -> &'static RwLock<HashMap<String, Arc<TraceFile>>> {
    TRACE_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn get_trace_cached(path: &str) -> Option<Arc<TraceFile>> {
    trace_cache().read().ok()?.get(path).map(Arc::clone)
}

fn trace_extract_line(tf: &TraceFile, idx: usize) -> String {
    if idx >= tf.offsets.len() {
        return String::new();
    }
    let start = tf.offsets[idx] as usize;
    let end = if idx + 1 < tf.offsets.len() {
        tf.offsets[idx + 1] as usize
    } else {
        tf.content.len()
    };
    let bytes = tf.content.get(start..end).unwrap_or(&[]);
    let bytes = bytes
        .strip_suffix(b"\r\n")
        .or_else(|| bytes.strip_suffix(b"\n"))
        .unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

// Scan up to first 200 bytes of a line for a YYYY-MM-DD HH:MM:SS / YYYY-MM-DDTHH:MM:SS pattern.
// Returns 19-byte normalized timestamp with 'T' separator, suitable for string comparison.
fn extract_timestamp(bytes: &[u8]) -> Option<[u8; 19]> {
    let limit = bytes.len().saturating_sub(18).min(200);
    for i in 0..=limit {
        let s = &bytes[i..];
        if s.len() >= 19
            && s[0..4].iter().all(|b| b.is_ascii_digit())
            && s[4] == b'-'
            && s[5..7].iter().all(|b| b.is_ascii_digit())
            && s[7] == b'-'
            && s[8..10].iter().all(|b| b.is_ascii_digit())
            && (s[10] == b' ' || s[10] == b'T')
            && s[11..13].iter().all(|b| b.is_ascii_digit())
            && s[13] == b':'
            && s[14..16].iter().all(|b| b.is_ascii_digit())
            && s[16] == b':'
            && s[17..19].iter().all(|b| b.is_ascii_digit())
        {
            let mut out = [0u8; 19];
            out[..4].copy_from_slice(&s[..4]);
            out[4] = b'-';
            out[5..7].copy_from_slice(&s[5..7]);
            out[7] = b'-';
            out[8..10].copy_from_slice(&s[8..10]);
            out[10] = b'T'; // normalize to T for string comparison
            out[11..13].copy_from_slice(&s[11..13]);
            out[13] = b':';
            out[14..16].copy_from_slice(&s[14..16]);
            out[16] = b':';
            out[17..19].copy_from_slice(&s[17..19]);
            return Some(out);
        }
    }
    None
}

fn ts_to_t_string(ts: &[u8; 19]) -> String {
    String::from_utf8_lossy(ts).into_owned()
}

fn get_line_timestamp(tf: &TraceFile, idx: usize) -> Option<[u8; 19]> {
    if idx >= tf.offsets.len() {
        return None;
    }
    let start = tf.offsets[idx] as usize;
    let end = (start + 200).min(tf.content.len());
    extract_timestamp(&tf.content[start..end])
}

// ── Trace Tauri commands ──────────────────────────────────────────────────────

// Index a file, cache line offsets, return {lineCount, fileSize, firstTs, lastTs}.
// firstTs/lastTs are "YYYY-MM-DDTHH:MM:SS" strings (null if no timestamps found).
#[tauri::command]
fn trace_open(path: String) -> Result<serde_json::Value, String> {
    let content = fs::read(&path).map_err(|e| e.to_string())?;
    let file_size = content.len() as u64;
    let mut offsets: Vec<u32> = vec![0];
    for (i, &b) in content.iter().enumerate() {
        if b == b'\n' && i + 1 < content.len() {
            offsets.push((i + 1) as u32);
        }
    }
    let line_count = offsets.len() as u32;
    let tf = Arc::new(TraceFile { content, offsets });

    // Find first timestamp (scan forward)
    let first_ts = (0..tf.offsets.len())
        .find_map(|i| get_line_timestamp(&tf, i).map(|ts| ts_to_t_string(&ts)));

    // Find last timestamp (scan backward from end)
    let last_ts = (0..tf.offsets.len())
        .rev()
        .find_map(|i| get_line_timestamp(&tf, i).map(|ts| ts_to_t_string(&ts)));

    trace_cache().write().unwrap().insert(path, tf);

    Ok(serde_json::json!({
        "lineCount": line_count,
        "fileSize": file_size,
        "firstTs": first_ts,
        "lastTs": last_ts,
    }))
}

// Fetch lines[from .. from+count] as a Vec<String>.
#[tauri::command]
fn trace_get_lines(path: String, from: u32, count: u32) -> Result<Vec<String>, String> {
    let tf = get_trace_cached(&path).ok_or("File not indexed")?;
    let from = from as usize;
    let end = (from + count as usize).min(tf.offsets.len());
    Ok((from..end).map(|i| trace_extract_line(&tf, i)).collect())
}

// Fetch lines at specific (original) indices.
#[tauri::command]
fn trace_get_lines_at(path: String, indices: Vec<u32>) -> Result<Vec<String>, String> {
    let tf = get_trace_cached(&path).ok_or("File not indexed")?;
    Ok(indices
        .iter()
        .map(|&i| trace_extract_line(&tf, i as usize))
        .collect())
}

// Case-insensitive ASCII search: return original line indices where ANY term matches.
#[tauri::command]
fn trace_search(path: String, terms: Vec<String>) -> Result<Vec<u32>, String> {
    let tf = get_trace_cached(&path).ok_or("File not indexed")?;
    let lower: Vec<Vec<u8>> = terms
        .into_iter()
        .map(|t| t.to_ascii_lowercase().into_bytes())
        .filter(|t| !t.is_empty())
        .collect();
    if lower.is_empty() {
        return Ok(vec![]);
    }
    let matches: Vec<u32> = tf
        .offsets
        .iter()
        .enumerate()
        .filter(|&(i, &start_off)| {
            let end_off = if i + 1 < tf.offsets.len() {
                tf.offsets[i + 1] as usize
            } else {
                tf.content.len()
            };
            let line = tf.content[start_off as usize..end_off].to_ascii_lowercase();
            lower
                .iter()
                .any(|t| line.windows(t.len()).any(|w| w == t.as_slice()))
        })
        .map(|(i, _)| i as u32)
        .collect();
    Ok(matches)
}

// Return original line indices whose timestamp falls within [from_ts, to_ts].
// Lines without a timestamp inherit visibility from the most recent timestamped line above them
// (same "sticky" behavior as the JS implementation).
// from_ts / to_ts are "YYYY-MM-DDTHH:MM:SS" strings; pass null to open-end the range.
#[tauri::command]
fn trace_search_time_range(
    path: String,
    from_ts: Option<String>,
    to_ts: Option<String>,
) -> Result<Vec<u32>, String> {
    let tf = get_trace_cached(&path).ok_or("File not indexed")?;

    let from_bytes: Option<[u8; 19]> = from_ts
        .as_deref()
        .and_then(|s| s.as_bytes().try_into().ok());
    let to_bytes: Option<[u8; 19]> = to_ts
        .as_deref()
        .and_then(|s| s.as_bytes().try_into().ok());

    let mut last_visible = from_bytes.is_none();
    let mut matches: Vec<u32> = Vec::new();

    for i in 0..tf.offsets.len() {
        if let Some(ts) = get_line_timestamp(&tf, i) {
            let in_range = from_bytes.as_ref().map(|f| ts >= *f).unwrap_or(true)
                && to_bytes.as_ref().map(|t| ts <= *t).unwrap_or(true);
            last_visible = in_range;
        }
        if last_visible {
            matches.push(i as u32);
        }
    }
    Ok(matches)
}

// Remove a file from the index cache to free memory.
#[tauri::command]
fn trace_close(path: String) {
    trace_cache().write().unwrap().remove(&path);
}

// ── Directory / file commands ─────────────────────────────────────────────────

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
        let last_modified = meta
            .as_ref()
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
    use std::io::Read;
    let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(length as usize);
    file.take(length).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

// Get file size and last-modified timestamp
#[tauri::command]
fn get_file_metadata(path: String) -> Result<FileMetadata, String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    let size = meta.len();
    let last_modified = meta
        .modified()
        .ok()
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

// Check whether a path is accessible within 500 ms.
// Uses a background thread + channel timeout so that unavailable network
// paths (mapped drives, UNC shares) do not block the UI.
#[tauri::command]
fn path_accessible(path: String) -> bool {
    use std::sync::mpsc;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let ok = std::path::Path::new(&path).exists();
        let _ = tx.send(ok);
    });
    rx.recv_timeout(std::time::Duration::from_millis(500)).unwrap_or(false)
}

// Open an http/https URL in the system default browser
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
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

// Open a folder path in Windows Explorer / macOS Finder
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let win_path = path.replace('/', "\\");
        std::process::Command::new("explorer")
            .arg(&win_path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
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

// Read filesystem_reference.txt from executable_dir / resource_dir / app_data_dir
#[tauri::command]
fn read_fs_reference(app: tauri::AppHandle) -> Option<String> {
    let mut bases: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(p) = app.path().executable_dir() { bases.push(p); }
    if let Ok(p) = app.path().resource_dir() { bases.push(p); }
    if let Ok(p) = app.path().app_data_dir() { bases.push(p); }
    for base in bases {
        let path = base.join("filesystem_reference.txt");
        if let Ok(content) = fs::read_to_string(&path) {
            return Some(content);
        }
    }
    None
}

// Resolve the directory where hana-lens-settings.json lives.
// Order of preference:
//   1. Directory next to the exe (Windows/Linux) or next to the .app bundle (macOS)
//      → used for portable installs; verified writable via a probe write
//   2. Tauri app_data_dir (%APPDATA%\com.sap.hana-lens\ on Windows)
//      → fallback when running from Program Files or other write-protected locations
// The result is cached after the first call so the probe only runs once.
static SETTINGS_DIR_CACHE: OnceLock<std::path::PathBuf> = OnceLock::new();

fn settings_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    SETTINGS_DIR_CACHE.get_or_init(|| {
        // Determine exe-adjacent candidate dir
        let candidate: Option<std::path::PathBuf> = std::env::current_exe().ok().and_then(|exe| {
            #[cfg(target_os = "macos")]
            {
                for ancestor in exe.ancestors() {
                    if ancestor.extension().map(|e| e == "app").unwrap_or(false) {
                        if let Some(p) = ancestor.parent() {
                            return Some(p.to_path_buf());
                        }
                    }
                }
            }
            exe.parent().map(|d| d.to_path_buf())
        });

        // Check if the candidate dir is actually writable
        if let Some(dir) = candidate {
            let probe = dir.join(".hana-lens-write-probe");
            if fs::write(&probe, b"").is_ok() {
                let _ = fs::remove_file(&probe);
                return dir;
            }
        }

        // Fallback: app_data_dir is always writable
        app.path()
            .app_data_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from("."))
    })
    .clone()
}

// Read hana-lens-settings.json from the settings directory
#[tauri::command]
fn read_settings(app: tauri::AppHandle) -> Option<String> {
    fs::read_to_string(settings_dir(&app).join("hana-lens-settings.json")).ok()
}

// Write hana-lens-settings.json to the settings directory (next to the exe / .app)
#[tauri::command]
fn write_settings(app: tauri::AppHandle, content: String) -> Result<(), String> {
    let dir = settings_dir(&app);
    let _ = fs::create_dir_all(&dir);
    fs::write(dir.join("hana-lens-settings.json"), content).map_err(|e| e.to_string())
}

// Return the full path of the settings file (existing or expected)
#[tauri::command]
fn get_settings_path(app: tauri::AppHandle) -> String {
    settings_dir(&app).join("hana-lens-settings.json").display().to_string()
}

// Write arbitrary text to a file path — used for settings Export
#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_in_dump_analyzer(app: tauri::AppHandle, dump_path: String) -> Result<(), String> {
    let mut bases: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(p) = app.path().executable_dir() { bases.push(p); }
    if let Ok(p) = app.path().resource_dir() { bases.push(p); }
    if let Ok(p) = app.path().app_data_dir() { bases.push(p); }
    let jar = bases
        .iter()
        .map(|b| b.join("SAP_HanaDumpAnalyzer").join("HanaDumpAnalyzer.jar"))
        .find(|p| p.exists())
        .ok_or_else(|| "HanaDumpAnalyzer.jar not found in SAP_HanaDumpAnalyzer/".to_string())?;
    std::process::Command::new("java")
        .arg("-jar")
        .arg(&jar)
        .arg("-s")
        .arg(&dump_path)
        .spawn()
        .map_err(|e| format!("Failed to start java: {}", e))?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            trace_open,
            trace_get_lines,
            trace_get_lines_at,
            trace_search,
            trace_search_time_range,
            trace_close,
            read_dir,
            read_text_file,
            read_file_range,
            get_file_metadata,
            entry_exists,
            path_accessible,
            open_external_url,
            open_folder,
            read_filter_files,
            read_fs_reference,
            read_settings,
            write_settings,
            get_settings_path,
            write_text_file,
            open_in_dump_analyzer,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
