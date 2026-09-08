================================================================================
HANDOFF - Cache-Stable Continual Harness (plan v4) + Mechanism B design
================================================================================
Session date: 2026-09-08. Compaction/resume handoff. Read fully before continuing.

GOAL (objective being worked, all else complete): "Implement the cache-stable Continual
Harness context change (plan v4) using TDD ... no harness in system prompt; full snapshot only at
session-start+post-compaction head; tail-only self-describing deltas at request-assembly with
delete override marker ... passes tests." Plus a 2nd real feature question the user is exploring:
a way to EXPLICITLY create state changes per turn.

STATUS: Plan v4 is FULLY IMPLEMENTED, REVIEWED, VALIDATED, and READY. Mechanism-B (an explicit
direct-write per-turn state feature) is DESIGNED but NOT implemented. See end.

--------------------------------------------------------------------------------
1. WHERE EVERYTHING LIVES
--------------------------------------------------------------------------------
Fork repo      : git@github.com:LordCantiAi/prime-agent.git
Working clone  : /home/jfgrissom/Repos/prime-agent-fork
Branch         : implement/v4-cache-stable-harness
HEAD           : 10c8c82  (sha 10c8c8299e0e12713210999dc74ecceb748a370d) - pushed to origin
Upstream base  : 9c8230d (PrimeIntellect-ai/prime-agent main; this fork is post #2098-partial)

Design/spec docs in the FORK (authoritative):
  docs/design/cache-stable-continual-harness.md  - plan v4 spec
  docs/design/IMPLEMENTATION-PROGRESS.md         - commit log, findings, mechanism-B note
  docs/design/review-canti-architecture.md       - independent Canti review (APPROVE-WITH-FIXES)
  docs/design/review-statler-code.md             - independent Statler review (APPROVE-WITH-FIXES)

Workspace mirror copies (under knowledge/specs/):
  prime-agent-harness-context-plan.md            = spec
  prime-agent-impl-progress.md                   = IMPLEMENTATION-PROGRESS
  review-canti-architecture.md                   = Canti report
  review-statler-code.md                         = Statler report

--------------------------------------------------------------------------------
2. THE FOUR MECHANISMS (all implemented + committed)
--------------------------------------------------------------------------------
(A) No live Continual Harness in the immutable system prompt.
    system-prompt.ts: buildSystemPrompt no longer renders formatHarnessStateForPrompt/harnessState.
(B) harness_snapshot + harness_delta custom messages; model-visible via convertToLlm (NOT filtered
    like refinement_outcome). messages.ts.
(C) Per-refinement harness DELTA at request-assembly: harnessDeltaEntriesFromAppliedEdits ->
    create/update -> '[harness] kind "id" = <val>'; delete/rollback-to-none -> '[harness] kind "id"
    no longer valid (removed)'. Emitted in agent-session.ts _recordRefinementOutcome.
(D) Full SNAPSHOT at model-request HEAD at cold boundaries only (session start + post-compaction):
    harness-context-gate.ts per-agent WeakMap armed by AgentSession (new-session in sdk.ts +
    post-compaction in agent-session.ts _performCompaction) and consumed once by the sdk
    transformContext via maybePrependHarnessSnapshot -> prepends a harness_snapshot.
    NEVER persisted to transcript (preserves compaction_outcome-last + rollback tests).

KEY FILES (all under packages/coding-agent/src/core unless noted):
  system-prompt.ts, messages.ts, sdk.ts (transformContext + session-start arm),
  agent-session.ts (_recordRefinementOutcome delta; _performCompaction post-compaction arm;
    public armHarnessSnapshot()), harness-context-gate.ts (NEW - WeakMap gate + maybePrepend),
  side-question.ts (fixed: does NOT forward parent transformContext).
  test: harness-context-gate.test.ts, harness-context-messages.test.ts, system-prompt.test.ts.

VALIDATION (all green): root `tsgo --noEmit` CLEAN. ~243 tests in:
  harness-context-gate (5), harness-context-messages (6), system-prompt (21), refinement (59),
  refinement-outcome-message (5), agent-session-compaction (38), agent-session-serialized-refine (71),
  compaction-serialization/trigger/compact-session-stream, agent-session-services (6),
  agent-session-concurrent (20). Also daemon-mode (203). The suite tests RUN in this environment
  (an earlier 'can't run' assumption was wrong; root tsgo --noEmit + vitest in packages/coding-agent work).

--------------------------------------------------------------------------------
3. COMMIT HISTORY (main..HEAD), all on the branch
--------------------------------------------------------------------------------
0a73d32 stop injecting live Continual Harness into immutable system prompt
23da356 model-visible harness_snapshot+delta messages; convertToLlm forward
4176ce4 emit per-refinement harness delta (_recordRefinementOutcome)
2817332 fix type errors in test fixtures (root typecheck clean)
6c40352 docs: snapshot seam finding (append-to-transcript breaks compaction tests)
0657c7e docs: pin agent-loop convert funnel + config hook
0e6f129 docs: pin sdk.ts transformContext as cold-boundary HEAD seat
46739b1 feat: deliver full snapshot at cold-boundary HEAD (gate + sdk consume)
beece1d/docs: mark criterion 4 done
96868d1 docs: add independent Canti(arch)+Statler(code) review reports
ff743a8 fix: reconcile reviews (side-question bug / [harness] prefix / randomUUID / op narrowing)
9bde809 docs: record reviews + reconciled fixes
8cad53b docs: record Kermit smoke test + multi-turn Canti cache monitor

--------------------------------------------------------------------------------
4. INDEPENDENT REVIEWS (both APPROVE-WITH-FIXES; fixed)
--------------------------------------------------------------------------------
Canti (architecture): confirmed all 4 criteria met; boundary gate sound (single-consume WeakMap,
race-free, arm-before-request, armed-never-consumed harmless); cache claim confirmed. Fixes: snapshot
id crypto.randomUUID (done); narrow 'rollback' op (done); add integration tests (partially open).
Statler (code, slowest - gave him time; user reserved Statler for other work - do NOT spawn him):
APPROVE-WITH-FIXES with the ONE real BUG: side-question forwarded parent.transformContext which
would CONSUME the parent's armed snapshot -> side agent transformContext now undefined (fixed, ff743a8).
Statler also: add '[harness]' delta prefix (done), snapshot id randomUUID (done), integration tests
for session-start/post-compaction snapshot & no-side-question-steal (STILL OPEN - see #5 gaps).
Test adequacy note: unit tests prove the gate/messages/mapper; integration tests that capture the
actual model-request array at session-start/compaction need SDK-level scaffolding (the suite harness.js
builds its own Agent without maybePrependHarnessSnapshot, so it can't observe the SDK transform). This
is a real, unimplemented gap - worth adding in a focused pass.

--------------------------------------------------------------------------------
5. KNOWN REMAINING WORK / GAPS (open)
--------------------------------------------------------------------------------
i. True end-to-end integration tests for cold-boundary HEAD snapshot (session-start + post-compaction
   -> model request array contains harness_snapshot) and side-question-no-steal. Both reviewers
   flagged; not currently covered (needs a context-capturing harness on the sdk.ts path).
ii. A "one state change per turn" / EXPLICIT direct-write feature (Mechanism B) - NOT implemented,
   designed, see #6 below. This is the live question from the user.
iii. ./docs/design/cache-stable-continual-harness.md is untracked (??); it is the spec - optionally git-add it.
iv. If pruning for an upstream PR: this is a pi-coding-agent (not pi-agent-core) change; decide whether
   to split into (a) no-harness-in-system-prompt + (b) snapshot/delta messages + (c) gate/sdk wiring.

--------------------------------------------------------------------------------
6. MECHANISM B - 'explicit state change per turn' (DESIGNED, NOT BUILT)  <-- the open item
--------------------------------------------------------------------------------
User wants the model to explicitly persist structured state each turn and have it reach the model
next turn cache-stably. Two mechanisms:
  MECHANISM A (current/implemented): per-turn `await refine.run("capture durable state")` -> runs at
    turn end -> _recordRefinementOutcome -> harness_delta. Evidence-driven (refine picks the edits).
  MECHANISM B (proposed, no code yet): the model does a DIRECT, deterministic write per turn:
        await rlm.harness.upsert_memory("session-state", content=<explicit struct>)
    But today that direct kernel write lands in harness_state.json WITHOUT a TS-host emission hook,
    so it would NOT surface as a tail delta (my delta hook is refine-path only).

  DESIGN for B (agreed intent, from the user conversation):
   - Add a host hook so DIRECT kernel harness writes are also surfaced as a HARNESS_DELTA at the next
     request-assembly (the SAME transformContext/gate seam), so the model sees its own newest state.
   - Recommended implementation approach (2 options to pick):
       B1 'diff-at-assembly': at transformContext, diff current harness_state.json vs 'last served'
          snapshot; emit a single harness_delta for the net changed entries; dedup against refine so a
          refine-driven edit isn't double-emitted.
       B2 'explicit kernel notify': when rlm.harness.upsert_* is called, the kernel sends a host_event /
          host_request so TS arms a delta directly (more precise; needs kernel->TS bridge addition).
   - Cache-stability must be preserved: emitted once, as new tail bytes, never persisted to transcript.
   - The user says "want to test both": test MECHANISM A (refine per turn) vs MECHANISM B (explicit
     upsert per turn) head-to-head on Canti (local, canti.muppetlabs:8081) over N turns, measuring BOTH
     correctness (state survives) and cache cost (cached vs miss tokens).

  BEFORE BUILDING B GET USER SIGN-OFF on (i) roll the state struct in ONE 'session-state' memory vs
  arbitrary ad-hoc writes; (ii) B1 (diff-at-assembly) vs B2 (kernel notify). This is a new feature, not
  a bugfix - worth its own plan/commit rather than rushing in a compaction boundary.

--------------------------------------------------------------------------------
7. HOW TO VALIDATE / RUN AFTER RESUME
--------------------------------------------------------------------------------
- Tests: cd /home/jfgrissom/Repos/prime-agent-fork && node_modules/.bin/tsgo --noEmit
  (root typecheck) then packages/coding-agent `node_modules/.bin/vitest run test/<file>`.
- Fork is buildable/runnable: `npm run build` under packages/{tui,ai,agent,coding-agent}; the
  coding-agent dist/bundle/cli.js runs (`--version` -> 0.9.3).
- Kermit is a CLEAN test host (node 22, NO pre-existing prime-agent, local canti + kermit model
  endpoints reachable). To smoke-test: rsync the fork to kermit:/home/jfgrissom/... , point
  PRIME_AGENT_CODING_AGENT_DIR at a temp agent dir with models.json for canti, run
  `--print --no-session --provider canti --model canti-qwen3.6-35B-A3B-Q5_K_M-moe`.
  NOTE: statler is reserved by the user - use Canti for model traffic.
- Local daemon collision: the live 0.9.3 owns the host-wide socket /tmp/prime-agent-<uid>/daemon.sock.
  Use --no-session (single-process) or test on Kermit, NOT beside the live instance.
- Multi-turn cache monitor (Canti) already demonstrated cache-lean: cached_tokens ramp
  (turn2->0,3->59,4->84,5->105,6->125) with miss staying ~constant (~50/turn).

--------------------------------------------------------------------------------
8. MISCELLANEOUS / BEHAVIORAL FRAGMENTS
--------------------------------------------------------------------------------
- Earlier DeepSeek/Gemini cost analysis concluded the burn was client-side context instability
  (system-prompt rebuild/changing head), NOT provider misbilling. plan-v4 fixes the stable-head side.
- Root tsgo: run from repo root (the coding-agent pkg has no plain tsconfig - only build/examples).
- Review workers: use Canti for arch; Statler is slow + currently reserved by the user (do NOT spawn
  Statler). Scooter is down.
- The fork's ai package build regenerates models.generated.ts from live catalogs; revert that file
  after a build if you don't want catalog diffs committed.
- Untracked in worktree: docs/design/cache-stable-continual-harness.md (spec) - consider committing.
================================================================================
HEAD note: 10c8c82 is the authoritative live ref (see section 1). Plan v4 is complete; section 6
(Mechanism B) is the open design item. Before resuming, `git -C ~/Repos/prime-agent-fork rev-parse HEAD`.
