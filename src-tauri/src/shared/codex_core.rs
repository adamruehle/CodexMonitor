use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::DateTime;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::oneshot::error::TryRecvError;
use tokio::sync::{oneshot, Mutex};
use tokio::time::timeout;
use tokio::time::Instant;

use crate::backend::app_server::WorkspaceSession;
use crate::codex::config as codex_config;
use crate::codex::home::{resolve_default_codex_home, resolve_workspace_codex_home};
use crate::rules;
use crate::shared::account::{build_account_response, read_auth_account};
use crate::types::WorkspaceEntry;

const LOGIN_START_TIMEOUT: Duration = Duration::from_secs(30);
#[allow(dead_code)]
const MAX_INLINE_IMAGE_BYTES: u64 = 50 * 1024 * 1024;
const THREAD_LIST_SOURCE_KINDS: &[&str] = &[
    "cli",
    "vscode",
    "appServer",
    "subAgentReview",
    "subAgentCompact",
    "subAgentThreadSpawn",
    "unknown",
];

fn load_codex_session_title_index() -> HashMap<String, String> {
    let Some(codex_home) = resolve_default_codex_home() else {
        return HashMap::new();
    };
    let path = codex_home.join("session_index.jsonl");
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(_) => return HashMap::new(),
    };

    let mut titles = HashMap::new();
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else {
            continue;
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let Some(id) = value.get("id").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        if id.is_empty() {
            continue;
        }
        let Some(thread_name) = value
            .get("thread_name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
        else {
            continue;
        };
        titles.insert(id.to_string(), thread_name.to_string());
    }

    titles
}

fn apply_session_title_to_thread(
    thread: &mut Map<String, Value>,
    titles: &HashMap<String, String>,
) {
    let Some(thread_id) = thread
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
    else {
        return;
    };
    let Some(title) = titles.get(thread_id) else {
        return;
    };
    thread.insert("title".to_string(), Value::String(title.clone()));
}

fn enrich_thread_response_titles(value: &mut Value, titles: &HashMap<String, String>) {
    let Some(obj) = value.as_object_mut() else {
        return;
    };

    if let Some(result) = obj.get_mut("result").and_then(Value::as_object_mut) {
        if let Some(thread) = result.get_mut("thread").and_then(Value::as_object_mut) {
            apply_session_title_to_thread(thread, titles);
        }
        if let Some(threads) = result.get_mut("threads").and_then(Value::as_array_mut) {
            for thread in threads {
                if let Some(thread_obj) = thread.as_object_mut() {
                    apply_session_title_to_thread(thread_obj, titles);
                }
            }
        }
        if let Some(threads) = result.get_mut("data").and_then(Value::as_array_mut) {
            for thread in threads {
                if let Some(thread_obj) = thread.as_object_mut() {
                    apply_session_title_to_thread(thread_obj, titles);
                }
            }
        }
    }

    if let Some(thread) = obj.get_mut("thread").and_then(Value::as_object_mut) {
        apply_session_title_to_thread(thread, titles);
    }
    if let Some(threads) = obj.get_mut("threads").and_then(Value::as_array_mut) {
        for thread in threads {
            if let Some(thread_obj) = thread.as_object_mut() {
                apply_session_title_to_thread(thread_obj, titles);
            }
        }
    }
}

#[derive(Clone, Debug)]
struct PendingReplayToolCall {
    call_id: String,
    turn_id: String,
    name: String,
    arguments: Value,
    order: usize,
}

#[derive(Clone, Debug)]
struct ReplayedThreadItem {
    item: Value,
    order: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
enum ReplayTimelineMarkerKind {
    UserMessage,
    AgentMessage,
    Reasoning,
}

#[derive(Clone, Debug)]
enum ReplayTimelineEntry {
    ExistingMarker {
        kind: ReplayTimelineMarkerKind,
        order: usize,
    },
    ExistingItemId {
        item_id: String,
        order: usize,
    },
    ReplayedItem(ReplayedThreadItem),
}

#[derive(Clone, Debug)]
struct ReplayedMessage {
    role: ReplayTimelineMarkerKind,
    text: String,
    phase: Option<String>,
    timestamp_ms: Option<i64>,
    order: usize,
}

#[derive(Clone, Debug, Default)]
struct ReplayedTurnData {
    timeline: Vec<ReplayTimelineEntry>,
    messages: Vec<ReplayedMessage>,
}

#[derive(Clone, Debug)]
struct ReplayedCommandSession {
    turn_id: String,
    item_id: String,
    command: String,
    cwd: String,
    output: String,
    status: String,
    order: usize,
}

fn enrich_thread_response_replay(value: &mut Value) {
    let Some(obj) = value.as_object_mut() else {
        return;
    };

    if let Some(result) = obj.get_mut("result").and_then(Value::as_object_mut) {
        if let Some(thread) = result.get_mut("thread").and_then(Value::as_object_mut) {
            enrich_thread_replay_items(thread);
        }
    }

    if let Some(thread) = obj.get_mut("thread").and_then(Value::as_object_mut) {
        enrich_thread_replay_items(thread);
    }
}

fn enrich_thread_replay_items(thread: &mut Map<String, Value>) {
    let Some(path) = thread
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(|path| path.to_string())
    else {
        return;
    };
    let Some(turns) = thread.get_mut("turns").and_then(Value::as_array_mut) else {
        return;
    };

    let replayed_by_turn = load_replayed_thread_items(Path::new(&path));
    if replayed_by_turn.is_empty() {
        return;
    }

    for turn in turns {
        let Some(turn_obj) = turn.as_object_mut() else {
            continue;
        };
        let Some(turn_id) = turn_obj
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        let Some(replayed_turn) = replayed_by_turn.get(turn_id).cloned() else {
            continue;
        };
        if replayed_turn.timeline.is_empty() {
            continue;
        }

        let items = turn_obj
            .entry("items".to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
        let Some(items_array) = items.as_array_mut() else {
            continue;
        };
        let merged_items = merge_replayed_turn_items(
            items_array,
            &replayed_turn.timeline,
            &replayed_turn.messages,
        );
        *items_array = merged_items;
    }
}

fn load_replayed_thread_items(path: &Path) -> HashMap<String, ReplayedTurnData> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return HashMap::new(),
    };

    let mut current_turn_id: Option<String> = None;
    let mut order = 0usize;
    let mut pending_calls: HashMap<String, PendingReplayToolCall> = HashMap::new();
    let mut replayed_by_turn: HashMap<String, ReplayedTurnData> = HashMap::new();
    let mut command_sessions: HashMap<String, ReplayedCommandSession> = HashMap::new();

