use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use tokio::sync::Mutex;

use crate::codex::home::resolve_home_dir;
use crate::types::WorkspaceEntry;

pub(crate) const CLAUDE_THREAD_PREFIX: &str = "claude:";

#[derive(Debug, Clone)]
pub(crate) struct ClaudeSessionSummary {
    pub(crate) session_id: String,
    pub(crate) thread_id: String,
    pub(crate) full_path: PathBuf,
    pub(crate) cwd: String,
    pub(crate) original_path: String,
    pub(crate) first_prompt: String,
    pub(crate) created: Option<String>,
    pub(crate) modified: Option<String>,
    pub(crate) git_branch: Option<String>,
    pub(crate) is_sidechain: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeSessionIndexFile {
    #[serde(default)]
    entries: Vec<ClaudeSessionIndexEntry>,
    #[serde(default)]
    original_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeSessionIndexEntry {
    session_id: String,
    full_path: String,
    #[serde(default)]
    first_prompt: Option<String>,
    #[serde(default)]
    created: Option<String>,
    #[serde(default)]
    modified: Option<String>,
    #[serde(default)]
    git_branch: Option<String>,
    #[serde(default)]
    project_path: Option<String>,
    #[serde(default)]
    is_sidechain: bool,
}

pub(crate) fn is_claude_thread_id(thread_id: &str) -> bool {
    thread_id.trim().starts_with(CLAUDE_THREAD_PREFIX)
}

pub(crate) fn discover_claude_sessions() -> Vec<ClaudeSessionSummary> {
    let Some(home) = resolve_home_dir() else {
        return Vec::new();
    };
    let projects_root = home.join(".claude").join("projects");
    discover_claude_sessions_in_projects_root(&projects_root)
}

fn discover_claude_sessions_in_projects_root(projects_root: &Path) -> Vec<ClaudeSessionSummary> {
    let entries = match std::fs::read_dir(&projects_root) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };

    let mut sessions = Vec::new();
    for entry in entries.flatten() {
        let project_dir = entry.path();
        if !project_dir.is_dir() {
            continue;
        }
        sessions.extend(discover_claude_sessions_in_project_dir(&project_dir));
    }

    sessions.sort_by(|left, right| {
        right
            .modified
            .as_deref()
            .unwrap_or("")
            .cmp(left.modified.as_deref().unwrap_or(""))
    });
    sessions
}

fn read_claude_session_index(project_dir: &Path) -> Option<ClaudeSessionIndexFile> {
    let index_path = project_dir.join("sessions-index.json");
    let raw = std::fs::read_to_string(index_path).ok()?;
    serde_json::from_str::<ClaudeSessionIndexFile>(&raw).ok()
}

fn build_session_summary_from_index_entry(
    item: ClaudeSessionIndexEntry,
    original_path: &str,
) -> Option<ClaudeSessionSummary> {
    let session_id = item.session_id.trim();
    if session_id.is_empty() {
        return None;
    }
    let full_path = PathBuf::from(item.full_path.trim());
    if full_path.as_os_str().is_empty() || !full_path.is_file() {
        return None;
    }
    let cwd = item
        .project_path
        .as_deref()
        .unwrap_or(original_path)
        .trim()
        .to_string();
    if cwd.is_empty() {
        return None;
    }
    Some(ClaudeSessionSummary {
        session_id: session_id.to_string(),
        thread_id: format!("{CLAUDE_THREAD_PREFIX}{session_id}"),
        full_path,
        cwd,
        original_path: original_path.to_string(),
        first_prompt: item.first_prompt.unwrap_or_default(),
        created: item.created,
        modified: item.modified,
        git_branch: item.git_branch,
        is_sidechain: item.is_sidechain,
    })
}

fn extract_user_message_text(message: &Map<String, Value>) -> String {
    let Some(content) = message.get("content") else {
        return String::new();
    };
    match content {
        Value::String(text) => text.trim().to_string(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(Value::as_object)
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| extract_string(part.get("text")))
            .collect::<Vec<_>>()
            .join("\n\n")
            .trim()
            .to_string(),
        _ => String::new(),
    }
}

fn session_id_fallback(session_path: &Path) -> Option<String> {
    let raw = if session_path.is_dir() {
        session_path.file_name()?.to_string_lossy().to_string()
    } else {
        session_path.file_stem()?.to_string_lossy().to_string()
    };
    let trimmed = raw.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn collect_session_jsonl_paths(session_path: &Path) -> Vec<PathBuf> {
    if session_path.is_file() {
        return if session_path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            vec![session_path.to_path_buf()]
        } else {
            Vec::new()
        };
    }
    if !session_path.is_dir() {
        return Vec::new();
    }

    let mut stack = vec![session_path.to_path_buf()];
    let mut paths = Vec::new();
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
                paths.push(path);
            }
        }
    }
    paths.sort();
    paths
}

