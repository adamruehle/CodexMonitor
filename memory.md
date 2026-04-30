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
