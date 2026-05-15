## [2026-04-28] Preserve live thread items across resume
Context: CodexMonitor thread rehydration and thread history persistence
Signal: Tool calls, hook rows, and other intermediary items disappeared after thread refresh or app relaunch
Root cause: `thread/resume` returns a sparser transcript than the live app-server event stream, and the client was replacing richer local thread items with the resumed snapshot
Fix: Persist recent `itemsByThread` snapshots locally and merge resumed thread items into the local snapshot instead of replacing it
Verification: `npm run typecheck` and focused Vitest coverage for `useThreadActions` and `useThreads` passed after the change
Reuse hint: When a thread UI issue only reproduces after refresh/reopen, compare live event-derived items against `thread/resume` payloads before assuming the renderer is dropping rows

## [2026-04-28] Hydrated threads must not re-collapse raw command rows
Context: CodexMonitor thread resume/read hydration for command-heavy sessions
Signal: After reload, resumed threads still showed fewer visible command rows than the raw session log even after backend replay restored missing `commandExecution` items
Root cause: `prepareThreadItems()` always converted successful read/search/list commands into synthetic `explore` rows, and `setThreadItems` reused that path during hydration, so replayed commands were present but visually collapsed on load
Fix: Add a `summarizeExploration` option to `prepareThreadItems()` and disable it for `setThreadItems` so hydrated threads preserve raw `commandExecution` rows
Verification: Focused Vitest coverage passed for `threadItems` and `useThreadsReducer`, including a hydration regression that asserts resumed read/search commands stay as tool rows
Reuse hint: If transcript rows only disappear after reload, check for client-side normalization/summarization in the hydration reducer, not just missing backend data

## [2026-04-28] Replay merge must replace sparse same-id command placeholders
Context: CodexMonitor backend thread replay for resumed command-heavy sessions
Signal: After reload, some command rows still appeared without the output that live rendering had already shown, even though replay reconstruction recovered that output from the session JSONL
Root cause: `merge_replayed_turn_items()` kept the existing turn item whenever a replayed item shared the same `id`, so sparse `commandExecution` placeholders from the thread snapshot overwrote the richer replayed command item
Fix: Merge same-id replayed items over the existing turn item so replayed fields such as `status` and `aggregatedOutput` win while any extra existing fields are preserved
Verification: Focused Rust coverage passed for `enrich_thread_response_replay_*`, including a regression where an existing `commandExecution` placeholder is upgraded with replayed output
Reuse hint: If a resumed thread shows the right tool row IDs but missing command body/output, inspect backend same-id replay merge before changing frontend rendering

## [2026-04-28] Stopped and no-final turns still need closed work groups
Context: CodexMonitor transcript grouping for live turns and resumed thread rendering
Signal: Stopping a session left `Session stopped.` outside the interrupted work, and some completed runs stayed visually expanded or split into plain commentary plus tool rows
Root cause: The client-added stop marker was injected without the interrupted `turnId`, and completed turn grouping treated the last assistant progress bubble as the final reply even when more tool items followed it
Fix: Attach the synthetic stop message to the active turn with `turnId` and timestamp, and only treat an assistant bubble as the final turn reply when no tool-like items follow it; if a completed turn ends without a true final reply, still render the work as a closed work group when the segment contains actual transcript messages
Verification: `npm run typecheck` and focused Vitest coverage passed for `Messages.test.tsx` and `useThreadMessaging.test.tsx`
Reuse hint: If work groups fail to collapse cleanly, inspect turn identity and final-message selection before changing the expand/collapse state logic

## [2026-04-28] Item events must inherit the active turn when the payload omits turnId
Context: CodexMonitor live transcript grouping for command/tool rows and assistant messages during active turns
Signal: Assistant commentary, final replies, and tool rows could split across different visual groups; in long sessions the final answer could appear only after expanding `Worked for ...`
Root cause: `useThreadItemEvents()` only used payload-level `turnId` for some paths; item/tool events eventually inherited the active turn, but assistant delta/completion actions still dropped that fallback when the app-server omitted `turnId`
Fix: Fall back to `getActiveTurnId(threadId)` for item conversion and assistant delta/completion reducer actions, and preserve existing `turnId`/`timestampMs` in `upsertItem()` when a later update omits them
Verification: Focused Vitest coverage passed for `useThreadItemEvents.test.ts`, `Messages.test.tsx`, `threadItems.test.ts`, and `useThreadMessaging.test.tsx`; `npm run typecheck` passed after the assistant-message fallback fix
Reuse hint: If a live transcript visually splits one turn into commentary + raw tool + final reply, inspect missing `turnId` on both item events and agent-message delta/completion events before touching renderer grouping rules

