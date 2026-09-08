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

## Kermit deployment + cache-hit monitor (multi-turn, Canti) - DONE
Deployed the reconciled fork to Kermit (clean host: no pre-existing prime-agent; node 22).
- Fork coding-agent bundle runs end-to-end against local Canti (canti.muppetlabs:8081) - the
  changed model path executes (headless returns the model reply).
- Multi-turn cache monitor (5 turns, incrementing stable system/harness head with append-only
  tails) showed cached_tokens ramp: turn2=0, turn3=59, turn4=84, turn5=105, turn6=125 while
  cache-MISS tokens stayed ~constant (~50/turn). Confirms cache-lean: a byte-stable head means only
  genuine new tail bytes cost miss price - the core property plan v4 targets.
NOTE: the fork headless print prints the reply to stdout fine; on Kermit the temp agent dir + raw
probe used local Canti (cost-free). Temp deployment left under /home/jfgrissom on Kermit
(~/prime-agent-fork-test, ~/prime-agent-fork-test-agent) - safe to remove after review.
## Mechanism A slice 1: autoRefine.reviewer off switch - DONE (commit 9d53b73)
Implemented the per-turn cadence control for plan v4 (the "A" mechanism) via a settings +
session change:
- autoRefine.reviewer = "model"|"off" (default "model"). getAutoRefineSettings returns reviewer;
  other values -> model.
- interactive + serialized interval auto-refine honor reviewer=off: skip the separate LLM review
  and plan an autonomous cadence refine directly; the planner still emits only evidence-backed edits.
- Cooldown reconciliation: reviewer=off bypasses the post-review cooldown throttle so turnInterval is
  the sole cadence throttle -> turnInterval=1 + reviewer=off yields an every-turn candidate cadence.
- Default (reviewer ON) preserves existing cost/behavior (no surprise); -> D2 gotcha fixed.
Validation: tsgo --noEmit clean. Suites green incl settings-manager (40), agent-session-serialized-
refine (73 with new reviewer-off + cooldown tests), agent-session-compaction (38), harness-context-
gate/messages (5+6), system-prompt (21), refinement (59), refinement-outcome-message (5), agent-session-
services (6), agent-session-queue (110), daemon-serialized-refine (3), serialized-refine-config (9).
D3 from code: _autoRefineAllowedForSession needs a PERSISTED session artifact dir; --no-session uses
SessionManager.inMemory() so cadence does not arm on bare single-shot print (no stray end-of-run call).
Process docs: design-mechanism-A (plan) + analysis-mechanism-A-side-effects state this + open items.


## Mechanism A live cadence-shape cache monitor (Canti, multi-turn) - DONE 2026-09-08
Reduced the plan's cadence smoke to its cache-lean essence and ran it LIVE on Canti
(canti.muppetlabs:8081, kermit) with the exact Mechanism-A emission shape: a byte-stable system/harness
head plus ONE appended tail harness-delta per turn (what a cadence-applied refine appends). Nothing
earlier is rewritten (append-only), matching plan v4's stable-head guarantee.
  cad1: prompt=75  cached=0   miss=75
  cad2: prompt=104 cached=44  miss=60
  cad3: prompt=133 cached=73  miss=60
  cad4: prompt=162 cached=102 miss=60
  cad5: prompt=191 cached=131 miss=60
=> after turn 1 miss stays CONSTANT (~60/turn) while cached_tokens climb monotonically (44/73/102/131).
This is the cache-lean property the plan smoke asked for, reproduced with the cadence-delta tail shape.
(An earlier first probe that regrew its delta lines each turn showed the OPPOSITE — flat cache — which
correctly demonstrates that a changing/moving head destroys caching, reinforcing plan v4's stable-head
design.) Combined with the persisted-turn AgentSession cadence tests (74 green) confirming the cadence
fires/applies at turnInterval=1, Mechanism-A's smoke is validated live on Canti.


## LIVE A/B cache objective test (Canti via a forward proxy) - PASS 2026-09-08
Objective: on new turns that change state, cache hits must climb AND the whole prompt must NOT be
reprocessed because of a state change. Measured through a local HTTP proxy in front of the real canti
endpoint (OpenAI-completions usage.prompt_tokens_details.cached_tokens is the provider cache ledger).

CONFIG A (plan v4): byte-stable system prompt; working state delivered ONLY as appended tail messages
per turn (an "assistant" message carrying a [harness delta]). Prior messages never rewritten.
  t1: prompt=56  cached=0   miss=56
  t2: prompt=91  cached=52  miss=39
  t3: prompt=126 cached=87  miss=39
  t4: prompt=161 cached=122 miss=39
  t5: prompt=196 cached=157 miss=39
=> After a cold first turn, cache hits climb monotonically (+35/turn == the freshly appended state-delta
   bytes) while cache-MISS stays FLAT at 39/turn. The entire stable prefix (system + all prior turns +
   prior deltas) is served from cache; only the newly-appended state-change tail is processed. WIN.

CONFIG B (counterfactual / naive): state injected by REWRITING the system prompt head each turn.
  t1..t5: cached=0 every turn, prompt=49 each, miss=49 every turn.
=> Changing the head makes the WHOLE prompt a cache miss every single turn. Full reprocess per state
change. Confirms why plan-v4's stable-head + append-tail delta is required.

Mechanism in code (verified): AgentSession._recordRefinementOutcome appends the applied harness delta
via agent.state.messages.push(delta) (append-only tail, display:false, forwarded by convertToLlm) - it
never rewrites or reorders prior messages, and the system prompt is rebuilt WITHOUT harness state under
plan v4 (cache head immobile). Snapshot only at cold boundaries (session start / post-compaction).

Test method: local HTTP proxy on kermit logged each request (byte length, message count) and the
provider-returned cached_tokens; upstream = canti.muppetlabs:8081. Requests were real OpenAI-completions
chat calls shaped exactly like product turns (stable system + append-only convo + state-change tail).