    for line in BufReader::new(file).lines() {
        let Ok(line) = line else {
            continue;
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };

        if let Some(turn_id) = extract_replay_turn_id(&value) {
            current_turn_id = Some(turn_id);
        }

        let entry_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        if entry_type != "response_item" {
            continue;
        }

        let Some(payload) = value.get("payload").and_then(Value::as_object) else {
            continue;
        };
        let payload_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
        match payload_type {
            "function_call" => {
                let Some(call_id) = payload
                    .get("call_id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|call_id| !call_id.is_empty())
                else {
                    continue;
                };
                let Some(turn_id) = current_turn_id.clone() else {
                    continue;
                };
                let name = payload
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or("")
                    .to_string();
                let arguments = parse_replay_arguments(payload.get("arguments"));
                pending_calls.insert(
                    call_id.to_string(),
                    PendingReplayToolCall {
                        call_id: call_id.to_string(),
                        turn_id,
                        name,
                        arguments,
                        order,
                    },
                );
                order += 1;
            }
            "function_call_output" => {
                let Some(call_id) = payload
                    .get("call_id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|call_id| !call_id.is_empty())
                else {
                    continue;
                };
                let Some(pending) = pending_calls.remove(call_id) else {
                    continue;
                };
                let raw_output = payload
                    .get("output")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                replay_function_call_output(
                    pending,
                    &raw_output,
                    &mut replayed_by_turn,
                    &mut command_sessions,
                );
                order += 1;
            }
            "message" => {
                let Some(turn_id) = current_turn_id.clone() else {
                    continue;
                };
                let role = payload
                    .get("role")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or("");
                let Some(kind) = (match role {
                    "user" => Some(ReplayTimelineMarkerKind::UserMessage),
                    "assistant" => Some(ReplayTimelineMarkerKind::AgentMessage),
                    _ => None,
                }) else {
                    continue;
                };
                let turn_data = replayed_by_turn.entry(turn_id).or_default();
                let text = extract_replay_message_text(payload, kind);
                if !text.is_empty() {
                    turn_data.messages.push(ReplayedMessage {
                        role: kind,
                        text,
                        phase: extract_replay_message_phase(payload),
                        timestamp_ms: read_replay_timestamp_ms(&value),
                        order,
                    });
                }
                turn_data
                    .timeline
                    .push(ReplayTimelineEntry::ExistingMarker { kind, order });
                order += 1;
            }
            "reasoning" => {
                let Some(turn_id) = current_turn_id.clone() else {
                    continue;
                };
                replayed_by_turn.entry(turn_id).or_default().timeline.push(
                    ReplayTimelineEntry::ExistingMarker {
                        kind: ReplayTimelineMarkerKind::Reasoning,
                        order,
                    },
                );
                order += 1;
            }
            _ => {
                let Some(turn_id) = current_turn_id.clone() else {
                    continue;
                };
                let Some(item_id) = payload
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|item_id| !item_id.is_empty())
                else {
                    continue;
                };
                replayed_by_turn.entry(turn_id).or_default().timeline.push(
                    ReplayTimelineEntry::ExistingItemId {
                        item_id: item_id.to_string(),
                        order,
                    },
                );
                order += 1;
            }
        }
    }

    for session in command_sessions.into_values() {
        replayed_by_turn
            .entry(session.turn_id.clone())
            .or_default()
            .timeline
            .push(ReplayTimelineEntry::ReplayedItem(ReplayedThreadItem {
                item: build_replayed_command_item(&session),
                order: session.order,
            }));
    }

    for turn_data in replayed_by_turn.values_mut() {
        turn_data.timeline.sort_by_key(replay_timeline_entry_order);
    }

    replayed_by_turn
}

fn replay_timeline_entry_order(entry: &ReplayTimelineEntry) -> usize {
    match entry {
        ReplayTimelineEntry::ExistingMarker { order, .. }
        | ReplayTimelineEntry::ExistingItemId { order, .. } => *order,
        ReplayTimelineEntry::ReplayedItem(item) => item.order,
    }
}

fn classify_existing_turn_item(item: &Value) -> Option<ReplayTimelineMarkerKind> {
    match item.get("type").and_then(Value::as_str).unwrap_or("") {
        "userMessage" => Some(ReplayTimelineMarkerKind::UserMessage),
        "agentMessage" => Some(ReplayTimelineMarkerKind::AgentMessage),
        "message" => match item.get("role").and_then(Value::as_str).unwrap_or("") {
            "user" => Some(ReplayTimelineMarkerKind::UserMessage),
            "assistant" => Some(ReplayTimelineMarkerKind::AgentMessage),
            _ => None,
        },
        "reasoning" => Some(ReplayTimelineMarkerKind::Reasoning),
        _ => None,
    }
}

fn next_unemitted_kind_index(queue: &mut VecDeque<usize>, emitted: &[bool]) -> Option<usize> {
    while let Some(index) = queue.pop_front() {
        if !emitted.get(index).copied().unwrap_or(false) {
            return Some(index);
        }
    }
    None
}

fn merge_replayed_turn_items(
    items_array: &[Value],
    timeline: &[ReplayTimelineEntry],
    messages: &[ReplayedMessage],
) -> Vec<Value> {
    let existing_items = items_array.to_vec();
    let existing_ids: HashMap<String, usize> = existing_items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            item.get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(|id| (id.to_string(), index))
        })
        .collect();

    let mut by_kind: HashMap<ReplayTimelineMarkerKind, VecDeque<usize>> = HashMap::new();
    for (index, item) in existing_items.iter().enumerate() {
        if let Some(kind) = classify_existing_turn_item(item) {
            by_kind.entry(kind).or_default().push_back(index);
        }
    }

    let mut emitted = vec![false; existing_items.len()];
    let mut merged: Vec<Value> = Vec::new();

    for entry in timeline {
        match entry {
            ReplayTimelineEntry::ExistingItemId { item_id, .. } => {
                let Some(index) = existing_ids.get(item_id).copied() else {
                    continue;
                };
                if emitted[index] {
                    continue;
                }
                emitted[index] = true;
                merged.push(existing_items[index].clone());
            }
            ReplayTimelineEntry::ExistingMarker { kind, order } => {
                if let Some(index) = by_kind
                    .get_mut(kind)
                    .and_then(|queue| next_unemitted_kind_index(queue, &emitted))
                {
                    emitted[index] = true;
                    let matched_message = messages
                        .iter()
                        .find(|message| message.role == *kind && message.order == *order);
                    merged.push(match matched_message {
                        Some(message) => {
                            merge_replayed_message_metadata(&existing_items[index], message)
                        }
                        None => existing_items[index].clone(),
                    });
                    continue;
                }
                if let Some(message) = messages
                    .iter()
                    .find(|message| message.role == *kind && message.order == *order)
                {
                    merged.push(build_replayed_message_item(message));
                }
            }
            ReplayTimelineEntry::ReplayedItem(replayed) => {
                let item_id = replayed
                    .item
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or("");
                if let Some(index) = existing_ids.get(item_id).copied() {
                    if emitted[index] {
                        continue;
                    }
                    emitted[index] = true;
                    merged.push(merge_replayed_item(&existing_items[index], &replayed.item));
                    continue;
                }
                merged.push(replayed.item.clone());
            }
        }
    }

    for (index, item) in existing_items.into_iter().enumerate() {
        if emitted[index] {
            continue;
        }
        merged.push(item);
    }

    merged
}

fn merge_replayed_message_metadata(existing: &Value, message: &ReplayedMessage) -> Value {
    let mut merged = existing.clone();
    let Some(object) = merged.as_object_mut() else {
        return merged;
    };
    if let Some(timestamp_ms) = message.timestamp_ms {
        if !object.contains_key("timestampMs") && !object.contains_key("timestamp_ms") {
            object.insert("timestampMs".to_string(), json!(timestamp_ms));
        }
    }
    if message.role == ReplayTimelineMarkerKind::AgentMessage {
        if let Some(phase) = &message.phase {
            object.insert("phase".to_string(), json!(phase));
        }
    }
    merged
}

fn merge_replayed_item(existing: &Value, replayed: &Value) -> Value {
    let Some(existing_obj) = existing.as_object() else {
        return replayed.clone();
    };
    let Some(replayed_obj) = replayed.as_object() else {
        return replayed.clone();
    };

    let mut merged = existing_obj.clone();
    for (key, value) in replayed_obj {
        merged.insert(key.clone(), value.clone());
    }
    Value::Object(merged)
}

fn read_replay_timestamp_ms(value: &Value) -> Option<i64> {
    value
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
        .map(|timestamp| timestamp.timestamp_millis())
}

fn extract_replay_message_phase(payload: &Map<String, Value>) -> Option<String> {
    payload
        .get("phase")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|phase| !phase.is_empty())
        .map(|phase| phase.to_string())
}