## [2026-04-29] Persisted malformed thread items need load/save repair
Context: CodexMonitor startup and thread resume for older locally persisted transcripts
Signal: Fresh turns grouped correctly, but older threads reopened from the built app still missed work groups or showed orphaned tool rows until a new resume path rewrote the thread
Root cause: Older `localStorage` snapshots contained tool/work items with `turnId: null`, and resume logic merged those malformed local rows back into the thread so renderer fixes alone could not recover the original work groups
Fix: Add a conservative `repairMissingTurnIds()` pass and run it on `loadThreadItems()` and `saveThreadItems()` so clearly repairable tool/work runs inherit the surrounding explicit turn id without rewriting ambiguous legacy transcripts
Verification: `npm run typecheck` and focused Vitest coverage passed for `threadItems.test.ts`, `threadStorage.test.ts`, and `Messages.test.tsx`
Reuse hint: If old threads stay malformed after a renderer fix, inspect persisted `threadItems` snapshots and repair storage on load/save before changing message grouping again

## [2026-04-29] Resume merge must place stale local turn items by turn structure, not raw timestamps alone
Context: CodexMonitor thread reopen/refresh in dev mode and older resumed transcripts
Signal: A completed turn could still render as only `Worked for ...` with the real final assistant reply missing, even after storage repair and backend replay fixes
Root cause: Resume hydration was still merging against stale in-memory local items, and local-only rows were ordered against remote fallback timestamps from `buildItemsFromThread()`, which can place work rows after or before the wrong message inside the turn
Fix: Repair local items inside `buildResumeHydrationPlan()`, then in `mergeThreadItems()` prefer turn-relative insertion for local-only rows with a `turnId` and only fall back to timestamp ordering when no turn context exists
Verification: Focused Vitest coverage passed for `threadActionHelpers.test.ts`, `threadStorage.test.ts`, `threadItems.test.ts`, and `Messages.test.tsx`
Reuse hint: If a reload-only transcript bug survives storage repair, inspect how local-only rows are merged back into remote turn segments before changing renderer grouping again

## [2026-04-29] Frontend hydration must accept generic thread `message` items
Context: CodexMonitor resumed thread transcript conversion
Signal: Reopened threads could show user messages and work groups but no assistant conclusion bubble, even when backend replay and ordering fixes were in place
Root cause: `buildConversationItemFromThreadItem()` only recognized `userMessage` and `agentMessage`; if a resumed turn item arrived as generic `{ type: "message", role, content }`, the frontend dropped it entirely
Fix: Add generic message conversion in `threadItems.conversion.ts` for both build paths, supporting `input_text` / `output_text` content extraction and user image carry-through
Verification: Focused Vitest coverage passed for `threadItems.test.ts`, `threadActionHelpers.test.ts`, `threadStorage.test.ts`, and `Messages.test.tsx`
Reuse hint: If resumed turns lose message bubbles but keep tool rows, inspect thread-item shape compatibility before changing renderer grouping logic

## [2026-04-29] Turnless snapshots need synthetic turn repair plus metadata-preserving merge
Context: CodexMonitor reload of long-lived threads with old persisted snapshots
Signal: After restart, the UI could show only collapsed `Worked for ...` groups while the final assistant reply vanished, even though the session JSONL still contained that reply
Root cause: Some persisted `threadItems` snapshots had no `turnId` values anywhere, which forced legacy grouping on reload, and `mergeThreadItems()` could keep richer local message text while discarding remote `turnId` / `timestampMs` metadata
Fix: Extend `repairMissingTurnIds()` to synthesize stable turn ids from conversation boundaries for fully turnless snapshots, and make `mergeThreadItems()` preserve remote turn/timestamp metadata even when the local item wins on text richness
Verification: `npm run test -- src/utils/threadItems.test.ts src/features/threads/utils/threadStorage.test.ts src/features/messages/components/Messages.test.tsx` and `npm run typecheck`
Reuse hint: If a reopened thread still shows work groups but no trailing reply, inspect whether the persisted snapshot has all-null `turnId` values before changing renderer logic