fn collect_session_records(session_path: &Path) -> Vec<Map<String, Value>> {
    let mut records: Vec<(String, usize, Map<String, Value>)> = Vec::new();
    let mut sequence = 0usize;
    for path in collect_session_jsonl_paths(session_path) {
        let Ok(file) = File::open(path) else {
            continue;
        };
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            let Some(record) = value.as_object() else {
                continue;
            };
            let timestamp = extract_string(record.get("timestamp")).unwrap_or_default();
            records.push((timestamp, sequence, record.clone()));
            sequence += 1;
        }
    }
    records.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
    records
        .into_iter()
        .map(|(_, _, record)| record)
        .collect::<Vec<_>>()
}

fn build_session_summary_from_path(
    session_path: &Path,
    fallback_original_path: Option<&str>,
) -> Option<ClaudeSessionSummary> {
    let records = collect_session_records(session_path);
    if records.is_empty() {
        return None;
    }
    let fallback_session_id = session_id_fallback(session_path)?;

    let mut session_id = fallback_session_id;
    let mut cwd = String::new();
    let mut original_path = fallback_original_path.unwrap_or("").trim().to_string();
    let mut first_prompt = String::new();
    let mut created: Option<String> = None;
    let mut modified: Option<String> = None;
    let mut git_branch: Option<String> = None;
    let mut is_sidechain = false;
    let mut has_primary_activity = false;

    for record in records {
        if let Some(found_session_id) = extract_string(record.get("sessionId")) {
            session_id = found_session_id;
        }
        if cwd.is_empty() {
            if let Some(found_cwd) = extract_string(record.get("cwd")) {
                cwd = found_cwd;
            }
        }
        if original_path.is_empty() && !cwd.is_empty() {
            original_path = cwd.clone();
        }
        if git_branch.is_none() {
            git_branch = extract_string(record.get("gitBranch"));
        }
        let record_is_sidechain = record.get("isSidechain").and_then(Value::as_bool) == Some(true);
        if record_is_sidechain {
            is_sidechain = true;
        } else {
            has_primary_activity = true;
        }
        if let Some(timestamp) = extract_string(record.get("timestamp")) {
            if created
                .as_deref()
                .map(|current| timestamp.as_str() < current)
                .unwrap_or(true)
            {
                created = Some(timestamp.clone());
            }
            if modified
                .as_deref()
                .map(|current| timestamp.as_str() > current)
                .unwrap_or(true)
            {
                modified = Some(timestamp);
            }
        }
        if first_prompt.is_empty() {
            let is_user = record.get("type").and_then(Value::as_str) == Some("user");
            let message = record.get("message").and_then(Value::as_object);
            if is_user && message.and_then(|msg| msg.get("role")).and_then(Value::as_str) == Some("user") {
                first_prompt = message.map(extract_user_message_text).unwrap_or_default();
            }
        }
    }

    if cwd.is_empty() {
        cwd = original_path.clone();
    }
    if cwd.trim().is_empty() {
        return None;
    }
    if !has_primary_activity {
        return None;
    }

    Some(ClaudeSessionSummary {
        thread_id: format!("{CLAUDE_THREAD_PREFIX}{session_id}"),
        session_id,
        full_path: session_path.to_path_buf(),
        cwd,
        original_path,
        first_prompt,
        created,
        modified,
        git_branch,
        is_sidechain,
    })
}