fn extract_replay_message_text(
    payload: &Map<String, Value>,
    role: ReplayTimelineMarkerKind,
) -> String {
    let Some(content) = payload.get("content").and_then(Value::as_array) else {
        return String::new();
    };

    content
        .iter()
        .filter_map(|entry| {
            let entry = entry.as_object()?;
            let entry_type = entry.get("type").and_then(Value::as_str).unwrap_or("");
            let text = entry
                .get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())?;
            match role {
                ReplayTimelineMarkerKind::UserMessage
                    if matches!(entry_type, "input_text" | "text") =>
                {
                    Some(text.to_string())
                }
                ReplayTimelineMarkerKind::AgentMessage
                    if matches!(entry_type, "output_text" | "text") =>
                {
                    Some(text.to_string())
                }
                _ => None,
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn build_replayed_message_item(message: &ReplayedMessage) -> Value {
    match message.role {
        ReplayTimelineMarkerKind::UserMessage => json!({
            "type": "userMessage",
            "id": format!("replay-user-message-{}", message.order),
            "content": [
                {
                    "type": "text",
                    "text": message.text,
                }
            ],
            "timestampMs": message.timestamp_ms,
        }),
        ReplayTimelineMarkerKind::AgentMessage => {
            let mut item = json!({
                "type": "agentMessage",
                "id": format!("replay-agent-message-{}", message.order),
                "text": message.text,
                "timestampMs": message.timestamp_ms,
            });
            if let Some(phase) = &message.phase {
                if let Some(object) = item.as_object_mut() {
                    object.insert("phase".to_string(), json!(phase));
                }
            }
            item
        }
        ReplayTimelineMarkerKind::Reasoning => Value::Null,
    }
}

fn extract_replay_turn_id(value: &Value) -> Option<String> {
    value
        .get("turn_id")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .get("payload")
                .and_then(Value::as_object)
                .and_then(|payload| payload.get("turn_id").or_else(|| payload.get("turnId")))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|turn_id| !turn_id.is_empty())
        .map(|turn_id| turn_id.to_string())
}

fn parse_replay_arguments(raw: Option<&Value>) -> Value {
    match raw {
        Some(Value::String(text)) => serde_json::from_str::<Value>(text).unwrap_or(Value::Null),
        Some(value) => value.clone(),
        None => Value::Null,
    }
}

fn replay_function_call_output(
    pending: PendingReplayToolCall,
    raw_output: &str,
    replayed_by_turn: &mut HashMap<String, ReplayedTurnData>,
    command_sessions: &mut HashMap<String, ReplayedCommandSession>,
) {
    match pending.name.as_str() {
        "exec_command" => {
            replay_exec_command_output(pending, raw_output, replayed_by_turn, command_sessions);
        }
        "write_stdin" => {
            replay_write_stdin_output(pending, raw_output, command_sessions);
        }
        _ => {}
    }
}

fn replay_exec_command_output(
    pending: PendingReplayToolCall,
    raw_output: &str,
    replayed_by_turn: &mut HashMap<String, ReplayedTurnData>,
    command_sessions: &mut HashMap<String, ReplayedCommandSession>,
) {
    let command = pending
        .arguments
        .get("cmd")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let cwd = pending
        .arguments
        .get("workdir")
        .or_else(|| pending.arguments.get("cwd"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let session_id = extract_running_session_id(raw_output);
    let chunk_output = extract_chunk_output(raw_output);
    let status = extract_command_status(raw_output);

    if let Some(session_id) = session_id {
        let entry = command_sessions
            .entry(session_id)
            .or_insert_with(|| ReplayedCommandSession {
                turn_id: pending.turn_id.clone(),
                item_id: pending.call_id.clone(),
                command: command.clone(),
                cwd: cwd.clone(),
                output: String::new(),
                status: "running".to_string(),
                order: pending.order,
            });
        append_command_output(&mut entry.output, &chunk_output);
        if !status.is_empty() {
            entry.status = status;
        }
        return;
    }

    replayed_by_turn
        .entry(pending.turn_id.clone())
        .or_default()
        .timeline
        .push(ReplayTimelineEntry::ReplayedItem(ReplayedThreadItem {
            item: json!({
                "type": "commandExecution",
                "id": pending.call_id,
                "command": command,
                "cwd": cwd,
                "status": if status.is_empty() { "completed" } else { status.as_str() },
                "aggregatedOutput": chunk_output,
            }),
            order: pending.order,
        }));
}

fn replay_write_stdin_output(
    pending: PendingReplayToolCall,
    raw_output: &str,
    command_sessions: &mut HashMap<String, ReplayedCommandSession>,
) {
    let Some(session_id) = pending
        .arguments
        .get("session_id")
        .or_else(|| pending.arguments.get("sessionId"))
        .and_then(|value| {
            value
                .as_i64()
                .map(|number| number.to_string())
                .or_else(|| value.as_str().map(|text| text.trim().to_string()))
        })
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    let Some(entry) = command_sessions.get_mut(&session_id) else {
        return;
    };

    let stdin = pending
        .arguments
        .get("chars")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !stdin.is_empty() {
        append_command_output(
            &mut entry.output,
            &format!(
                "[stdin]\n{}",
                if stdin.ends_with('\n') {
                    stdin.to_string()
                } else {
                    format!("{stdin}\n")
                }
            ),
        );
    }

    let chunk_output = extract_chunk_output(raw_output);
    append_command_output(&mut entry.output, &chunk_output);

    let status = extract_command_status(raw_output);
    if !status.is_empty() {
        entry.status = status;
    }
}

fn build_replayed_command_item(session: &ReplayedCommandSession) -> Value {
    json!({
        "type": "commandExecution",
        "id": session.item_id,
        "command": session.command,
        "cwd": session.cwd,
        "status": session.status,
        "aggregatedOutput": session.output,
    })
}

fn append_command_output(buffer: &mut String, chunk: &str) {
    let trimmed = chunk.trim_end();
    if trimmed.is_empty() {
        return;
    }
    if !buffer.is_empty() {
        buffer.push_str("\n");
    }
    buffer.push_str(trimmed);
}

fn extract_running_session_id(output: &str) -> Option<String> {
    output
        .lines()
        .find_map(|line| line.trim().strip_prefix("Process running with session ID "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn extract_chunk_output(output: &str) -> String {
    output
        .split_once("\nOutput:\n")
        .map(|(_, tail)| tail.to_string())
        .unwrap_or_else(|| output.to_string())
}

fn extract_command_status(output: &str) -> String {
    for line in output.lines() {
        let trimmed = line.trim();
        if let Some(code) = trimmed.strip_prefix("Process exited with code ") {
            return if code.trim() == "0" {
                "completed".to_string()
            } else {
                "failed".to_string()
            };
        }
        if trimmed.starts_with("Process running with session ID ") {
            return "running".to_string();
        }
    }
    String::new()
}

#[allow(dead_code)]
fn image_extension_for_path(path: &str) -> Option<String> {
    Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
}

#[allow(dead_code)]
fn image_mime_type_for_path(path: &str) -> Option<&'static str> {
    let extension = image_extension_for_path(path)?;
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "tiff" | "tif" => Some("image/tiff"),
        _ => None,
    }
}

#[allow(dead_code)]
fn should_inline_image_path_for_codex(path: &str) -> bool {
    matches!(
        image_extension_for_path(path).as_deref(),
        Some("heic") | Some("heif")
    )
}

#[cfg(target_os = "macos")]
fn temp_converted_image_path(path: &str, extension: &str) -> PathBuf {
    let stem = Path::new(path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let safe_stem = stem
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>();
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default();
    std::env::temp_dir().join(format!("codex-monitor-image-{safe_stem}-{ts}.{extension}"))
}

#[cfg(target_os = "macos")]
fn convert_heif_image_to_jpeg_bytes(path: &str) -> Result<Vec<u8>, String> {
    let output_path = temp_converted_image_path(path, "jpg");
    let status = std::process::Command::new("/usr/bin/sips")
        .args(["-s", "format", "jpeg"])
        .arg(path)
        .arg("--out")
        .arg(&output_path)
        .status()
        .map_err(|err| format!("Failed to launch HEIC/HEIF conversion for {path}: {err}"))?;
    if !status.success() {
        let _ = std::fs::remove_file(&output_path);
        return Err(format!(
            "Failed to convert HEIC/HEIF image into a Codex-compatible JPEG: {path}"
        ));
    }
    let bytes = std::fs::read(&output_path).map_err(|err| {
        format!(
            "Failed to read converted JPEG for {path} at {}: {err}",
            output_path.display()
        )
    })?;
    let _ = std::fs::remove_file(&output_path);
    if bytes.is_empty() {
        return Err(format!(
            "Converted JPEG is empty after HEIC/HEIF conversion: {path}"
        ));
    }
    Ok(bytes)
}

#[allow(dead_code)]
pub(crate) fn normalize_file_path(raw: &str) -> String {
    let path = raw.trim();
    let file_uri_path = path
        .strip_prefix("file://localhost")
        .or_else(|| path.strip_prefix("file://"));
    let Some(path) = file_uri_path else {
        return path.to_string();
    };

    let mut decoded = Vec::with_capacity(path.len());
    let bytes = path.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hi = bytes[index + 1];
            let lo = bytes[index + 2];
            let hi_value = match hi {
                b'0'..=b'9' => Some(hi - b'0'),
                b'a'..=b'f' => Some(hi - b'a' + 10),
                b'A'..=b'F' => Some(hi - b'A' + 10),
                _ => None,
            };
            let lo_value = match lo {
                b'0'..=b'9' => Some(lo - b'0'),
                b'a'..=b'f' => Some(lo - b'a' + 10),
                b'A'..=b'F' => Some(lo - b'A' + 10),
                _ => None,
            };
            if let (Some(hi_nibble), Some(lo_nibble)) = (hi_value, lo_value) {
                decoded.push((hi_nibble << 4) | lo_nibble);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

#[allow(dead_code)]
pub(crate) fn read_image_as_data_url_core(path: &str) -> Result<String, String> {
    let trimmed_path = normalize_file_path(path);
    if trimmed_path.is_empty() {
        return Err("Image path is required".to_string());
    }
    if should_inline_image_path_for_codex(&trimmed_path) {
        #[cfg(target_os = "macos")]
        {
            let encoded = STANDARD.encode(convert_heif_image_to_jpeg_bytes(&trimmed_path)?);
            return Ok(format!("data:image/jpeg;base64,{encoded}"));
        }
        #[cfg(not(target_os = "macos"))]
        {
            return Err(format!(
                "HEIC/HEIF images are not supported on this platform; convert to JPEG or PNG first: {trimmed_path}"
            ));
        }
    }
    let mime_type = image_mime_type_for_path(&trimmed_path).ok_or_else(|| {
        format!("Unsupported or missing image extension for path: {trimmed_path}")
    })?;
    let metadata = std::fs::symlink_metadata(&trimmed_path)
        .map_err(|err| format!("Failed to stat image file at {trimmed_path}: {err}"))?;
    if metadata.file_type().is_symlink() {
        return Err(format!("Image path must not be a symlink: {trimmed_path}"));
    }
    if !metadata.is_file() {
        return Err(format!("Image path is not a file: {trimmed_path}"));
    }
    if metadata.len() > MAX_INLINE_IMAGE_BYTES {
        return Err(format!(
            "Image file exceeds maximum size of {MAX_INLINE_IMAGE_BYTES} bytes: {trimmed_path}"
        ));
    }
    let bytes = std::fs::read(&trimmed_path)
        .map_err(|err| format!("Failed to read image file at {trimmed_path}: {err}"))?;
    if bytes.is_empty() {
        return Err(format!("Image file is empty: {trimmed_path}"));
    }
    let encoded = STANDARD.encode(bytes);
    Ok(format!("data:{mime_type};base64,{encoded}"))
}

pub(crate) enum CodexLoginCancelState {
    PendingStart(oneshot::Sender<()>),
    LoginId(String),
}

async fn get_session_clone(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: &str,
) -> Result<Arc<WorkspaceSession>, String> {
    let sessions = sessions.lock().await;
    sessions
        .get(workspace_id)
        .cloned()
        .ok_or_else(|| "workspace not connected".to_string())
}

async fn resolve_workspace_and_parent(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: &str,
) -> Result<(WorkspaceEntry, Option<WorkspaceEntry>), String> {
    let workspaces = workspaces.lock().await;
    let entry = workspaces
        .get(workspace_id)
        .cloned()
        .ok_or_else(|| "workspace not found".to_string())?;
    let parent_entry = entry
        .parent_id
        .as_ref()
        .and_then(|parent_id| workspaces.get(parent_id))
        .cloned();
    Ok((entry, parent_entry))
}

async fn resolve_codex_home_for_workspace_core(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: &str,
) -> Result<PathBuf, String> {
    let (entry, parent_entry) = resolve_workspace_and_parent(workspaces, workspace_id).await?;
    resolve_workspace_codex_home(&entry, parent_entry.as_ref())
        .or_else(resolve_default_codex_home)
        .ok_or_else(|| "Unable to resolve CODEX_HOME".to_string())
}

async fn resolve_workspace_path_core(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: &str,
) -> Result<String, String> {
    let workspaces = workspaces.lock().await;
    let entry = workspaces
        .get(workspace_id)
        .ok_or_else(|| "workspace not found".to_string())?;
    Ok(entry.path.clone())
}

pub(crate) async fn start_thread_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let workspace_path = resolve_workspace_path_core(workspaces, &workspace_id).await?;
    let params = json!({
        "cwd": workspace_path,
        "approvalPolicy": "on-request"
    });
    session
        .send_request_for_workspace(&workspace_id, "thread/start", params)
        .await
}

pub(crate) async fn resume_thread_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "threadId": thread_id });
    let mut response = session
        .send_request_for_workspace(&workspace_id, "thread/resume", params)
        .await?;
    let session_titles = load_codex_session_title_index();
    if !session_titles.is_empty() {
        enrich_thread_response_titles(&mut response, &session_titles);
    }
    enrich_thread_response_replay(&mut response);
    Ok(response)
}

pub(crate) async fn read_thread_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "threadId": thread_id });
    let mut response = session
        .send_request_for_workspace(&workspace_id, "thread/read", params)
        .await?;
    let session_titles = load_codex_session_title_index();
    if !session_titles.is_empty() {
        enrich_thread_response_titles(&mut response, &session_titles);
    }
    enrich_thread_response_replay(&mut response);
    Ok(response)
}

pub(crate) async fn thread_live_subscribe_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
) -> Result<(), String> {
    if thread_id.trim().is_empty() {
        return Err("threadId is required".to_string());
    }
    let _ = get_session_clone(sessions, &workspace_id).await?;
    Ok(())
}