## [2026-04-29] Trailing bookkeeping should not hide the final assistant bubble
Context: CodexMonitor reload/render of completed work groups in long-lived threads
Signal: A completed turn could still render as only a collapsed `Worked for ...` group after reload, even when the final assistant text existed in the thread
Root cause: `buildTurnEntries()` only treated an assistant message as final when no tool-like items followed it; empty `reasoning` rows and `Context compaction` tools were being treated as real trailing work, so the final assistant stayed trapped inside the collapsed work group
Fix: Treat empty `reasoning` items and `Context compaction` as trailing bookkeeping, fold them into the work group, and still surface the last assistant message as the visible conclusion bubble
Verification: `npm run test -- src/features/messages/components/Messages.test.tsx` and `npm run typecheck`
Reuse hint: If a reloaded thread still loses the last assistant bubble after turn repair, inspect the items immediately after that bubble before changing hydration again

## [2026-04-29] Late item events must not reopen completed turns
Context: CodexMonitor live turn lifecycle and work-group auto-compaction
Signal: The final assistant message was visible, but the chat stayed stuck on `Working...` and the last work group did not collapse after completion
Root cause: `turn/completed` correctly cleared `isProcessing`, but late item/delta events for the already-completed turn could still call `markProcessing(true)` with no later completion event to clear it again
Fix: Track recently settled turn ids in the thread event layer, preserve top-level item event `turnId`/timestamp metadata, and suppress processing restarts for late events that belong to settled turns
Verification: `npm run test -- src/features/threads/hooks/useThreadItemEvents.test.ts src/features/threads/hooks/useThreadTurnEvents.test.tsx src/features/app/hooks/useAppServerEvents.test.tsx` and `npm run typecheck`
Reuse hint: If a final response renders but the UI still says working, inspect event ordering and late item events before changing message grouping logic

## [2026-04-29] Final answers need explicit phase metadata through replay and render
Context: CodexMonitor reopened long-running sessions with collapsed `Worked for` groups
Signal: The final assistant answer existed in the raw session JSONL but only appeared inside the collapsed work group after app reload
Root cause: `phase: "final_answer"` was present in Codex session events, but the app dropped it during app-server event parsing, thread-history conversion, replay reconstruction, and merge/render paths, forcing the renderer to guess which assistant message was the conclusion
Fix: Preserve assistant message `phase` end-to-end and make work-group rendering surface explicit `final_answer` messages outside the collapsed work group
Verification: Focused Vitest coverage passed for message rendering, thread item conversion, app-server events, and thread item events; Rust replay coverage passed for restored final agent messages; `npm run typecheck` and `git diff --check` passed
Reuse hint: If a reopened chat hides a conclusion in `Worked for`, check whether final-answer phase metadata survived before adding more ordering heuristics

## [2026-04-29] Inline agent task checklists should render from TurnPlan, not plan tool rows
Context: CodexMonitor transcript parity with the Codex app for self-assigned task tracking
Signal: The app already stored `turn/plan/updated` progress, but the chat only showed a generic `toolType: "plan"` row while the real checklist lived off to the side
Root cause: The structured `TurnPlan` state and the transcript item stream were treated as separate surfaces, so the message list could not show live checklist completion updates like the Codex app
Fix: Pass `activePlan` into `Messages`, render a dedicated inline checklist entry from `TurnPlan`, auto-scroll it with plan updates, and suppress the duplicate synthetic plan tool row while structured plan state is active
Verification: `npm run test -- src/features/messages/components/Messages.test.tsx`, `npm run typecheck`, and `git diff --check`
Reuse hint: If CodexMonitor needs Codex-app-style task progress, treat `TurnPlan` as the primary render source and use the tool row only as fallback/history

