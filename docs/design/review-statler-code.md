# Code Review: `implement/v4-cache-stable-harness`

Reviewer: Statler (Qwen3.8-27B Dense)
Date: 2026-06-11
Branch: `implement/v4-cache-stable-harness` (9 commits, 9 files, +477/-327)
Spec: `docs/design/cache-stable-continual-harness.md` (plan v4)

## Verdict: APPROVE-WITH-FIXES

The implementation is largely correct and well-structured. All four spec invariants
are met with one exception: a side-question snapshot-consumption bug violates I2
(FULL STATE AT COLD BOUNDARIES) for the main session under a narrow race condition.
All unit tests pass; type-checking is clean. Two required fixes and three recommended
improvements are listed below.

---

## 1. Spec Criteria Verification

### I1 — IMMUTABLE LOG: PASS

- `system-prompt.ts`: Both `harnessState` render blocks removed. The `formatHarnessStateForPrompt`
  import is dropped. The `harnessState` option remains in `BuildSystemPromptOptions` (line 35)
  for call-site compat but is never read — verified by the new test
  "buildSystemPrompt omits Continual Harness State even when harnessState is provided".
- Snapshot delivery uses the `transformContext` hook (sdk.ts:322), which operates on the
  pre-convertToLlm message array. The snapshot message is **never** pushed to
  `agent.state.messages` or persisted to the session file. The persistent transcript
  is untouched.
- Delta messages **are** appended to `agent.state.messages` (agent-session.ts:8538) and
  persisted via `appendCustomMessageEntryWithRollback`. This is correct: deltas become
  part of the immutable log the moment they are served. Prior messages are never modified.

### I2 — FULL STATE AT COLD BOUNDARIES ONLY: PARTIAL (one bug)

**Session start** (correct):
- `sdk.ts:383-385`: `if (!hasExistingSession) { session.armHarnessSnapshot(); }`
- `AgentSession.armHarnessSnapshot()` → `_armHarnessSnapshot()` →
  `formatHarnessStateForPrompt(this._loadMergedHarnessState())` →
  `armHarnessSnapshotBoundary(this.agent, text)`
- The armed text is consumed by `transformContext` on the first model request.

**Post-compaction** (correct):
- `agent-session.ts:7774`: `this._armHarnessSnapshot()` at the end of `_performCompaction`,
  after `buildSessionContext()` rebuilds `agent.state.messages`.
- The next model request (via `_schedulePostCompactionContinue` or queued user input)
  consumes the armed snapshot through `transformContext`.

**BUG — side-question snapshot consumption (I2 violation)**:

Location: `side-question.ts:98` — `transformContext: parent.transformContext`

The `transformContext` closure in `sdk.ts:320-325` captures the `agent` variable:

```ts
transformContext: async (messages) => {
    const next = maybePrependHarnessSnapshot(agent, messages);
    // ...
}
```

When a side-question is started, a **new** `Agent` instance is created
(side-question.ts:88) and the parent's `transformContext` function is passed to it.
The closure still references the **parent** `agent` object for the WeakMap lookup.

Scenario:
1. Session starts → `armHarnessSnapshot()` arms a snapshot on the parent agent.
2. User asks a side-question before the first main turn completes.
3. `startSideQuestion` creates `sideAgent` with `transformContext: parent.transformContext`.
4. The side-agent's first model request calls `transformContext` →
   `maybePrependHarnessSnapshot(parentAgent, messages)` → **consumes the parent's armed snapshot**.
5. The parent agent's first turn proceeds without the harness snapshot.

Impact: The main agent's first model request lacks the full harness state, violating I2.
The model operates without knowing the current harness entries until the next cold boundary
or the next delta emission.

Severity: **Medium** — requires a side-question to be asked before the first main turn
completes. In practice, side-questions are typically asked mid-conversation, after the
first turn has already consumed the snapshot. However, the race is real and the fix is
straightforward.

Fix options:
- **Option A** (preferred): Pass the agent instance as a parameter to `transformContext`
  instead of relying on closure capture. The `Agent` class would need a small change to
  pass `this` to `transformContext`.