pub(crate) async fn thread_live_unsubscribe_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
) -> Result<(), String> {
    if thread_id.trim().is_empty() {
        return Err("threadId is required".to_string());
    }
    let _ = get_session_clone(sessions, &workspace_id).await?;
    Ok(())
}

pub(crate) async fn fork_thread_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "threadId": thread_id });
    session
        .send_request_for_workspace(&workspace_id, "thread/fork", params)
        .await
}

pub(crate) async fn list_threads_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
    sort_key: Option<String>,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({
        "cursor": cursor,
        "limit": limit,
        "sortKey": sort_key,
        // Keep interactive and sub-agent sessions visible across CLI versions so
        // thread/list refreshes do not drop valid historical conversations.
        // Intentionally exclude generic "subAgent" so parentless internal jobs
        // (for example memory consolidation) do not leak back into app state.
        "sourceKinds": THREAD_LIST_SOURCE_KINDS
    });
    let mut response = session
        .send_request_for_workspace(&workspace_id, "thread/list", params)
        .await?;
    let session_titles = load_codex_session_title_index();
    if !session_titles.is_empty() {
        enrich_thread_response_titles(&mut response, &session_titles);
    }
    Ok(response)
}

pub(crate) async fn list_mcp_server_status_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "cursor": cursor, "limit": limit });
    session
        .send_request_for_workspace(&workspace_id, "mcpServerStatus/list", params)
        .await
}

pub(crate) async fn archive_thread_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "threadId": thread_id });
    session
        .send_request_for_workspace(&workspace_id, "thread/archive", params)
        .await
}

pub(crate) async fn compact_thread_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "threadId": thread_id });
    session
        .send_request_for_workspace(&workspace_id, "thread/compact/start", params)
        .await
}

pub(crate) async fn set_thread_name_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
    name: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "threadId": thread_id, "name": name });
    session
        .send_request_for_workspace(&workspace_id, "thread/name/set", params)
        .await
}