## [2026-05-01] Completed review turns must not keep the composer locked
Context: CodexMonitor composer send path after inline reviews or stale resumed review markers
Signal: A chat could look idle with text and images in the composer, but Enter and the send button did nothing because `isReviewing` stayed true after the turn was no longer processing
Root cause: `markProcessing(false)` preserved `isReviewing`, and resume hydration trusted review markers even when no active turn was present
Fix: Clear `isReviewing` when processing completes, treat resumed review state as valid only while a turn is active, and mask stale review flags from the composer state
Verification: `npm run test`, `npm run typecheck`, `cd src-tauri && cargo check`, and `git diff --check`
Reuse hint: If sending is silently disabled while the UI shows an idle thread, inspect stale `isReviewing` before debugging image upload or the backend `turn/start` path

## [2026-05-01] Dictation state must not block manual chat sends
Context: CodexMonitor composer and workspace-home send controls
Signal: The textarea remained editable with draft text present, but pressing Enter or clicking send did nothing
Root cause: `dictationState !== "idle"` disabled the send button and made Enter return early, so a stale dictation `processing` or `listening` state could brick manual chat sends while leaving typing enabled
Fix: Allow manual text/image sends regardless of dictation busy state; keep dictation controls responsible for canceling or stopping dictation
Verification: `npm run test -- src/features/composer/components/ComposerSend.test.tsx src/features/composer/components/ComposerInput.dictation.test.tsx src/features/workspaces/hooks/useWorkspaceHome.test.tsx`, `npm run test`, `npm run typecheck`, and `git diff --check`
Reuse hint: If the textarea accepts typing but both Enter and the send button are no-ops, inspect button disabled gates like dictation before backend send routing

## [2026-05-01] Composer sends must return explicit results
Context: CodexMonitor composer send pipeline across normal chat, queued sends, steer, and PR composer mode
Signal: A draft could remain in the composer after Enter or send click with no visible explanation when a downstream send path blocked, failed, or returned early
Root cause: Several send paths returned `void`, so the composer could not distinguish success from blocked sends and could not surface the reason to the user
Fix: Propagate `SendMessageResult` through queued send, thread orchestration, PR composer send, and thread messaging; keep drafts on `blocked` / `steer_failed` and render a composer error message
Verification: `npm run typecheck`, `npm run test`, and `git diff --check`
Reuse hint: If sending looks like a no-op, require the entire send chain to return `{ status, message? }` before adding UI workarounds

## [2026-05-01] Persist dev send traces outside the debug panel
Context: CodexMonitor dev-mode send/steer debugging
Signal: The debug panel could miss the decisive send lifecycle because non-alert entries were dropped while the panel was closed, and refresh/restart erased the in-memory trail
Root cause: `useDebugLog()` only retained most entries in React state when the panel was open; no repo-local durable trace existed for composer decisions, RPC responses, or turn lifecycle events
Fix: Add a rolling JSONL dev log at `logs/codex-monitor-dev.jsonl`, persist selected debug entries through a Tauri command, and log composer/queue plus `turn/start`/`turn/steer` outcomes with sanitized payloads
Verification: `npm run typecheck`, `npm run test`, `cd src-tauri && cargo check`, and `git diff --check`
Reuse hint: If CodexMonitor UI state disagrees with the visible transcript, inspect `logs/codex-monitor-dev.jsonl` before guessing whether the backend, composer, or event lifecycle is at fault

## [2026-05-01] Terminal replay events must rehydrate turns as inactive
Context: CodexMonitor reload/resume after a Codex turn ends and the UI rebuilds thread state from JSONL session replay
Signal: Reloaded chats could show the final assistant message or `Session stopped.` while the chat still showed `Working...`, causing later sends or work-group compaction to behave like the turn was still active
Root cause: Session replay handled only part of the terminal `event_msg` surface. It ignored production JSONL `payload.type = "task_complete"` and initially also missed `turn_aborted`, while the live status handler only cleared a narrow set of idle statuses
Fix: Enrich resumed thread turns with terminal status plus completed timestamp from replayed terminal `event_msg` records, mapping `task_complete` to `completed`, `turn_aborted`/`task_interrupted` to `interrupted`, and other terminal task events to inactive states; keep live stopped/interrupted/aborted/completed/error statuses inactive as well
Verification: `npm run test`, `npm run typecheck`, `cd src-tauri && cargo check`, focused `cargo test enrich_thread_response_replay_marks_`, and session replay validation against JSONL files that end with `event_msg.task_complete`
Reuse hint: If a reloaded thread still looks active after the transcript already shows the final answer, inspect the session JSONL for terminal `event_msg` records before trusting sparse `thread/resume` turn status