fn discover_claude_sessions_in_project_dir(project_dir: &Path) -> Vec<ClaudeSessionSummary> {
    let index = read_claude_session_index(project_dir);
    let original_path = index
        .as_ref()
        .and_then(|entry| entry.original_path.as_deref())
        .unwrap_or("")
        .trim()
        .to_string();
    let mut sessions = Vec::new();
    let mut seen_session_ids = HashSet::new();

    if let Some(index) = index {
        for item in index.entries {
            if let Some(summary) = build_session_summary_from_index_entry(item, &original_path) {
                seen_session_ids.insert(summary.session_id.clone());
                sessions.push(summary);
            }
        }
    }

    let jsonl_entries = match std::fs::read_dir(project_dir) {
        Ok(entries) => entries,
        Err(_) => return sessions,
    };
    for entry in jsonl_entries.flatten() {
        let path = entry.path();
        if path.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            if let Some(summary) = build_session_summary_from_path(&path, Some(&original_path)) {
                if seen_session_ids.insert(summary.session_id.clone()) {
                    sessions.push(summary);
                }
            }
        }
        if !path.is_dir() {
            continue;
        }
        if let Some(summary) = build_session_summary_from_path(&path, Some(&original_path)) {
            if seen_session_ids.insert(summary.session_id.clone()) {
                sessions.push(summary);
            }
        }
    }

    sessions
}

pub(crate) async fn workspace_roots(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
) -> Vec<String> {
    workspaces
        .lock()
        .await
        .values()
        .map(|entry| entry.path.clone())
        .collect()
}

fn normalize_root_path(value: &str) -> String {
    let normalized = value.replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.len() >= 3
        && trimmed.as_bytes()[1] == b':'
        && trimmed.as_bytes()[2] == b'/'
        && trimmed.as_bytes()[0].is_ascii_alphabetic()
    {
        return trimmed.to_ascii_lowercase();
    }
    trimmed.to_string()
}

fn path_within_root(path: &str, root: &str) -> bool {
    let normalized_path = normalize_root_path(path);
    let normalized_root = normalize_root_path(root);
    if normalized_path.is_empty() || normalized_root.is_empty() {
        return false;
    }
    normalized_path == normalized_root
        || (normalized_path.len() > normalized_root.len()
            && normalized_path.starts_with(&normalized_root)
            && normalized_path.as_bytes()[normalized_root.len()] == b'/')
}

fn session_matches_any_root(session: &ClaudeSessionSummary, roots: &[String]) -> bool {
    roots.iter().any(|root| {
        path_within_root(session.cwd.as_str(), root) || path_within_root(session.original_path.as_str(), root)
    })
}

fn truncate_preview(value: &str, limit: usize) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return "Claude session".to_string();
    }
    if trimmed.chars().count() <= limit {
        return trimmed.to_string();
    }
    let truncated: String = trimmed.chars().take(limit.saturating_sub(1)).collect();
    format!("{truncated}…")
}

pub(crate) fn build_claude_thread_stub(session: &ClaudeSessionSummary) -> Value {
    let preview = truncate_preview(session.first_prompt.as_str(), 180);
    json!({
        "id": session.thread_id,
        "provider": "claude",
        "source": if session.is_sidechain { "claudeSidechain" } else { "claudeCli" },
        "title": truncate_preview(session.first_prompt.as_str(), 96),
        "preview": preview,
        "cwd": session.cwd,
        "created_at": session.created,
        "updated_at": session.modified,
        "gitBranch": session.git_branch,
        "claude": {
            "sessionId": session.session_id,
            "path": session.full_path,
            "originalPath": session.original_path,
            "isSidechain": session.is_sidechain,
        }
    })
}