fn build_turn_input_items(
    text: String,
    images: Option<Vec<String>>,
    app_mentions: Option<Vec<Value>>,
) -> Result<Vec<Value>, String> {
    let trimmed_text = text.trim();
    let mut input: Vec<Value> = Vec::new();
    if !trimmed_text.is_empty() {
        input.push(json!({ "type": "text", "text": trimmed_text }));
    }
    if let Some(paths) = images {
        for path in paths {
            let trimmed = path.trim();
            if trimmed.is_empty() {
                continue;
            }
            if trimmed.starts_with("data:")
                || trimmed.starts_with("http://")
                || trimmed.starts_with("https://")
            {
                input.push(json!({ "type": "image", "url": trimmed }));
            } else if should_inline_image_path_for_codex(trimmed) {
                input.push(json!({
                    "type": "image",
                    "url": read_image_as_data_url_core(trimmed)?,
                }));
            } else {
                input.push(json!({ "type": "localImage", "path": trimmed }));
            }
        }
    }
    if let Some(mentions) = app_mentions {
        let mut seen_paths: HashSet<String> = HashSet::new();
        for mention in mentions {
            let object = mention
                .as_object()
                .ok_or_else(|| "invalid app mention payload".to_string())?;
            let name = object
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "invalid app mention name".to_string())?;
            let path = object
                .get("path")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "invalid app mention path".to_string())?;
            if !path.starts_with("app://") || path.len() <= "app://".len() {
                return Err("invalid app mention path".to_string());
            }
            if !seen_paths.insert(path.to_string()) {
                continue;
            }
            input.push(json!({ "type": "mention", "name": name, "path": path }));
        }
    }
    if input.is_empty() {
        return Err("empty user message".to_string());
    }
    Ok(input)
}

pub(crate) fn insert_optional_nullable_string(
    params: &mut Map<String, Value>,
    key: &str,
    value: Option<Option<String>>,
) {
    if let Some(value) = value {
        params.insert(key.to_string(), json!(value));
    }
}

pub(crate) async fn send_user_message_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
    thread_id: String,
    text: String,
    model: Option<String>,
    effort: Option<String>,
    service_tier: Option<Option<String>>,
    access_mode: Option<String>,
    images: Option<Vec<String>>,
    app_mentions: Option<Vec<Value>>,
    collaboration_mode: Option<Value>,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let workspace_path = resolve_workspace_path_core(workspaces, &workspace_id).await?;
    let access_mode = access_mode.unwrap_or_else(|| "current".to_string());
    let sandbox_policy = match access_mode.as_str() {
        "full-access" => json!({ "type": "dangerFullAccess" }),
        "read-only" => json!({ "type": "readOnly" }),
        _ => json!({
            "type": "workspaceWrite",
            "writableRoots": [workspace_path.clone()],
            "networkAccess": true
        }),
    };

    let approval_policy = if access_mode == "full-access" {
        "never"
    } else {
        "on-request"
    };

    let input = build_turn_input_items(text, images, app_mentions)?;

    let mut params = Map::new();
    params.insert("threadId".to_string(), json!(thread_id));
    params.insert("input".to_string(), json!(input));
    params.insert("cwd".to_string(), json!(workspace_path));
    params.insert("approvalPolicy".to_string(), json!(approval_policy));
    params.insert("sandboxPolicy".to_string(), json!(sandbox_policy));
    params.insert("model".to_string(), json!(model));
    params.insert("effort".to_string(), json!(effort));
    insert_optional_nullable_string(&mut params, "serviceTier", service_tier);
    if let Some(mode) = collaboration_mode {
        if !mode.is_null() {
            params.insert("collaborationMode".to_string(), mode);
        }
    }
    session
        .send_request_for_workspace(&workspace_id, "turn/start", Value::Object(params))
        .await
}

pub(crate) async fn turn_steer_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
    turn_id: String,
    text: String,
    images: Option<Vec<String>>,
    app_mentions: Option<Vec<Value>>,
) -> Result<Value, String> {
    if turn_id.trim().is_empty() {
        return Err("missing active turn id".to_string());
    }
    let session = get_session_clone(sessions, &workspace_id).await?;
    let input = build_turn_input_items(text, images, app_mentions)?;
    let params = json!({
        "threadId": thread_id,
        "expectedTurnId": turn_id,
        "input": input
    });
    session
        .send_request_for_workspace(&workspace_id, "turn/steer", params)
        .await
}

pub(crate) async fn collaboration_mode_list_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    session
        .send_request_for_workspace(&workspace_id, "collaborationMode/list", json!({}))
        .await
}

pub(crate) async fn turn_interrupt_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
    turn_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "threadId": thread_id, "turnId": turn_id });
    session
        .send_request_for_workspace(&workspace_id, "turn/interrupt", params)
        .await
}

pub(crate) async fn start_review_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
    target: Value,
    delivery: Option<String>,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let mut params = Map::new();
    params.insert("threadId".to_string(), json!(thread_id));
    params.insert("target".to_string(), target);
    if let Some(delivery) = delivery {
        params.insert("delivery".to_string(), json!(delivery));
    }
    session
        .send_request_for_workspace(&workspace_id, "review/start", Value::Object(params))
        .await
}

pub(crate) async fn model_list_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    session
        .send_request_for_workspace(&workspace_id, "model/list", json!({}))
        .await
}

pub(crate) async fn experimental_feature_list_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "cursor": cursor, "limit": limit });
    session
        .send_request_for_workspace(&workspace_id, "experimentalFeature/list", params)
        .await
}

pub(crate) async fn account_rate_limits_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    session
        .send_request_for_workspace(&workspace_id, "account/rateLimits/read", Value::Null)
        .await
}

pub(crate) async fn account_read_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
) -> Result<Value, String> {
    let session = {
        let sessions = sessions.lock().await;
        sessions.get(&workspace_id).cloned()
    };
    let response = if let Some(session) = session {
        session
            .send_request_for_workspace(&workspace_id, "account/read", Value::Null)
            .await
            .ok()
    } else {
        None
    };

    let (entry, parent_entry) = resolve_workspace_and_parent(workspaces, &workspace_id).await?;
    let codex_home = resolve_workspace_codex_home(&entry, parent_entry.as_ref())
        .or_else(resolve_default_codex_home);
    let fallback = read_auth_account(codex_home);

    Ok(build_account_response(response, fallback))
}

pub(crate) async fn codex_login_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    codex_login_cancels: &Mutex<HashMap<String, CodexLoginCancelState>>,
    workspace_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    {
        let mut cancels = codex_login_cancels.lock().await;
        if let Some(existing) = cancels.remove(&workspace_id) {
            match existing {
                CodexLoginCancelState::PendingStart(tx) => {
                    let _ = tx.send(());
                }
                CodexLoginCancelState::LoginId(_) => {}
            }
        }
        cancels.insert(
            workspace_id.clone(),
            CodexLoginCancelState::PendingStart(cancel_tx),
        );
    }

    let start = Instant::now();
    let mut cancel_rx = cancel_rx;
    let workspace_for_request = workspace_id.clone();
    let mut login_request: Pin<Box<_>> = Box::pin(session.send_request_for_workspace(
        &workspace_for_request,
        "account/login/start",
        json!({ "type": "chatgpt" }),
    ));

    let response = loop {
        match cancel_rx.try_recv() {
            Ok(_) => {
                let mut cancels = codex_login_cancels.lock().await;
                cancels.remove(&workspace_id);
                return Err("Codex login canceled.".to_string());
            }
            Err(TryRecvError::Closed) => {
                let mut cancels = codex_login_cancels.lock().await;
                cancels.remove(&workspace_id);
                return Err("Codex login canceled.".to_string());
            }
            Err(TryRecvError::Empty) => {}
        }

        let elapsed = start.elapsed();
        if elapsed >= LOGIN_START_TIMEOUT {
            let mut cancels = codex_login_cancels.lock().await;
            cancels.remove(&workspace_id);
            return Err("Codex login start timed out.".to_string());
        }

        let tick = Duration::from_millis(150);
        let remaining = LOGIN_START_TIMEOUT.saturating_sub(elapsed);
        let wait_for = remaining.min(tick);

        match timeout(wait_for, &mut login_request).await {
            Ok(result) => break result?,
            Err(_elapsed) => continue,
        }
    };

    let payload = response.get("result").unwrap_or(&response);
    let login_id = payload
        .get("loginId")
        .or_else(|| payload.get("login_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "missing login id in account/login/start response".to_string())?;
    let auth_url = payload
        .get("authUrl")
        .or_else(|| payload.get("auth_url"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "missing auth url in account/login/start response".to_string())?;

    {
        let mut cancels = codex_login_cancels.lock().await;
        cancels.insert(
            workspace_id,
            CodexLoginCancelState::LoginId(login_id.clone()),
        );
    }

    Ok(json!({
        "loginId": login_id,
        "authUrl": auth_url,
        "raw": response,
    }))
}

pub(crate) async fn codex_login_cancel_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    codex_login_cancels: &Mutex<HashMap<String, CodexLoginCancelState>>,
    workspace_id: String,
) -> Result<Value, String> {
    let cancel_state = {
        let mut cancels = codex_login_cancels.lock().await;
        cancels.remove(&workspace_id)
    };

    let Some(cancel_state) = cancel_state else {
        return Ok(json!({ "canceled": false }));
    };

    match cancel_state {
        CodexLoginCancelState::PendingStart(cancel_tx) => {
            let _ = cancel_tx.send(());
            return Ok(json!({
                "canceled": true,
                "status": "canceled",
            }));
        }
        CodexLoginCancelState::LoginId(login_id) => {
            let session = get_session_clone(sessions, &workspace_id).await?;
            let response = session
                .send_request_for_workspace(
                    &workspace_id,
                    "account/login/cancel",
                    json!({
                        "loginId": login_id,
                    }),
                )
                .await?;

            let payload = response.get("result").unwrap_or(&response);
            let status = payload
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let canceled = status.eq_ignore_ascii_case("canceled");

            Ok(json!({
                "canceled": canceled,
                "status": status,
                "raw": response,
            }))
        }
    }
}

pub(crate) async fn skills_list_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let workspace_path = resolve_workspace_path_core(workspaces, &workspace_id).await?;

    // Codex can discover project-scoped skills from `<workspace>/.agents/skills`.
    // Some environments don't surface those reliably in CodexMonitor unless we
    // pass the default project skills path explicitly.
    let mut source_paths: Vec<String> = vec![];
    let project_skills_dir = Path::new(&workspace_path).join(".agents").join("skills");
    if project_skills_dir.is_dir() {
        if let Some(p) = project_skills_dir.to_str() {
            source_paths.push(p.to_string());
        }
    }

    let params = if source_paths.is_empty() {
        json!({ "cwd": workspace_path })
    } else {
        json!({ "cwd": workspace_path, "skillsPaths": source_paths })
    };

    let mut response = session
        .send_request_for_workspace(&workspace_id, "skills/list", params)
        .await?;

    // Attach diagnostics for the UI (non-breaking: keep original response fields).
    if let Value::Object(ref mut obj) = response {
        obj.insert("sourcePaths".to_string(), json!(source_paths));
        obj.insert("sourceErrors".to_string(), json!([]));
    }

    Ok(response)
}