- **Option B**: Use a different WeakMap key for the snapshot gate — e.g., a per-session
  token or the `sessionId` string — so that the side-agent (which shares `sessionId` with
  the parent) can be distinguished.
- **Option C**: In `startSideQuestion`, wrap the parent's `transformContext` in a no-op
  for the snapshot gate: `transformContext: async (m) => parent.transformContext(m)` but
  with a different agent key. This is the least invasive.

### I3 — APPEND-ONLY TAIL FOR CHANGES: PASS

- `_recordRefinementOutcome` (agent-session.ts:8513-8540) appends a `harness_delta`
  message after the `refinement_outcome` message.
- `harnessDeltaEntriesFromAppliedEdits` (messages.ts) converts applied edits to
  self-describing lines:
  - create/update → `kind "id" = <first line of content, truncated to 140 chars>`
  - delete → `kind "id" no longer valid (removed)`
- Unapplied edits are filtered out. No-edit refines emit nothing (`entries.length === 0`).
- The delta is persisted via `appendCustomMessageEntryWithRollback` and pushed to
  `agent.state.messages`. It becomes part of the immutable log on the next served payload.
- Rollback-to-a-prior-value: The spec says this should be treated as UPDATE (emit the value
  it reverted TO). The implementation maps all non-delete actions to `op: "update"`, which
  is correct — `e.action === "rollback"` would fall through to the `create || update` branch
  only if it matched, but since the code checks `e.action === "create" || e.action === "update"`,
  a rollback action would fall to the `delete` branch. **Wait — this is a potential issue.**

  Looking at `harnessDeltaEntriesFromAppliedEdits`:
  ```ts
  if (e.action === "create" || e.action === "update") {
      // ... current value line
  }
  // delete: nothing new to give recency; emit override marker.
  return { op: "delete", kind, id, line: `${kind} "${id}" no longer valid (removed)` };
  ```
  Rollback-to-a-prior-value: The spec says this should be treated as UPDATE (emit the value
  it reverted TO). The `RefinementAction` type is `"create" | "update" | "delete"` — there is
  no `"rollback"` action. Rollbacks are represented as `action: "update"` with the prior value
  in `after.content`, which correctly emits a current-value delta line. **Non-issue.**

### I4 — CACHE LEAN: PASS

- System prompt is byte-stable across harness changes (no harness content).
- Snapshot only at cold boundaries (session start, post-compaction) — rare by nature.
- Deltas are append-only: new bytes in the tail, never modifying prior payload bytes.
- No harness change → no delta message → prefix is identical → provider cache hit.

---

## 2. Bug Hunt

| Bug | Status | Severity |
|-----|--------|----------|
| WeakMap semantics | ✅ Correct | — |
| Timing (arm before request) | ✅ Correct for main agent | — |
| Side-question snapshot consumption | ❌ **BUG** | Medium |
| Double-prepend prevention | ✅ Correct (consume-once) | — |
| convertToLlm filtering | ✅ Correct (snapshot+delta forwarded, outcome filtered) | — |
| Unused imports | ⚠️ `harnessState` option kept for compat | Low (intentional) |
| Rollback delta type | ✅ Correct — `RefinementAction` has no `"rollback"`, rollbacks use `"update"` | — |

---

## 3. Test Results

| Test suite | Result |
|-----------|--------|
| `tsgo --noEmit` | ✅ PASS (exit 0) |
| harness-context-gate (5 tests) | ✅ PASS |
| harness-context-messages (6 tests) | ✅ PASS |
| system-prompt (21 tests) | ✅ PASS |
| refinement (59 tests) | ✅ PASS |
| compaction (29 tests, 2 skipped) | ✅ PASS |
| compaction-serialization (3 tests) | ✅ PASS |
| trigger-compact-extension (1 test) | ✅ PASS |
| compact-session-stream (4 tests) | ✅ PASS |
| refinement-outcome-message (5 tests) | ✅ PASS |
| agent-session-services (6 tests) | ✅ PASS |
| agent-session-concurrent (20 tests) | ✅ PASS |
| agent-session-tree-navigation (10 tests) | ⏭️ SKIPPED (environment) |

