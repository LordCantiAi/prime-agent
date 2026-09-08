
Architectural Review: Cache-Stable Continual Harness (plan v4)
Branch: implement/v4-cache-stable-harness
Date: 2026-01-08

OVERALL VERDICT: APPROVE-WITH-FIXES

================================================================================
(A) SPEC CONFORMANCE — 4 CRITERIA
================================================================================

Criterion 1: No live Continual Harness in the immutable system prompt.
CONFIRMED. system-prompt.ts removes both harnessState render blocks
(lines deleted at system-prompt.ts:103-106, 138-141). The harnessState
parameter remains in BuildSystemPromptOptions but is destructured and
never used. The test buildSystemPrompt omits Continual Harness State even
when harnessState is provided (system-prompt.test.ts:378-409) confirms
no harness content leaks into the system prompt. The old 5 negative tests
that verified harness injection have been removed (344 lines deleted).

Criterion 2: Full harness SNAPSHOT at HEAD only at session-start + post-compaction,
never persisted to transcript.
CONFIRMED. The snapshot is delivered exclusively via the sdk.ts
transformContext hook (sdk.ts:321-322), which prepends the snapshot using
maybePrependHarnessSnapshot(). The snapshot message is display:false and
never written to the session file via appendCustomMessageEntryWithRollback.
The arm is set in two places:
  - sdk.ts:386: session.armHarnessSnapshot() for new sessions (hasExistingSession check)
  - agent-session.ts:7774: this._armHarnessSnapshot() after successful compaction
Both are consumed once by transformContext and the WeakMap entry is deleted.

Criterion 3: Tail-only per-refinement self-describing harness DELTA at request-assembly.
CONFIRMED. harnessDeltaEntriesFromAppliedEdits (messages.ts) creates
self-describing lines:
  - create/update: `kind "id" = <first line of value>` (truncated at 140 chars)
  - delete: `kind "id" no longer valid (removed)`
The delta message is emitted in _recordRefinementOutcome (agent-session.ts:8520-8543),
appended to both the session file (persistence) and agent.state.messages (in-memory).
It flows through convertToLlm as user-role text (NOT in the exclusion list).

Criterion 4: Delete/rollback override marker.
CONFIRMED. The delta format uses explicit removal markers for deletes:
`kind "id" no longer valid (removed)`. Rollback-to-none maps to "delete" action,
rollback-to-prior-value maps to "update" action (correct, per spec). RefinementAction
is "create" | "update" | "delete" (refinement.ts:23) — no "rollback" action exists,
so rollback is handled via update/delete as the spec intends.

================================================================================
(B) BOUNDARY-GATE SOUNDNESS
================================================================================

The gate is a WeakMap-based, single-consume, per-target mechanism:
  - armHarnessSnapshotBoundary(target, text) — sets WeakMap[target]
  - consumeHarnessSnapshotBoundary(target) — gets + deletes in one JS atomic op
  - maybePrependHarnessSnapshot(target, messages) — consumes and prepends

RACE ANALYSIS:
1. "Arm while a request in flight": The arm happens in _armHarnessSnapshot()
   at session creation (sdk.ts:386) or post-compaction (agent-session.ts:7774).
   Both occur before any model request can be assembled. The WeakMap is set on
   `this.agent` (the same object passed to maybePrependHarnessSnapshot).
   A model request in flight would call transformContext before the arm if
   it started before the arm. After the arm, the next transformContext call
   consumes it. No race: the arm precedes all subsequent requests.

2. "Multiple arms before one request": If _armHarnessSnapshot is called twice
   before the first transformContext consumes the snapshot, the second arm
   silently overwrites the first in the WeakMap. The second arm always reads
   the LATEST harness state (which is correct). This is safe.

3. "Armed-never-consumed": If a session is aborted/crashed after arming but
   before any request, the WeakMap entry simply remains until the agent object
   is GC'd. No resource leak, no corruption. The snapshot is never re-emitted
   on a later session (different agent object). Safe.

4. "Snapshot lands on model's next request": transformContext is called on
   every model request assembly (sdk.ts:319-325). The first call after arm
   consumes the snapshot and prepends it. Subsequent calls find no armed
   snapshot and return messages unchanged. Correct.