pub(crate) async fn apps_list_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
    thread_id: Option<String>,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "cursor": cursor, "limit": limit, "threadId": thread_id });
    session
        .send_request_for_workspace(&workspace_id, "app/list", params)
        .await
}

pub(crate) async fn respond_to_server_request_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    request_id: Value,
    result: Value,
) -> Result<(), String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    session.send_response(request_id, result).await
}

pub(crate) async fn remember_approval_rule_core(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
    command: Vec<String>,
) -> Result<Value, String> {
    let command = command
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>();
    if command.is_empty() {
        return Err("empty command".to_string());
    }

    let codex_home = resolve_codex_home_for_workspace_core(workspaces, &workspace_id).await?;
    let rules_path = rules::default_rules_path(&codex_home);
    rules::append_prefix_rule(&rules_path, &command)?;

    Ok(json!({
        "ok": true,
        "rulesPath": rules_path,
    }))
}

pub(crate) async fn get_config_model_core(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
) -> Result<Value, String> {
    let codex_home = resolve_codex_home_for_workspace_core(workspaces, &workspace_id).await?;
    let model = codex_config::read_config_model(Some(codex_home))?;
    Ok(json!({ "model": model }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::io::Write;

    #[test]
    fn normalize_strips_file_uri_prefix() {
        assert_eq!(
            normalize_file_path("file:///var/mobile/Containers/Data/photo.jpg"),
            "/var/mobile/Containers/Data/photo.jpg"
        );
    }

    #[test]
    fn normalize_strips_file_localhost_prefix() {
        assert_eq!(
            normalize_file_path("file://localhost/Users/test/image.png"),
            "/Users/test/image.png"
        );
    }

    #[test]
    fn normalize_decodes_percent_encoding() {
        assert_eq!(
            normalize_file_path("file:///var/mobile/path%20with%20spaces/img.jpg"),
            "/var/mobile/path with spaces/img.jpg"
        );
    }

    #[test]
    fn normalize_plain_path_unchanged() {
        assert_eq!(
            normalize_file_path("/var/mobile/Containers/Data/photo.jpg"),
            "/var/mobile/Containers/Data/photo.jpg"
        );
    }

    #[test]
    fn normalize_plain_path_percent_sequences_unchanged() {
        assert_eq!(
            normalize_file_path("/tmp/report%20final.png"),
            "/tmp/report%20final.png"
        );
    }

    #[test]
    fn normalize_trims_whitespace() {
        assert_eq!(normalize_file_path("  /tmp/image.png  "), "/tmp/image.png");
    }

    #[test]
    fn read_image_data_url_core_rejects_file_uri_that_does_not_exist() {
        let result = read_image_as_data_url_core("file:///nonexistent/photo.png");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            !err.contains("file://"),
            "error should reference normalized path, got: {err}"
        );
        assert!(err.contains("/nonexistent/photo.png"));
    }

    #[test]
    fn read_image_data_url_core_succeeds_with_file_uri_for_real_file() {
        let dir = std::env::temp_dir().join("codex_monitor_test");
        std::fs::create_dir_all(&dir).unwrap();
        let img_path = dir.join("test_photo.png");
        let png_bytes: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00,
            0x00, 0x90, 0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08,
            0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC,
            0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        std::fs::write(&img_path, png_bytes).unwrap();

        let file_uri = format!("file://{}", img_path.display());
        let result = read_image_as_data_url_core(&file_uri);
        assert!(
            result.is_ok(),
            "file:// URI for real file should succeed, got: {:?}",
            result.err()
        );
        let data_url = result.unwrap();
        assert!(data_url.starts_with("data:image/png;base64,"));

        let space_dir = dir.join("path with spaces");
        std::fs::create_dir_all(&space_dir).unwrap();
        let space_img = space_dir.join("photo.png");
        std::fs::write(&space_img, png_bytes).unwrap();
        let encoded_uri = format!(
            "file://{}",
            space_img.display().to_string().replace(' ', "%20")
        );
        let result2 = read_image_as_data_url_core(&encoded_uri);
        assert!(
            result2.is_ok(),
            "percent-encoded file:// URI should succeed, got: {:?}",
            result2.err()
        );

        let percent_img = dir.join("report%20final.png");
        std::fs::write(&percent_img, png_bytes).unwrap();
        let plain_percent_path = percent_img.display().to_string();
        let result3 = read_image_as_data_url_core(&plain_percent_path);
        assert!(
            result3.is_ok(),
            "plain filesystem paths with percent sequences should not be decoded, got: {:?}",
            result3.err()
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn heif_paths_are_inlined_for_codex() {
        assert!(should_inline_image_path_for_codex("/tmp/photo.heic"));
        assert!(should_inline_image_path_for_codex("/tmp/photo.HEIF"));
        assert!(!should_inline_image_path_for_codex("/tmp/photo.png"));
    }

    #[test]
    fn insert_optional_nullable_string_omits_missing_and_preserves_null() {
        let mut params = Map::new();

        insert_optional_nullable_string(&mut params, "serviceTier", None);
        assert!(!params.contains_key("serviceTier"));

        insert_optional_nullable_string(&mut params, "serviceTier", Some(None));
        assert_eq!(params.get("serviceTier"), Some(&Value::Null));

        insert_optional_nullable_string(&mut params, "serviceTier", Some(Some("fast".to_string())));
        assert_eq!(params.get("serviceTier"), Some(&json!("fast")));
    }

    #[test]
    fn thread_list_source_kinds_exclude_generic_subagent_and_keep_explicit_variants() {
        assert!(!THREAD_LIST_SOURCE_KINDS.contains(&"subAgent"));
        assert!(THREAD_LIST_SOURCE_KINDS.contains(&"subAgentReview"));
        assert!(THREAD_LIST_SOURCE_KINDS.contains(&"subAgentCompact"));
        assert!(THREAD_LIST_SOURCE_KINDS.contains(&"subAgentThreadSpawn"));
    }

    #[test]
    fn enrich_thread_response_titles_updates_result_data_threads() {
        let mut response = json!({
            "result": {
                "data": [
                    { "id": "thread-1", "preview": "Fallback preview" },
                    { "id": "thread-2", "preview": "Another preview" }
                ]
            }
        });
        let titles = HashMap::from([
            ("thread-1".to_string(), "Saved Thread Title".to_string()),
            ("thread-2".to_string(), "Second Saved Title".to_string()),
        ]);

        enrich_thread_response_titles(&mut response, &titles);

        let data = response["result"]["data"].as_array().unwrap();
        assert_eq!(data[0]["title"], json!("Saved Thread Title"));
        assert_eq!(data[1]["title"], json!("Second Saved Title"));
    }

    fn write_temp_session_file(lines: &[String]) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "codex-monitor-replay-test-{}.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let mut file = File::create(&path).expect("create temp session file");
        for line in lines {
            writeln!(file, "{line}").expect("write temp session line");
        }
        path
    }

    #[test]
    fn enrich_thread_response_replay_restores_long_running_exec_command_output() {
        let session_path = write_temp_session_file(&[
            json!({
                "timestamp": "2026-04-28T23:37:13.079Z",
                "type": "event_msg",
                "payload": {
                    "type": "task_started",
                    "turn_id": "turn-build",
                }
            })
            .to_string(),
            json!({
                "timestamp": "2026-04-28T23:37:13.081Z",
                "type": "turn_context",
                "payload": {
                    "turn_id": "turn-build",
                    "cwd": "/tmp/repo",
                }
            })
            .to_string(),
            json!({
                "timestamp": "2026-04-28T23:37:13.082Z",
                "type": "response_item",
                "payload": {
                    "type": "function_call",
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"npm run tauri:build\",\"workdir\":\"/tmp/repo\"}",
                    "call_id": "call-build"
                }
            })
            .to_string(),
            json!({
                "timestamp": "2026-04-28T23:37:13.083Z",
                "type": "response_item",
                "payload": {
                    "type": "function_call_output",
                    "call_id": "call-build",
                    "output": "Chunk ID: 1\nWall time: 0.0000 seconds\nProcess running with session ID 50686\nOriginal token count: 1\nOutput:\n"
                }
            })
            .to_string(),
            json!({
                "timestamp": "2026-04-28T23:38:35.258Z",
                "type": "response_item",
                "payload": {
                    "type": "function_call",
                    "name": "write_stdin",
                    "arguments": "{\"session_id\":50686,\"chars\":\"\",\"yield_time_ms\":1000}",
                    "call_id": "call-poll-1"
                }
            })
            .to_string(),
            json!({
                "timestamp": "2026-04-28T23:38:40.260Z",
                "type": "response_item",
                "payload": {
                    "type": "function_call_output",
                    "call_id": "call-poll-1",
                    "output": "Chunk ID: 2\nWall time: 5.0017 seconds\nProcess running with session ID 50686\nOriginal token count: 1\nOutput:\nBundling Codex Monitor.app\n"
                }
            })
            .to_string(),
            json!({
                "timestamp": "2026-04-28T23:38:55.644Z",
                "type": "response_item",
                "payload": {
                    "type": "function_call",
                    "name": "write_stdin",
                    "arguments": "{\"session_id\":50686,\"chars\":\"\",\"yield_time_ms\":1000}",
                    "call_id": "call-poll-2"
                }
            })
            .to_string(),
            json!({
                "timestamp": "2026-04-28T23:38:56.057Z",
                "type": "response_item",
                "payload": {
                    "type": "function_call_output",
                    "call_id": "call-poll-2",
                    "output": "Chunk ID: 3\nWall time: 0.0000 seconds\nProcess exited with code 1\nOriginal token count: 1\nOutput:\nFinished bundles\nA public key has been found, but no private key.\n"
                }
            })
            .to_string(),
            json!({
                "timestamp": "2026-04-28T23:39:05.219Z",
                "type": "response_item",
                "payload": {
                    "type": "function_call",
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"ls -lah src-tauri/target/release/bundle/macos\",\"workdir\":\"/tmp/repo\"}",
                    "call_id": "call-ls"
                }
            })
            .to_string(),
            json!({
                "timestamp": "2026-04-28T23:39:05.514Z",
                "type": "response_item",
                "payload": {
                    "type": "function_call_output",
                    "call_id": "call-ls",
                    "output": "Chunk ID: 4\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 1\nOutput:\nCodex Monitor.app\n"
                }
            })
            .to_string(),
        ]);

        let mut response = json!({
            "result": {
                "thread": {
                    "id": "thread-1",
                    "path": session_path,
                    "turns": [
                        {
                            "id": "turn-build",
                            "items": [
                                { "type": "userMessage", "id": "item-user", "content": [{ "type": "text", "text": "can you build it too?" }] },
                                { "type": "agentMessage", "id": "item-agent", "text": "Building now." }
                            ]
                        }
                    ]
                }
            }
        });

        enrich_thread_response_replay(&mut response);

        let items = response["result"]["thread"]["turns"][0]["items"]
            .as_array()
            .unwrap();
        let build = items
            .iter()
            .find(|item| item["id"] == json!("call-build"))
            .expect("replayed build command item");
        assert_eq!(build["type"], json!("commandExecution"));
        assert_eq!(build["command"], json!("npm run tauri:build"));
        assert_eq!(build["status"], json!("failed"));
        let build_output = build["aggregatedOutput"]
            .as_str()
            .expect("build command output");
        assert!(build_output.contains("Bundling Codex Monitor.app"));
        assert!(build_output.contains("A public key has been found, but no private key."));

        let ls_item = items
            .iter()
            .find(|item| item["id"] == json!("call-ls"))
            .expect("replayed ls command item");
        assert_eq!(ls_item["type"], json!("commandExecution"));
        assert_eq!(ls_item["status"], json!("completed"));
        assert_eq!(ls_item["aggregatedOutput"], json!("Codex Monitor.app\n"));

        let _ = std::fs::remove_file(session_path);
    }

    #[test]
    fn enrich_thread_response_replay_preserves_tool_chronology_with_existing_messages() {
        let session_path = write_temp_session_file(&[
            json!({
                "timestamp": "2026-04-28T23:37:13.079Z",
                "type": "response_item",
                "turn_id": "turn-ordered",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": "debug this" }]
                }
            })
            .to_string(),
            json!({
                "timestamp": "2026-04-28T23:37:13.080Z",
                "type": "response_item",
                "turn_id": "turn-ordered",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "Checking the first thing." }]
                }
            })
            .to_string(),
            json!({
                "timestamp": "2026-04-28T23:37:13.081Z",
                "type": "response_item",
                "turn_id": "turn-ordered",
                "payload": {
                    "type": "function_call",
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"sed -n '1,20p' src/foo.ts\",\"workdir\":\"/tmp/repo\"}",
                    "call_id": "call-read"
                }
            })
            .to_string(),
            json!({
                "timestamp": "2026-04-28T23:37:13.082Z",
                "type": "response_item",
                "turn_id": "turn-ordered",
                "payload": {
                    "type": "function_call_output",
                    "call_id": "call-read",
                    "output": "Chunk ID: 1\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 1\nOutput:\nline 1\n"
                }
            })
            .to_string(),
            json!({
                "timestamp": "2026-04-28T23:37:13.083Z",
                "type": "response_item",
                "turn_id": "turn-ordered",
                "payload": {
                    "type": "reasoning",
                    "summary": [],
                    "content": null
                }
            })
            .to_string(),
            json!({
                "timestamp": "2026-04-28T23:37:13.084Z",
                "type": "response_item",
                "turn_id": "turn-ordered",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "Checking the second thing." }]
                }
            })
            .to_string(),
            json!({
                "timestamp": "2026-04-28T23:37:13.085Z",
                "type": "response_item",
                "turn_id": "turn-ordered",
                "payload": {
                    "type": "function_call",
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"rg foo src\",\"workdir\":\"/tmp/repo\"}",
                    "call_id": "call-search"
                }
            })
            .to_string(),
            json!({
                "timestamp": "2026-04-28T23:37:13.086Z",
                "type": "response_item",
                "turn_id": "turn-ordered",
                "payload": {
                    "type": "function_call_output",
                    "call_id": "call-search",
                    "output": "Chunk ID: 2\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 1\nOutput:\nsrc/foo.ts:1:foo\n"
                }
            })
            .to_string(),
        ]);

        let mut response = json!({
            "result": {
                "thread": {
                    "id": "thread-ordered",
                    "path": session_path,
                    "turns": [
                        {
                            "id": "turn-ordered",
                            "items": [
                                { "type": "userMessage", "id": "item-user", "content": [{ "type": "text", "text": "debug this" }] },
                                { "type": "agentMessage", "id": "item-agent-1", "text": "Checking the first thing." },
                                { "type": "reasoning", "id": "item-reasoning", "summary": [], "content": null },
                                { "type": "agentMessage", "id": "item-agent-2", "text": "Checking the second thing." }
                            ]
                        }
                    ]
                }
            }
        });

        enrich_thread_response_replay(&mut response);

        let items = response["result"]["thread"]["turns"][0]["items"]
            .as_array()
            .unwrap();
        let ordered_ids = items
            .iter()
            .filter_map(|item| item.get("id").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert_eq!(
            ordered_ids,
            vec![
                "item-user",
                "item-agent-1",
                "call-read",
                "item-reasoning",
                "item-agent-2",
                "call-search",
            ]
        );

        let _ = std::fs::remove_file(session_path);
    }

    #[test]
    fn enrich_thread_response_replay_replaces_sparse_existing_command_items() {
        let session_path = write_temp_session_file(&[
            json!({
                "timestamp": "2026-04-28T23:37:13.079Z",
                "type": "response_item",
                "turn_id": "turn-command",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "Building now." }]
                }
            })
            .to_string(),
            json!({
                "timestamp": "2026-04-28T23:37:13.080Z",
                "type": "response_item",
                "turn_id": "turn-command",
                "payload": {
                    "type": "function_call",
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"npm run tauri:build\",\"workdir\":\"/tmp/repo\"}",
                    "call_id": "call-build"
                }
            })
            .to_string(),
            json!({
                "timestamp": "2026-04-28T23:37:18.080Z",
                "type": "response_item",
                "turn_id": "turn-command",
                "payload": {
                    "type": "function_call_output",
                    "call_id": "call-build",
                    "output": "Chunk ID: 1\nWall time: 5.0000 seconds\nProcess exited with code 0\nOriginal token count: 1\nOutput:\nBundled successfully\n"
                }
            })
            .to_string(),
        ]);

        let mut response = json!({
            "result": {
                "thread": {
                    "id": "thread-command",
                    "path": session_path,
                    "turns": [
                        {
                            "id": "turn-command",
                            "items": [
                                { "type": "agentMessage", "id": "item-agent", "text": "Building now." },
                                {
                                    "type": "commandExecution",
                                    "id": "call-build",
                                    "command": "npm run tauri:build",
                                    "cwd": "/tmp/repo",
                                    "status": "running",
                                    "aggregatedOutput": ""
                                }
                            ]
                        }
                    ]
                }
            }
        });

        enrich_thread_response_replay(&mut response);

        let items = response["result"]["thread"]["turns"][0]["items"]
            .as_array()
            .unwrap();
        let build = items
            .iter()
            .find(|item| item["id"] == json!("call-build"))
            .expect("merged build command item");
        assert_eq!(build["type"], json!("commandExecution"));
        assert_eq!(build["status"], json!("completed"));
        assert_eq!(build["aggregatedOutput"], json!("Bundled successfully\n"));

        let _ = std::fs::remove_file(session_path);
    }

    #[test]
    fn enrich_thread_response_replay_restores_missing_final_agent_message() {
        let session_path = write_temp_session_file(&[
            json!({
                "timestamp": "2026-04-28T23:37:13.079Z",
                "type": "response_item",
                "turn_id": "turn-final",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": "figure it out" }]
                }
            })
            .to_string(),
            json!({
                "timestamp": "2026-04-28T23:37:13.080Z",
                "type": "response_item",
                "turn_id": "turn-final",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "I’m checking the logs." }]
                }
            })
            .to_string(),
            json!({
                "timestamp": "2026-04-28T23:37:13.081Z",
                "type": "response_item",
                "turn_id": "turn-final",
                "payload": {
                    "type": "function_call",
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"rg missing src\",\"workdir\":\"/tmp/repo\"}",
                    "call_id": "call-investigate"
                }
            })
            .to_string(),
            json!({
                "timestamp": "2026-04-28T23:37:13.082Z",
                "type": "response_item",
                "turn_id": "turn-final",
                "payload": {
                    "type": "function_call_output",
                    "call_id": "call-investigate",
                    "output": "Chunk ID: 1\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 1\nOutput:\nsrc/foo.ts:1:missing\n"
                }
            })
            .to_string(),
            json!({
                "timestamp": "2026-04-28T23:37:13.083Z",
                "type": "response_item",
                "turn_id": "turn-final",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "Final answer visible." }],
                    "phase": "final_answer"
                }
            })
            .to_string(),
        ]);

        let mut response = json!({
            "result": {
                "thread": {
                    "id": "thread-final",
                    "path": session_path,
                    "turns": [
                        {
                            "id": "turn-final",
                            "items": [
                                {
                                    "type": "userMessage",
                                    "id": "item-user",
                                    "content": [{ "type": "text", "text": "figure it out" }]
                                },
                                {
                                    "type": "agentMessage",
                                    "id": "item-agent-1",
                                    "text": "I’m checking the logs."
                                },
                                {
                                    "type": "commandExecution",
                                    "id": "call-investigate",
                                    "command": "rg missing src",
                                    "cwd": "/tmp/repo",
                                    "status": "completed",
                                    "aggregatedOutput": "src/foo.ts:1:missing\n"
                                }
                            ]
                        }
                    ]
                }
            }
        });

        enrich_thread_response_replay(&mut response);

        let items = response["result"]["thread"]["turns"][0]["items"]
            .as_array()
            .unwrap();
        let final_message = items
            .iter()
            .find(|item| item["id"] == json!("replay-agent-message-4"))
            .expect("replayed final assistant message");
        assert_eq!(final_message["type"], json!("agentMessage"));
        assert_eq!(final_message["text"], json!("Final answer visible."));
        assert_eq!(final_message["phase"], json!("final_answer"));

        let ordered_ids = items
            .iter()
            .filter_map(|item| item.get("id").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert_eq!(
            ordered_ids,
            vec![
                "item-user",
                "item-agent-1",
                "call-investigate",
                "replay-agent-message-4",
            ]
        );

        let _ = std::fs::remove_file(session_path);
    }

    #[test]
    fn enrich_thread_response_replay_adds_phase_to_existing_final_agent_message() {
        let session_path = write_temp_session_file(&[
            json!({
                "timestamp": "2026-04-29T17:40:01.000Z",
                "type": "response_item",
                "turn_id": "turn-final",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": "continue" }]
                }
            })
            .to_string(),
            json!({
                "timestamp": "2026-04-29T17:40:02.000Z",
                "type": "response_item",
                "turn_id": "turn-final",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "Done." }],
                    "phase": "final_answer"
                }
            })
            .to_string(),
        ]);

        let mut response = json!({
            "result": {
                "thread": {
                    "id": "thread-final",
                    "path": session_path,
                    "turns": [
                        {
                            "id": "turn-final",
                            "items": [
                                {
                                    "type": "userMessage",
                                    "id": "item-user",
                                    "content": [{ "type": "text", "text": "continue" }]
                                },
                                {
                                    "type": "agentMessage",
                                    "id": "item-agent-final",
                                    "text": "Done."
                                }
                            ]
                        }
                    ]
                }
            }
        });

        enrich_thread_response_replay(&mut response);

        let items = response["result"]["thread"]["turns"][0]["items"]
            .as_array()
            .unwrap();
        let final_message = items
            .iter()
            .find(|item| item["id"] == json!("item-agent-final"))
            .expect("existing final assistant message");
        assert_eq!(final_message["phase"], json!("final_answer"));
        assert_eq!(items.len(), 2);

        let _ = std::fs::remove_file(session_path);
    }
}