fn extract_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn assistant_content_parts(message: &Map<String, Value>) -> Vec<Map<String, Value>> {
    message
        .get("content")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|entry| entry.as_object().cloned())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn string_content_parts(value: &Value) -> Vec<Map<String, Value>> {
    match value {
        Value::String(text) => vec![Map::from_iter(vec![
            ("type".to_string(), Value::String("text".to_string())),
            ("text".to_string(), Value::String(text.clone())),
        ])],
        Value::Array(parts) => parts
            .iter()
            .filter_map(|entry| entry.as_object().cloned())
            .collect(),
        _ => Vec::new(),
    }
}

fn build_claude_turn(turn_id: String, timestamp: &str, items: Vec<Value>) -> Value {
    json!({
        "id": turn_id,
        "created_at": timestamp,
        "updated_at": timestamp,
        "items": items,
    })
}

fn item_output_for_result(content: &Map<String, Value>) -> String {
    let mut parts = Vec::new();
    if let Some(text) = extract_string(content.get("content")) {
        parts.push(text);
    }
    if let Some(tool_use_result) = content.get("toolUseResult").and_then(Value::as_object) {
        if let Some(stdout) = extract_string(tool_use_result.get("stdout")) {
            parts.push(stdout);
        }
        if let Some(stderr) = extract_string(tool_use_result.get("stderr")) {
            parts.push(stderr);
        }
    }
    parts.join("\n\n").trim().to_string()
}

fn append_output(existing: &mut Value, delta: &str) {
    if delta.trim().is_empty() {
        return;
    }
    let record = match existing.as_object_mut() {
        Some(record) => record,
        None => return,
    };
    let key = if record.get("type").and_then(Value::as_str) == Some("commandExecution") {
        "aggregatedOutput"
    } else {
        "result"
    };
    let current = record
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let next = if current.is_empty() {
        delta.trim().to_string()
    } else {
        format!("{current}\n{delta}")
    };
    record.insert(key.to_string(), Value::String(next));
}

fn mark_tool_result(
    turns: &mut [Value],
    tool_positions: &HashMap<String, (usize, usize)>,
    tool_use_id: &str,
    status: &str,
    output: &str,
) {
    let Some((turn_index, item_index)) = tool_positions.get(tool_use_id).copied() else {
        return;
    };
    let Some(turn) = turns.get_mut(turn_index).and_then(Value::as_object_mut) else {
        return;
    };
    let Some(items) = turn.get_mut("items").and_then(Value::as_array_mut) else {
        return;
    };
    let Some(item) = items.get_mut(item_index) else {
        return;
    };
    let Some(item_record) = item.as_object_mut() else {
        return;
    };
    item_record.insert("status".to_string(), Value::String(status.to_string()));
    append_output(item, output);
}

fn build_tool_item(
    content_index: usize,
    record: &Map<String, Value>,
    content: &Map<String, Value>,
    timestamp: &str,
    model: Option<&str>,
) -> Option<(String, Value)> {
    let tool_use_id = extract_string(content.get("id"))
        .unwrap_or_else(|| format!("tool-{}-{content_index}", record.get("uuid").and_then(Value::as_str).unwrap_or("claude")));
    let name = extract_string(content.get("name")).unwrap_or_else(|| "Tool".to_string());
    let input = content.get("input").cloned().unwrap_or(Value::Null);
    if name.eq_ignore_ascii_case("bash") {
        let input_record = input.as_object();
        let command = extract_string(input_record.and_then(|entry| entry.get("command")))
            .unwrap_or_else(|| name.clone());
        let description =
            extract_string(input_record.and_then(|entry| entry.get("description"))).unwrap_or_default();
        return Some((
            tool_use_id.clone(),
            json!({
                "id": tool_use_id,
                "type": "commandExecution",
                "command": [command],
                "cwd": extract_string(record.get("cwd")).unwrap_or_default(),
                "status": "running",
                "aggregatedOutput": "",
                "timestamp": timestamp,
                "detail": description,
                "model": model,
            }),
        ));
    }
    Some((
        tool_use_id.clone(),
        json!({
            "id": tool_use_id,
            "type": "mcpToolCall",
            "server": "Claude",
            "tool": name,
            "arguments": input,
            "status": "running",
            "result": "",
            "timestamp": timestamp,
            "model": model,
        }),
    ))
}