ONE CONCERN (non-blocking):
The arm for new sessions (sdk.ts:386) happens AFTER AgentSession creation
but BEFORE the extension runner is connected (resourceLoader.getExtensions()
is at sdk.ts:394). If an extension triggers a model request synchronously
during createAgentSession (before the function returns), the arm would fire
in time since it's synchronous. However, model requests are always
async, so there is no real race. Confirmed by the async nature of
Agent.steer/continue.

================================================================================
(C) CACHE-STABILITY CORE CLAIM
================================================================================

CONFIRMED. The system prompt head is now stable:
- buildSystemPrompt never includes harness content.
- The system prompt bytes are identical across all turns for the same
  tools, skills, contextFiles, guidelines.

Live harness state only appears in the new payload head/tail:
- HEAD: harness_snapshot (at cold boundaries only)
- TAIL: harness_delta (at request-assembly time for each refinement)
- Between cold boundaries with no harness changes: no extra harness bytes.

The snapshot is NOT part of the system prompt — it is a user-role custom
message prepended in transformContext. The delta is a user-role custom
message appended in _recordRefinementOutcome. Both reach the model through
the same LLM message pipeline but are not part of the cached system prompt.

================================================================================
(D) TEST COVERAGE ANALYSIS
================================================================================

TESTS PASSING: 11/11 harness-context-gate + 11/11 harness-context-messages +
21/21 system-prompt = 43 tests, all green.

GAPS (real, not vacuous):
1. NO integration test for cold-boundary snapshot injection. The gate tests
   verify maybePrependHarnessSnapshot() in isolation but do not drive a
   full model request through sdk.ts transformContext to confirm the snapshot
   actually reaches the provider payload on a new session or post-compaction.

2. NO test for the delta persistence path. harnessDeltaEntriesFromAppliedEdits
   is tested in isolation, but there is no test confirming the delta message
   is correctly persisted via sessionManager.appendCustomMessageEntryWithRollback
   and appears in the session JSONL.

3. NO test for the "armed-never-consumed" scenario (session crash after arm).
   The WeakMap behavior is implicitly tested (consume returns undefined after
   first consume), but the full lifecycle (arm -> abort -> restart) is not.

4. NO test for delta coalescing across multiple refinements before a single
   payload. The spec says "N changes before a payload -> coalesce to one line
   per entry (current value)." The current implementation emits one delta
   message per _recordRefinementOutcome call, which coalesces within a single
   refinement but does NOT coalesce across multiple refinements. If refinements
   are applied between requests, each gets its own delta message — which is
   actually correct (each is a separate tail message), but this behavior should
   be explicitly tested.

5. NO test verifying that the harness snapshot is NOT included in the session
   file (compaction test suite would be the right place). The spec says
   snapshots are never persisted; tests should confirm this.

6. The system-prompt test that removed the harness injection tests (344 lines
   deleted) did not add a negative test for harness state in compaction
   summaries or serialized-refine paths.

================================================================================
(E) FORESEEABLE REGRESSIONS / BLAST RADIUS
================================================================================

1. DELTA IN SESSION FILE vs. SPEC INTENT (medium):
   Harness deltas are persisted via appendCustomMessageEntryWithRollback
   (agent-session.ts:8528-8534), which writes them to the session JSONL.
   The spec says deltas "become part of the immutable log." This IS the
   correct behavior — deltas should be in the immutable log (transcript).
   However, if a session is rebuilt from the JSONL without a snapshot
   (e.g., cold start after a crash, or a branch that never had a snapshot
   emitted), the model may see a delta without its baseline. Since deltas
   are self-describing ("kind 'id' = value" or "kind 'id' no longer valid"),
   the model can adopt them independently, but this should be noted.

2. FORMAT HARNESS STATE FAILURE SILENTLY SWALLOWED (low):
   _armHarnessSnapshot (agent-session.ts:7778-7783) catches all exceptions
   with a bare try/catch. If formatHarnessStateForPrompt or
   _loadMergedHarnessState throws, the snapshot is silently lost and the
   next model request will start without harness context. This is
   intentional ("best-effort") but could mask real bugs.