## [2026-05-01] Prompt history quota errors must not fail successful sends
Context: CodexMonitor composer send path in dev-mode Tauri/WebKit with large local transcript storage
Signal: The Codex turn visibly started and completed, but the composer showed `The quota has been exceeded.` and kept the submitted text in the input
Root cause: `recordHistory()` wrote prompt history to `localStorage` inside the post-success composer path; when WebKit storage was full, the quota exception rejected the successful send continuation and the composer treated it as a send failure
Fix: Make prompt-history persistence best-effort and isolate history recording from the send-success cleanup path so a successful `turn/start` still clears the draft
Verification: `npm run test -- src/features/composer/hooks/usePromptHistory.test.tsx src/features/composer/components/ComposerSend.test.tsx`, `npm run typecheck`, `npm run test`, and `git diff --check`
Reuse hint: If logs show `turn/start result` status `sent` followed by `composer/local cleared draft` and then a quota-looking composer error, inspect local Web Storage writes before blaming Codex API quota

## [2026-05-01] Hung MCP tools can only be recovered at the turn boundary
Context: CodexMonitor app-level recovery for tool calls that never return
Signal: A Codex turn can remain stuck indefinitely while an MCP/tool call is running, with no app-side way to cancel that single tool invocation
Root cause: CodexMonitor only owns the Codex app-server protocol; without Codex/MCP lower-level cancellation support, the safe external control is `turn/interrupt`, not per-tool termination
Fix: Track live tool items from `item/started` and `item/completed`, exempt visible approval/user-input requests, treat bare `waitingOnApproval` without a surfaced request as a stale invisible wait, interrupt stale running turns after the watchdog threshold, and send a continuation prompt only after the interrupted turn settles
Verification: `npm run test -- src/features/threads/hooks/useThreadsReducer.test.ts src/features/threads/hooks/useThreadItemEvents.test.ts src/features/threads/hooks/useThreadTurnEvents.test.tsx src/features/threads/hooks/useToolCallWatchdog.test.tsx`, `npm run typecheck`, live dev log showed `tool/watchdog timeout` with `staleHumanWaitFlags: ["waitingOnApproval"]`, followed by `tool/watchdog interrupt response`, `tool/watchdog auto-continue`, and a successful resumed turn
Reuse hint: If a tool appears hung, do not try to fake per-MCP cancellation from CodexMonitor; track lifecycle events, pause only for visible human requests, interrupt stale invisible waits, then resume cleanly

## [2026-05-04] Pinned thread order should persist separately from pin membership
Context: CodexMonitor sidebar pinned conversations
Signal: Pinned threads needed manual drag reordering that survives app restarts and cross-window storage reloads
Root cause: The original pinned model stored only pin timestamps, so “is pinned” and “display order” were conflated into one value
Fix: Keep pinned membership in `codexmonitor.pinnedThreads`, persist explicit order in `codexmonitor.pinnedThreadOrder`, normalize the order against current pins on load, and only allow drag reordering at the pinned root-group level
Verification: `npm run test -- src/features/threads/utils/threadStorage.test.ts src/features/threads/hooks/useThreadStorage.test.tsx src/features/app/components/PinnedThreadList.test.tsx src/features/app/components/Sidebar.test.tsx`, `npm run typecheck`, and `git diff --check`
Reuse hint: If a sidebar list needs manual user ordering plus durable membership state, store order and inclusion separately instead of overloading timestamps