fn build_user_message_item(
    line_index: usize,
    record: &Map<String, Value>,
    timestamp: &str,
) -> Option<Value> {
    let message = record.get("message")?.as_object()?;
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return None;
    }
    let parts = string_content_parts(message.get("content")?);
    let text_parts = parts
        .iter()
        .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|entry| extract_string(entry.get("text")))
        .collect::<Vec<_>>();
    if text_parts.is_empty() {
        return None;
    }
    Some(json!({
        "id": format!("claude-user-{line_index}"),
        "type": "userMessage",
        "content": text_parts
            .into_iter()
            .map(|text| json!({ "type": "text", "text": text }))
            .collect::<Vec<_>>(),
        "timestamp": timestamp,
    }))
}

fn parse_assistant_line(
    line_index: usize,
    record: &Map<String, Value>,
    timestamp: &str,
    turns: &mut Vec<Value>,
    tool_positions: &mut HashMap<String, (usize, usize)>,
    latest_model: &mut Option<String>,
) {
    let Some(message) = record.get("message").and_then(Value::as_object) else {
        return;
    };
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return;
    }
    let model = extract_string(message.get("model"));
    if model.is_some() {
        *latest_model = model.clone();
    }

    let mut items = Vec::new();
    for (content_index, content) in assistant_content_parts(message).into_iter().enumerate() {
        let Some(content_type) = extract_string(content.get("type")) else {
            continue;
        };
        match content_type.as_str() {
            "thinking" => {
                let text = extract_string(content.get("thinking")).unwrap_or_default();
                if text.is_empty() {
                    continue;
                }
                items.push(json!({
                    "id": format!("claude-thinking-{line_index}-{content_index}"),
                    "type": "reasoning",
                    "summary": "",
                    "content": text,
                    "timestamp": timestamp,
                    "model": model,
                }));
            }
            "text" => {
                let text = extract_string(content.get("text")).unwrap_or_default();
                if text.is_empty() {
                    continue;
                }
                items.push(json!({
                    "id": format!("claude-agent-{line_index}-{content_index}"),
                    "type": "agentMessage",
                    "text": text,
                    "timestamp": timestamp,
                    "model": model,
                }));
            }
            "tool_use" => {
                if let Some((tool_use_id, item)) =
                    build_tool_item(content_index, record, &content, timestamp, model.as_deref())
                {
                    let item_index = items.len();
                    items.push(item);
                    tool_positions.insert(tool_use_id, (turns.len(), item_index));
                }
            }
            _ => {}
        }
    }

    if !items.is_empty() {
        turns.push(build_claude_turn(
            format!("claude-turn-{line_index}"),
            timestamp,
            items,
        ));
    }
}

fn parse_user_tool_results(
    record: &Map<String, Value>,
    turns: &mut [Value],
    tool_positions: &HashMap<String, (usize, usize)>,
) {
    let Some(message) = record.get("message").and_then(Value::as_object) else {
        return;
    };
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return;
    }
    let Some(parts) = message.get("content").and_then(Value::as_array) else {
        return;
    };
    for part in parts {
        let Some(content) = part.as_object() else {
            continue;
        };
        if content.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        let Some(tool_use_id) = extract_string(content.get("tool_use_id")) else {
            continue;
        };
        let is_error = content
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let output = item_output_for_result(content);
        mark_tool_result(
            turns,
            tool_positions,
            tool_use_id.as_str(),
            if is_error { "error" } else { "completed" },
            output.as_str(),
        );
    }
}