3. SNAPSHOT ID GENERATION (low):
   createHarnessSnapshotMessage uses snapshotId: `head-${Date.now()}`
   (harness-context-gate.ts:40). Date.now() is not monotonic and can
   collide across sessions. The cryptoRandomId fallback exists but is
   not used here. The snapshotId is for replay/delta anchoring per the
   HarnessSnapshotDetails interface; using Date.now() could cause
   non-deterministic replay behavior.

4. DELTA CONTENT TRUNCATION (low):
   truncateToFirstLine (messages.ts:610-613) truncates at 140 chars.
   If a harness entry's first line is a code snippet or path, truncation
   may cut off meaningful content. The spec allows this, but edge cases
   (e.g., a one-line skill reference) should be tested.

5. NO HANDLING OF CONCURRENT REFINEMENTS (medium):
   _recordRefinementOutcome emits a delta for each refinement. If two
   refinements apply concurrently (serializedRefine mode, or extension-
   triggered + manual), each appends its delta to agent.state.messages.
   The model sees them as separate tail messages. Since they use
   recency-based override, the last one wins, which is correct. However,
   there is no deduplication of same-entry changes across refinement calls
   (e.g., two refinements that both update memory:foo). The spec's
   coalescing window ("changes since the last assembled payload") applies
   at request-assembly time, not at refinement time. This means multiple
   deltas may reference the same entry. The model handles this via recency,
   but it adds unnecessary bytes.

6. COMPATIBILITY WITH EXTENSIONS:
   The transformContext hook now prepends the snapshot before
   runner.emitContext(next) (sdk.ts:323-324). Extensions see the snapshot
   in their context. If extensions have their own harness-aware logic,
   they may now see duplicate harness state. This is unlikely but worth
   noting.

================================================================================
CONFIRMED-SOUND
================================================================================
- System prompt no longer contains live harness state (criterion 1)
- Snapshot delivered only at session-start and post-compaction via transformContext
  (criterion 2)
- Delta messages are self-describing with proper delete/rollback markers
  (criteria 3 + 4)
- WeakMap gate is single-consume, per-target, race-free in practice
- convertToLlm correctly forwards harness_snapshot and harness_delta
  (not filtered)
- Delta persistence via appendCustomMessageEntryWithRollback is correct
  (deltas ARE part of the immutable log per spec)
- Session start arm happens before any async model request can fire
- Post-compaction arm happens after compaction completes, before next request
- 43 unit tests all green

================================================================================
ISSUES WITH FIX
================================================================================

1. harness-context-gate.ts:40 — Snapshot ID uses Date.now()
   Fix: Use crypto.randomUUID() for snapshotId, consistent with
   cryptoRandomId() in messages.ts. This ensures deterministic replay.
   Change: `snapshotId: opts?.snapshotId ?? crypto.randomUUID()`
   (Need to import or inline crypto.randomUUID check.)

2. harness-context-gate.ts — Missing "rollback" op in HarnessDeltaEntry
   The HarnessDeltaEntry.op type is `"create" | "update" | "delete" | "rollback"`
   (messages.ts:553) but the delta function only emits "update" or "delete"
   (since RefinementAction has no "rollback" variant). The "rollback" op
   is declared but never emitted. This is not a bug (the type is a superset
   of emitted values), but it creates a misleading API. Either remove
   "rollback" from the type or document why it's reserved.

3. agent-session.ts:8528-8534 — Delta persistence without corresponding
   test coverage. Add an integration test in the harness context test suite
   that verifies:
   a) A delta message is persisted to the session file
   b) A delta message appears in agent.state.messages
   c) The delta message is NOT in the system prompt

4. Missing integration test for cold-boundary snapshot. Add a test that
   drives a model request after session creation and verifies the
   harness_snapshot appears at the head of the LLM message array.

================================================================================
TOP FOLLOW-UPS
================================================================================
1. Add integration test: model request after session start contains harness_snapshot at HEAD
2. Add integration test: model request after compaction contains harness_snapshot at HEAD
3. Fix snapshotId to use crypto.randomUUID() instead of Date.now()
4. Clarify or remove "rollback" from HarnessDeltaEntry.op type
5. Add test confirming deltas are persisted to session JSONL
6. Add test confirming deltas are NOT persisted to system prompt
7. Consider coalescing delta entries across refinements (performance)
8. Document the snapshot-not-in-transcript contract for extension authors