## [2026-05-05] Claude sessions can be surfaced as read-only threads inside existing workspaces
Context: CodexMonitor multi-provider session browsing
Signal: Claude support was needed without rewriting the app around provider-specific workspaces or live Claude orchestration
Root cause: The existing app model is workspace-centric and Codex-specific, so synthetic Claude workspaces would have forced wide backend/frontend contract changes
Fix: Discover Claude sessions from `~/.claude/projects/*/sessions-index.json`, match them to existing workspaces by path prefix, synthesize Codex-like thread/list and thread/read payloads in shared Rust cores, and treat Claude threads as read-only in the composer and thread menu UI
Verification: `cd src-tauri && cargo check`, `npm run typecheck`, `npm run test`
Reuse hint: If another provider needs transcript browsing first, add provider-aware thread summaries and synthetic thread payloads before inventing a parallel workspace model

## [2026-05-05] Claude discovery must fall back to live JSONL when the index is stale
Context: CodexMonitor Claude session discovery under `~/.claude/projects`
Signal: The Claude filter showed `No Claude conversations found` even though local Claude JSONL transcripts existed for loaded workspaces
Root cause: Discovery trusted `sessions-index.json` as the sole source of session metadata, but local Claude indexes can point at deleted or renamed JSONL files while valid transcript files still exist in the same project directory
Fix: Read valid index entries first, then scan real `.jsonl` files in each Claude project directory and synthesize session summaries directly from transcript content when the index is missing or stale
Verification: `cd src-tauri && cargo check`, `cd src-tauri && cargo test discovers_jsonl_sessions_when_index_is_stale -- --nocapture`, `npm run typecheck`, plus local confirmation that `~/.claude/projects/-Users-adamruehle-Development-mcp-testing/sessions-index.json` points at a missing `0cfaeb4b-...jsonl` while the real `aded6b7b-...jsonl` transcript contains `cwd=/Users/adamruehle/Development/mcp-testing`
Reuse hint: If Claude sessions disappear again, compare `sessions-index.json` entries against actual `.jsonl` files before debugging workspace filtering or UI rendering

## [2026-05-05] Provider filters must not depend on the recent-thread cap
Context: CodexMonitor sidebar provider filtering for Claude threads inside workspace thread lists
Signal: The Claude-only filter still showed `No Claude conversations found` after backend discovery was fixed
Root cause: `buildWorkspaceThreadListState()` capped each workspace to the 20 most recent threads before the provider filter ran, so older Claude threads were trimmed out behind newer Codex threads and never reached `threadsByWorkspace`
Fix: Preserve non-default provider summaries as anchors even when they fall outside the recent-thread cap, so provider filters operate on a representative list instead of an already-Codex-only slice
Verification: `npm run test -- src/features/threads/utils/threadActionHelpers.test.ts src/features/threads/hooks/useThreadActions.test.tsx` and `npm run typecheck`; local evidence showed `/Users/adamruehle/Development/mcp-testing` had 108 Codex session files while the relevant Claude session dated to `2026-04-16T09:59:40Z`
Reuse hint: If a provider-specific sidebar filter says nothing exists, inspect pre-filter list truncation before changing backend discovery or filter UI state

## [2026-05-05] Claude session directories can hold the only surviving transcript data
Context: CodexMonitor Claude discovery under `~/.claude/projects/<project>/`
Signal: A workspace showed only one Claude conversation even though the project directory contained another session id plus many nested `subagents/*.jsonl` files
Root cause: Some Claude sessions are stored as session-id directories with nested subagent JSONL files while the indexed top-level `fullPath` JSONL is missing, so flat project-root `*.jsonl` scanning misses those sessions entirely
Fix: Discover Claude sessions from both direct project-root JSONL files and immediate session directories, recursively scan nested JSONL files inside those directories, and synthesize session summaries/thread reads from the collected records
Verification: `cd src-tauri && cargo check`, `cd src-tauri && cargo test discovers_jsonl_sessions_when_index_is_stale -- --nocapture`, `cd src-tauri && cargo test discovers_sessions_from_nested_subagent_jsonl_when_main_file_is_missing -- --nocapture`; local evidence in `~/.claude/projects/-Users-adamruehle-Development-mcp-testing/` showed direct session `aded6b7b-...jsonl` plus missing-main session dir `0cfaeb4b-.../subagents/*.jsonl`
Reuse hint: If Claude still appears to miss sessions after stale-index fallback, inspect whether the project directory contains session-id folders with nested `subagents` content instead of direct session files