fn parse_progress_line(
    record: &Map<String, Value>,
    turns: &mut [Value],
    tool_positions: &HashMap<String, (usize, usize)>,
) {
    let Some(parent_tool_use_id) = extract_string(record.get("parentToolUseID")) else {
        return;
    };
    let Some(data) = record.get("data").and_then(Value::as_object) else {
        return;
    };
    let output = extract_string(data.get("output"))
        .or_else(|| extract_string(data.get("fullOutput")))
        .unwrap_or_default();
    if output.is_empty() {
        return;
    }
    mark_tool_result(
        turns,
        tool_positions,
        parent_tool_use_id.as_str(),
        "running",
        output.as_str(),
    );
}

fn build_claude_thread_detail(session: &ClaudeSessionSummary) -> Result<Value, String> {
    let records = collect_session_records(&session.full_path);
    if records.is_empty() {
        return Err(format!(
            "Failed to read Claude session {}.",
            session.full_path.display()
        ));
    }
    let mut turns = Vec::new();
    let mut tool_positions: HashMap<String, (usize, usize)> = HashMap::new();
    let mut latest_model: Option<String> = None;

    for (line_index, record) in records.iter().enumerate() {
        let timestamp = extract_string(record.get("timestamp")).unwrap_or_default();
        match extract_string(record.get("type")).as_deref() {
            Some("assistant") => parse_assistant_line(
                line_index,
                record,
                timestamp.as_str(),
                &mut turns,
                &mut tool_positions,
                &mut latest_model,
            ),
            Some("user") => {
                parse_user_tool_results(record, &mut turns, &tool_positions);
                if let Some(item) = build_user_message_item(line_index, record, timestamp.as_str()) {
                    turns.push(build_claude_turn(
                        format!("claude-turn-{line_index}"),
                        timestamp.as_str(),
                        vec![item],
                    ));
                }
            }
            Some("progress") => parse_progress_line(record, &mut turns, &tool_positions),
            _ => {}
        }
    }

    let mut thread = build_claude_thread_stub(session);
    if let Some(thread_record) = thread.as_object_mut() {
        thread_record.insert("turns".to_string(), Value::Array(turns));
        if let Some(model) = latest_model {
            thread_record.insert("model".to_string(), Value::String(model));
        }
    }
    Ok(thread)
}

pub(crate) fn find_claude_session_by_thread_id(thread_id: &str) -> Option<ClaudeSessionSummary> {
    discover_claude_sessions()
        .into_iter()
        .find(|session| session.thread_id == thread_id.trim())
}

pub(crate) fn build_claude_thread_response(thread_id: &str) -> Result<Value, String> {
    let Some(session) = find_claude_session_by_thread_id(thread_id) else {
        return Err("Claude session not found.".to_string());
    };
    let thread = build_claude_thread_detail(&session)?;
    Ok(json!({
        "result": {
            "thread": thread
        }
    }))
}

