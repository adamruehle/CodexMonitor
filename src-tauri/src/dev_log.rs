use chrono::Utc;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const LOG_DIR: &str = "logs";
const LOG_FILE: &str = "codex-monitor-dev.jsonl";
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
const ROTATED_LOGS: usize = 3;

fn repo_root() -> Result<PathBuf, String> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "could not resolve CodexMonitor repo root".to_string())
}

fn dev_log_path() -> Result<PathBuf, String> {
    Ok(repo_root()?.join(LOG_DIR).join(LOG_FILE))
}

fn rotated_log_path(path: &Path, index: usize) -> PathBuf {
    path.with_file_name(format!("{LOG_FILE}.{index}"))
}

fn rotate_dev_log_if_needed(path: &Path) -> Result<(), String> {
    let Ok(metadata) = fs::metadata(path) else {
        return Ok(());
    };
    if metadata.len() < MAX_LOG_BYTES {
        return Ok(());
    }

    for index in (1..=ROTATED_LOGS).rev() {
        let current = rotated_log_path(path, index);
        if index == ROTATED_LOGS {
            let _ = fs::remove_file(current);
            continue;
        }
        let next = rotated_log_path(path, index + 1);
        if current.exists() {
            let _ = fs::rename(current, next);
        }
    }
    let first = rotated_log_path(path, 1);
    let _ = fs::rename(path, first);
    Ok(())
}

#[tauri::command]
pub(crate) fn append_dev_log(entry: Value) -> Result<Value, String> {
    let path = dev_log_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    rotate_dev_log_if_needed(&path)?;

    let line = json!({
        "writtenAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "entry": entry,
    });
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|err| err.to_string())?;
    let serialized = serde_json::to_string(&line).map_err(|err| err.to_string())?;
    writeln!(file, "{serialized}").map_err(|err| err.to_string())?;
    Ok(json!({ "path": path }))
}