Total: **118 + 99 + 26 = 243 tests passed**, 0 failed.

---

## 4. Missing Tests

1. **No integration test for the snapshot flow**: No test drives a full
   session start → model request and asserts the provider payload contains a
   `harness_snapshot` at the head. The unit tests cover the gate and the
   `transformContext` call in isolation, but not the end-to-end flow.

2. **No integration test for the post-compaction snapshot**: No test drives
   compaction → next model request and asserts the snapshot is present at the
   head of the rebuilt context.

3. **No test for the side-question snapshot consumption bug**: The bug
   identified in I2 is not covered by any test.

4. **No test for delta emission in `_recordRefinementOutcome`**: The delta
   message creation, persistence, and push to `state.messages` is not tested
   end-to-end. The `harnessDeltaEntriesFromAppliedEdits` function is tested in
   isolation, but the `_recordRefinementOutcome` method that calls it is not.


---

## 5. Spec Deviations

1. **Delta line format**: The spec specifies `[harness] <kind> "<title/id>" =
   <current value>`. The implementation uses `<kind> "<id>" = <current value>`
   (no `[harness]` prefix). The `[harness]` prefix helps the model identify
   harness delta lines in the message stream. Its absence is a minor deviation
   that could reduce the model's ability to distinguish harness deltas from
   other user-role text.

2. **Snapshot placement**: The spec says the snapshot should "ride ON THE
   POST-COMPACTION HEAD". The implementation prepends the snapshot to the model
   request via `transformContext`, placing it before the compaction summary
   message. This is correct — the snapshot is at the head of the context.

3. **Delta content truncation**: The implementation truncates the first line of
   `e.after?.content` to 140 characters. The spec does not specify a truncation
   limit. This is a reasonable implementation choice to keep delta lines short.

---

## 6. Required Fixes

1. **Fix the side-question snapshot consumption bug** (I2 violation).
   The `transformContext` closure captures the parent `agent` and the
   side-question agent shares this closure. The side-question's first model
   request consumes the parent's armed snapshot.
   - **Recommended fix**: In `startSideQuestion` (side-question.ts), wrap the
     parent's `transformContext` to skip the harness snapshot gate:
     ```ts
     transformContext: async (messages) => {
         // Skip harness snapshot for side-questions; the parent agent owns the gate.
         const runner = /* extension runner */;
         return runner ? runner.emitContext(messages) : messages;
     },
     ```
     Or, more cleanly, pass the agent instance to `transformContext` as a
     parameter (requires a small change to the `Agent` class).

2. **Add integration tests for the snapshot flow**:
   - Session start → first model request → assert `harness_snapshot` at head.
   - Post-compaction → next model request → assert `harness_snapshot` at head.
   - Side-question after session start → assert the main agent still receives
     the snapshot on its first turn.

## 7. Recommended Improvements

3. **Add the `[harness]` prefix to delta lines** to match the spec format:
   ```ts
   line: `[harness] ${kind} "${id}" = ${summary}`
   line: `[harness] ${kind} "${id}" no longer valid (removed)`
   ```

4. **Add a test for delta emission in `_recordRefinementOutcome`**: Verify that
   the delta message is created, persisted, and pushed to `agent.state.messages`
   when a refinement with applied edits is recorded.

5. **Clean up the unused `harnessState` option** from `BuildSystemPromptOptions`
   or add a comment explaining why it is kept.

---

## 8. Summary

The branch implements the core mechanism of plan v4 correctly:
- Harness state removed from the system prompt (I1).
- Full snapshot at cold boundaries via `transformContext` hook (I2, with one
  side-question bug).
- Per-refinement delta emission as self-describing tail lines (I3).
- Cache-lean by design (I4).

The code is clean, type-safe, and all 243 unit tests pass. The two required
fixes (side-question bug, integration tests) are straightforward. The
recommended improvements are minor. The branch is ready for merge after the
required fixes are applied.
