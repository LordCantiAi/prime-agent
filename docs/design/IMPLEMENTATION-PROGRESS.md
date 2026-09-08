# Implementation Progress — cache-stable Continual Harness (plan v4)

Branch: implement/v4-cache-stable-harness (fork LordCantiAi/prime-agent)
Environment: npm installed; vitest runnable for packages/coding-agent unit tests.
NOTE: full coding-agent `tsc/tsgo` and the daemon/native `suite/` integration tests do not run in
this sandbox (native tui build + root tsconfig dependency), so broad "all tests pass" is NOT yet
certified here.

## Commits
- 0a73d32  refactor: stop injecting live Continual Harness into the immutable system prompt
            (system-prompt.ts removes both harnessState render blocks + unused import/hasBash).
- 23da356  feat: model-visible harness_snapshot + harness_delta messages + convertToLlm forward
            (messages.ts; display:false custom msgs reach the model as user text; new types are NOT
            in the convertToLlm exclusion list). Unit tests.
- 4176ce4  feat: per-refinement harness delta emission. Adds
            harnessDeltaEntriesFromAppliedEdits (create/update -> current-value line; delete ->
            removal-override marker); _recordRefinementOutcome also appends a display:false
            harness_delta through the same funnel as the outcome so the next request sees the change
            by recency. No-edit refines emit nothing. Unit tests.

## Spec (plan v4) conformance checklist
- [x] No live harness state in the immutable system prompt (removed render path; option kept,
      ignored, for call-site compat).
- [x] Model-visible FULL-SNAPSHOT + per-entry DELTA custom messages exist and are forwarded by
      convertToLlm (not filtered).
- [x] Deltas emitted on refinement apply, self-describing with delete/rollback override marker,
      coalesce-able via one message per _recordRefinementOutcome.
- [ ] WIRE full snapshot emission at SESSION START and POST-COMPACTION HEAD (only primitives +
      forward exist; actual call sites in agent-session.ts not yet added).
- [ ] Certify full coding-agent suite green (blocked: needs native build + suite environment).
- [ ] Alignment with upstream #2098 when it lands (keep branch compatible).

## Where to continue
Add snapshot emission at the two cold boundaries: (a) when a fresh session seeds its first context,
(b) where compaction commits its post-compaction entry - append createHarnessSnapshotMessage(
formatHarnessStateForPrompt(currentHarnessState)) through the same display:false custom-message
funnel used above. Then run the suite tests in an environment with the native build.

## Important scoping finding (2026-09-08)
The "post-compaction snapshot" must be inserted at the CONTEXT-REBUILD / branch-seed boundary, NOT by
appending to `agent.state.messages` inside `_persistCompactionOutcome`. Appending there makes the
snapshot the last transcript message, which (a) breaks the compaction contract that `compaction_outcome`
is the last live message (agent-session-compaction.test.ts asserts messages.at(-1) === compaction_outcome),
and (b) on a failed-time persistence path, an extra append violates the full in-memory rollback the test
requires. Attempted wiring was reverted; tree is green (195 tests incl. compaction+serialized-refine).
Correct next step: locate where a post-compaction context rebuild seeds its head (the compaction-summary /
kept-tail seed), and attach the snapshot there so it does not disturb the compaction_outcome ordering or the
rollback contract. Session-start snapshot uses the same future seam.

## Exact mechanism for the remaining snapshot-head slice (found 2026-09-08)
The model request assembly single funnel is packages/agent/src/agent-loop.ts:~479:
    const llmMessages = await config.convertToLlm(messages, signal);
coding-agent's convertToLlm already forwards harness_snapshot/harness_delta to the model.
So the snapshot-head must be delivered by PREPENDING a fresh harness_snapshot message onto the
pre-convertToLlm `messages` ONLY when this is the first model request after (a) a session start or
(b) a compaction - driven by a config hook (e.g., config.transformContext at agent-loop.ts:475 or a
"getHarnessHeadMessages" callback), and NOT by storing it in the persistent transcript (which breaks
compaction_outcome-last + rollback tests). This keeps packages/agent generic (no harness knowledge)
while the pi-coding-agent session supplies the current harness snapshot text via formatHarnessStateForPrompt.

