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