## [2026-05-05] Claude sidechain-only sessions should stay hidden from the sidebar
Context: CodexMonitor Claude transcript discovery for user-facing conversation lists
Signal: A discovered Claude session turned out to be only a compaction/summarization worker transcript and should not appear as a normal conversation
Root cause: Recursive Claude discovery can find session-id directories whose only surviving records are `isSidechain: true` subagent JSONL files, which represent spawned worker activity rather than the main user conversation
Fix: Keep recursive record collection for Claude session directories, but drop any discovered session whose collected records are entirely sidechain activity
Verification: `cd src-tauri && cargo check`, `cd src-tauri && cargo test ignores_sidechain_only_session_directories -- --nocapture`, and local inspection of `~/.claude/projects/-Users-adamruehle-Development-mcp-testing/0cfaeb4b-.../subagents/*.jsonl` showing only `isSidechain: true` compaction prompts
Reuse hint: If a Claude transcript looks like an internal worker or compaction job, check whether every record is sidechain activity before exposing it in the main conversation list

## [2026-05-14] Tool action summaries should be inferred at render time
Context: CodexMonitor command and tool-call transcript display
Signal: Command rows exposed raw shell like `rg ...` or `nl ... | sed ...`, but sessions do not reliably store a canonical human-readable reason for each command
Root cause: Codex protocol/session data has structured tool lifecycle fields, but per-command intent text is not consistently available and should not be invented as source-of-truth history
Fix: Derive deterministic action summaries in the renderer from command/tool payloads, keep the exact raw command visible as secondary expandable detail, and fall back to `run` when no safe heuristic matches
Verification: `npm run test`, `npm run typecheck`, targeted ESLint over touched message files, and `git diff --check`
Reuse hint: For future tool display improvements, keep summaries labeled/treated as inferred UI affordances and preserve raw payload details for auditability

## [2026-05-14] Workspace drag ordering should reuse workspace sortOrder
Context: CodexMonitor sidebar workspace ordering
Signal: Workspace cards needed pinned-thread-style drag reordering that persists across app restarts
Root cause: Workspace settings already carry `sortOrder`, so adding a separate sidebar order store would create two competing sources of truth
Fix: Reorder only root workspace cards in normal project view, persist the resulting order through `WorkspaceSettings.sortOrder`, and keep activity/thread-only modes controlled by their own sorters
Verification: Focused Sidebar and workspace ordering tests passed, `npm run typecheck` passed, targeted ESLint passed, and `git diff --check` passed
Reuse hint: For future workspace-order features, update existing `sortOrder` rather than adding localStorage-only sidebar state

## [2026-05-14] Rename-thread modal must opt into an opaque surface
Context: CodexMonitor design-system modal styling for the thread rename prompt
Signal: The rename thread dialog appeared transparent even when app transparency was set to zero
Root cause: `RenameThreadPrompt` reused the generic worktree modal shell, whose card background inherits `--surface-card-strong`; that token is intentionally translucent in normal themes
Fix: Add a rename-specific modal class and force its DS modal card to `--surface-sidebar-opaque` while preserving the shared worktree modal layout
Verification: `npm run test -- src/features/threads/components/RenameThreadPrompt.test.tsx`, `npm run typecheck`, and targeted `git diff --check`
Reuse hint: If a modal must never show content through its card, give that dialog a specific class and override the card surface instead of changing global DS modal tokens

## [2026-05-14] Hook rows must stay scoped to work groups
Context: CodexMonitor work-group rendering for app-server hook events such as `postToolUse`
Signal: Reopened or live threads showed `hook: postToolUse` rows floating between collapsed `Worked for ...` groups
Root cause: `useThreadHookEvents()` ignored the event `turnId`, producing orphan hook tool rows, and older persisted orphan hooks could still render outside any turn segment
Fix: Preserve the hook event `turnId` on new hook conversation items and fold legacy orphan hook entries into the nearest previous work group at render time
Verification: `npm run test -- src/features/threads/hooks/useThreadHookEvents.test.ts src/features/messages/components/Messages.test.tsx`, `npm run typecheck`, and targeted `git diff --check`
Reuse hint: If bookkeeping/tool rows float outside a collapsed turn, first verify they carry `turnId`; add render-time repair only for narrow legacy orphan cases