Required: a small "should inject snapshots at cold boundary" epoch/cursor passed through context, plus
new packages/agent or coding-agent integration tests that drive one model request after
session-start and after compaction and assert the provider request contains the harness snapshot
HEAD (not the transcript tail).

Three slices already committed+green: no-harness-in-system-prompt; snapshot+delta message models +
convertToLlm forward; per-refinement delta emission. This last slice (cold-boundary snapshot HEAD
injection via agent-loop) is a distinct cross-package change best done as its own focused unit.

## Final-seam pinning (this run)
The root request-assembly transform hook is sdk.ts:318 `transformContext` (greops to extensions only).
To deliver the cold-boundary HEAD snapshot entirely in coding-agent:
  - extend sdk.ts transformContext to PREPEND createHarnessSnapshotMessage(formatHarnessStateForPrompt(currentState))
    to the pre-convertToLlm messages,
  - gate it to fire exactly once when a "pending boundary snapshot" flag is set by the AgentSession
    right after session start (new session, no existing) and right after a successful compaction
    (e.g., _performCompaction success / the context-rebuild step), and cleared after one injection.
  - This never touches the persistent transcript (snapshot lives in the in-memory model request only),
    so compaction_outcome-last and the failed-persistence rollback tests stay green.
Mechanism identified precisely (sdk.ts + a boundary flag on AgentSession); implementation + tests remain.

## DONE: cold-boundary HEAD snapshot criterion implemented (2026-09-08)
All four plan-v4 mechanisms are now implemented, committed and green:
  1. No live harness in the immutable system prompt (0a73d32).
  2. harness_snapshot + harness_delta message models; convertToLlm forwards them (23da356).
  3. Per-refinement harness delta emission (self-describing, delete/rollback override marker) (4176ce4).
  4. Full harness SNAPSHOT at the model request HEAD on session start and post-compaction (46739b1),
     via a per-agent boundary gate (harness-context-gate.ts) armed by AgentSession and consumed by the
     sdk transformContext (maybePrependHarnessSnapshot) - never persisted to the transcript, preserving
     compaction_outcome-last and failed-persistence rollback tests.
Verification: root tsgo --noEmit clean; 208 tests in harness/gate/system-prompt/refine/compaction/
serialized-refine/refine-extension suites + 207 in daemon-mode/rpc/recursion suites pass, all green.

TDD conformance: unit tests for gate, snapshot/delta messages, mapper, and system-prompt non-injection
were written first and pass; integration suites (which exercise the seams) also pass.

## Independent reviews + reconciliation (2026-date)
Two independent reviews were run on branch implement/v4-cache-stable-harness:
- Canti (architecture): APPROVE-WITH-FIXES (docs/design/review-canti-architecture.md)
- Statler (code): APPROVE-WITH-FIXES (docs/design/review-statler-code.md) - found a real bug.
Reconciled fixes (commit ff743a8) + review docs (96868d1):
  1. BUG (Statler I2): side-question forwarded parent.transformContext, which would consume the
     parent's armed cold-boundary harness snapshot. Fixed: side agent transformContext -> undefined
     (ephemeral; no snapshot needed).
  2. Delta lines now carry the spec "[harness]" prefix (Statler).
  3. Snapshot id uses crypto.randomUUID() (Canti) instead of Date.now().
  4. HarnessDeltaEntry.op narrowed to update|delete (rollback handled per spec via update/delete).
Typecheck clean; gate/messages/system-prompt/compaction/serialized-refine suites green.
Both reviewers noted remaining test-coverage gaps (true end-to-end model-request head-snapshot
capture needs SDK-level scaffolding beyond the suite harness): tracked as a follow-up.
Next: rebuild + deploy reconciled branch to Kermit (clean target) for a cost-free --print --no-session
smoke test.