pub(crate) fn append_claude_threads_to_response(value: &mut Value, workspace_roots: &[String]) {
    if workspace_roots.is_empty() {
        return;
    }
    let sessions = discover_claude_sessions();
    if sessions.is_empty() {
        return;
    }
    let Some(root) = value.as_object_mut() else {
        return;
    };
    if !root.contains_key("result") {
        root.insert("result".to_string(), json!({}));
    }
    let Some(result) = root.get_mut("result").and_then(Value::as_object_mut) else {
        return;
    };
    if !result.contains_key("data") {
        result.insert("data".to_string(), Value::Array(Vec::new()));
    }
    let Some(data) = result.get_mut("data").and_then(Value::as_array_mut) else {
        return;
    };
    let existing_ids = data
        .iter()
        .filter_map(|entry| entry.get("id").and_then(Value::as_str))
        .map(ToOwned::to_owned)
        .collect::<std::collections::HashSet<_>>();
    for session in sessions {
        if !session_matches_any_root(&session, workspace_roots) {
            continue;
        }
        if existing_ids.contains(session.thread_id.as_str()) {
            continue;
        }
        data.push(build_claude_thread_stub(&session));
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_claude_thread_stub, discover_claude_sessions_in_project_dir, is_claude_thread_id,
        ClaudeSessionSummary,
    };
    use std::path::PathBuf;
    use std::{fs, time::{SystemTime, UNIX_EPOCH}};

    fn summary() -> ClaudeSessionSummary {
        ClaudeSessionSummary {
            session_id: "session-1".to_string(),
            thread_id: "claude:session-1".to_string(),
            full_path: PathBuf::from("/tmp/session-1.jsonl"),
            cwd: "/tmp/project".to_string(),
            original_path: "/tmp/project".to_string(),
            first_prompt: "Investigate flaky CI failures".to_string(),
            created: Some("2026-05-01T00:00:00Z".to_string()),
            modified: Some("2026-05-01T00:10:00Z".to_string()),
            git_branch: Some("main".to_string()),
            is_sidechain: false,
        }
    }

    #[test]
    fn claude_thread_ids_use_prefix() {
        assert!(is_claude_thread_id("claude:123"));
        assert!(!is_claude_thread_id("thread-123"));
    }

    #[test]
    fn thread_stub_marks_provider() {
        let thread = build_claude_thread_stub(&summary());
        assert_eq!(thread["provider"], "claude");
        assert_eq!(thread["id"], "claude:session-1");
        assert_eq!(thread["cwd"], "/tmp/project");
    }

    #[test]
    fn discovers_jsonl_sessions_when_index_is_stale() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let project_dir = std::env::temp_dir().join(format!("claude-core-test-{unique}"));
        fs::create_dir_all(&project_dir).expect("create project dir");

        fs::write(
            project_dir.join("sessions-index.json"),
            r#"{
              "originalPath": "/Users/adamruehle/Development/mcp-testing",
              "entries": [
                {
                  "sessionId": "stale-session",
                  "fullPath": "/tmp/missing-session.jsonl",
                  "projectPath": "/Users/adamruehle/Development/mcp-testing"
                }
              ]
            }"#,
        )
        .expect("write index");

        fs::write(
            project_dir.join("real-session.jsonl"),
            r#"{"type":"user","sessionId":"real-session","cwd":"/Users/adamruehle/Development/mcp-testing","gitBranch":"HEAD","timestamp":"2026-04-16T09:59:40.091Z","isSidechain":false,"message":{"role":"user","content":"Can you spawn a codex subagent?"}}"#,
        )
        .expect("write jsonl");

        let sessions = discover_claude_sessions_in_project_dir(&project_dir);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "real-session");
        assert_eq!(sessions[0].cwd, "/Users/adamruehle/Development/mcp-testing");
        assert_eq!(sessions[0].first_prompt, "Can you spawn a codex subagent?");

        let _ = fs::remove_dir_all(project_dir);
    }

    #[test]
    fn ignores_sidechain_only_session_directories() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let project_dir = std::env::temp_dir().join(format!("claude-core-subagent-test-{unique}"));
        let nested_dir = project_dir.join("missing-main-session").join("subagents");
        fs::create_dir_all(&nested_dir).expect("create nested dir");

        fs::write(
            project_dir.join("sessions-index.json"),
            r#"{
              "originalPath": "/Users/adamruehle/Development/mcp-testing",
              "entries": [
                {
                  "sessionId": "missing-main-session",
                  "fullPath": "/tmp/missing-main-session.jsonl",
                  "projectPath": "/Users/adamruehle/Development/mcp-testing"
                }
              ]
            }"#,
        )
        .expect("write index");

        fs::write(
            nested_dir.join("agent-acompact.jsonl"),
            r#"{"type":"user","sessionId":"missing-main-session","cwd":"/Users/adamruehle/Development/mcp-testing","gitBranch":"HEAD","timestamp":"2026-02-03T23:06:10.568Z","isSidechain":true,"message":{"role":"user","content":"compact this thread"}} "#,
        )
        .expect("write nested jsonl");

        let sessions = discover_claude_sessions_in_project_dir(&project_dir);
        assert!(sessions.is_empty());

        let _ = fs::remove_dir_all(project_dir);
    }
}
