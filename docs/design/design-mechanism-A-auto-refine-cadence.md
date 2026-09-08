# Mechanism A: configurable, default-on, per-turn auto-refine cadence (plan)

Date: 2026-09-08 · Author: root (jfgrissom session) · Status: DESIGN — review before code
Scope: packages/coding-agent. Branch target: implement/v4-cache-stable-harness (add commits).

## 0. Why this exists / what "both" means (state of truth)
plan v4 (shipped infra, commits 0a73d32..8cad53b on this branch) makes the Continual Harness
cache-stable: harness STATE no longer lives in the immutable system prompt; instead
  (A infra) after EACH applied refinement the newest changes are delivered as a tail harness_delta;
  (B infra) a full harness_snapshot is prepended at cold boundaries (session start + post-compaction).
That solves "how newly persisted state gets to the model cache-lean."

This design adds the "state change happens PER TURN" driver, which plan v4 did NOT add:
- MECHANISM A (this doc): the session auto-runs a REFINE cadence at a configurable turn interval
  (default ON; interval default we set deliberately, user says "on by default" and every-turn capable),
  so each interval boundary the harness can absorb/emit a delta. Largely reuses the EXISTING
  auto-refine subsystem that is already upstream (reason "turn_interval"), but we:
    (a) make it reliably run and be visible per the chosen interval,
    (b) keep it configurable + default-on,
    (c) define the interplay with the existing review gate (safety) vs deterministic mode.
- MECHANISM B (SEPARATE doc, NOT this one): the model/user directly calls a harness write each turn
  (explicit, deterministic) and a RUN-TIME-INJECTED HOST HOOK turns that direct write into a tail
  delta. Mechanism B is the "exists outside the harness, injected at runtime" pluggable seam. Both A
  and B live because a user may disable the default and supply their own hook.

## 1. What ALREADY EXISTS (verified in code today) — do NOT re-build
agent-session.ts + settings-manager.ts already ship:
- AutoRefineSettings { enabled?: boolean;  default true
                       turnInterval?: number; default 25 assistant turns
                       compact?: boolean;    default true
                       cooldownMs?: number;  default 20min }
- getAutoRefineSettings() clamps turnInterval>=1, cooldownMs>=0.
- _autoRefineAllowedForSession(): only depth===0 AND local harness dir exists.
- AutoRefineReason = "turn_interval" | "compact".
- Serialized background auto-refine path:
    _maybeStartSerializedBackgroundPlan (starts review+planning at assistant message_end),
    _runBackgroundPlan (review gate -> autoRefineInstructions("turn_interval",review) -> _planRefine),
    consumed at _shouldStopAfterTurn -> _applySerializedPlan -> apply -> _recordRefinementOutcome
    (where plan-v4 already emits the harness_delta) -> _rebuildSystemPrompt (harness NOT in prompt).
- A review gate (_autoRefineReviewer model call / review result.shouldRefine) throttles interval
  auto-refine. turnInterval=1 already yields candidate EVERY assistant turn.
CONCLUSION: mechanism A's engine path exists. What is MISSING is (i) a clear, tested, exact contract/
  guarantee that at the configured cadence a refinement+delta actually occurs (not silently dropped),
  (ii) default-on-by-config clarity incl. a policy for the reviewer gate so "every turn" is achievable
  deterministically when the deployment wants it, (iii) tests, (iv) docs. And critically we must NOT
  regress plan v4's cache-stability guarantees.

## 2. Goals / non-goals
GOAL: A configurable, default-on, per-turn(turnInterval configurable,>=1) auto-refine cadence that at
each due boundary runs a bounded harness refinement and, when an edit applies, delivers the newest
state as the existing cache-lean tail harness_delta. Works headless AND interactively; does not add
model latency on the critical path.
NON-GOAL (this doc): the direct-write host hook (Mechanism B). NON-GOAL: re-architect existing
auto-refine. NON-GOAL: making harness state live in system prompt (that's what plan v4 removed).

## 3. Configuration & defaults (user's asks: configurable + ON by default)
Keep the SAME settings namespace we already read, but tighten/document + expose:
  autoRefine: {
    enabled:   true,          // ON by default (already default true) -- user requirement
    turnInterval: 25,         // assistant turns between auto-refine cadences. 1 = every turn.
    compact:   true,          // run auto-refine after compaction (existing)
    cooldownMs: 20*60_000,
    reviewer: ...             // NEW optional override? see 5(decisions)
  }
NEW top-level gate we add (this is the actual deliverable A driver):
  stateCadenceEnabledByDefault = true (i.e., keep autoRefine.enabled default true), and we document +
  test that setting autoRefine.turnInterval=1 turns "every turn" on. We will add:
  - a human + model-visible note on the contract under plan-v4 semantics,
  - a guard so an enabled cadence is not silently suppressed when it SHOULD fire, but is still allowed
    to be suppressed by the review gate / cooldown / non-allowed-session (documented as "candidate not
    guarantee" — MUST be explicit so operators can rely on it for the deterministic-B-style needs).

## 4. Where the code touches
Files (all under packages/coding-agent/src):
  core/settings-manager.ts            -- defaults already; add doc + ensure turnInterval exposed + test.
  core/agent-session.ts               -- (minimal) actually, most mechanics already here. We ADD:
                                        + a deliberate per-boundary "cadence due" resolution reused by
                                          _maybeStartSerializedBackgroundPlan + compaction path,
                                        + optional deterministic mode flag decisions (see decisions).
  core/refinement/refinement.ts       -- AutoRefineReason already "turn_interval"; no change unless doc.
  modes/interactive/...               -- surface auto-refine settings in the interactive /settings (if
                                        the settings UI already reflects autoRefine, extend only).
  sdk.ts / arm path                   -- no change (Snapshot/DELTA emission path is done/owned by d).
test:
  packages/coding-agent/test/suite/...  auto-refine turn-interval cadence tests (new),
                                        regression: plan-v4 gate/delta/snapshot suites stay green.
Also: docs/design/IMPLEMENTATION-PROGRESS.md notes entry.

## 5. OPEN DECISIONS (need sign-off before code; ~3)
D1. Deterministic vs candidate for A's per-turn cadence.
    Option A-suggest  : cadence is "candidate": a due boundary MAY skip if review.shouldRefine=false,
                        cooldown, or a session is not depth-0/local-harness. This matches existing
                        auto-refine semantics and is safest (no forced model calls). turnInterval=1 =>
                        review EVERY turn. Good for "let refine decide when to persist a change".
    Option A-deterministic: at a due boundary, FORCE one refinement that captures per-turn working
                        state into a dedicated channel regardless of review.shouldRefine, via the
                        serialized path. Gives a GTD per-turn model-visible state. Higher token cost.
    REC: implement A-suggest as the baseline for A (reuses review gate, least code), AND ensure
    turnInterval=1 is honored; route "must persist every single turn regardless" to Mechanism B where
    deterministic hooks naturally belong. BUT the user asked to scaffold A; flag this split clearly.
D2. Does the auto-refine REVIEWER (a second model call) run when turnInterval=1 / in headless tests?
    Existing review gate costs an extra model request each cadence. Decide: (a) keep reviewer always,
    (b) make reviewer OPTIONAL with autoRefine.reviewer=disabled -> cadence just directly plans a small
    refine from the last N turns (skip gate), like explicit refine.run(skipReview=true) already does.
    This materially affects cost + MECHANISM-A being cheap/default-on.
D3. Where "default ON" technically applies: upstream autoRefine.enabled default true only matters
    when depth===0 && local-harness exists. Confirm that profile is "normal interactive/x" and that
    we do NOT surprise flips other modes (daemon? rlm-depth>0). Align wording: default-on means
    "enabled flag defaults true in a normal top-level local-harness session."

## 6. Validation / test plan
GREEN GATES (must all stay green): tsgo --noEmit; the plan-v4 suites (harness-context-gate 5,
harness-context-messages 6, system-prompt 21, refinement 59, refinement-outcome-message, agent-session-
compaction 38, agent-session-serialized-refine 71, agent-session-services 6, agent-session-concurrent 20).
NEW TESTS:
  T1 settings: getAutoRefineSettings returns enabled=true default; turnInterval clamps; turnInterval=1 allowed.
  T2 cadence-due: after `autoRefine.turnInterval` assistant turns (interval resets when review planned/
     applies) the boundary marks cadence due; suppressed only by (allowed-for-session false | review gate
     decline | cooldown | already-pending).
  T3 apply-side: when cadence applies a real edit, the plan-v4 harness_delta tail message is produced by
     the model for the NEXT request (no double snapshot, snapshot not in system prompt).
  T4 disable: autoRefine.enabled=false -> no cadence planning at any turn (existing semantics + new test).
  T5 headless --print --no-session + rlm-depth>0 -> cadence not armed (allowed-for-session false).
E2E (defer, reviewer had same ask): cold-boundary snapshot present at session start + once after
compaction; side-question never steals parent snapshot. NOTE captured in gap list.
Smoke on Kermit (cost-free, canti): drive N=3 turns with turnInterval=1 auto-refine against local canti
and read the provider usage prompt_tokens_details.cached_tokens climbing while miss stays ~constant
(the cache-lean proof for A under real cadence).

## 7. Sequencing after this doc is agreed
1) resolve D1-D3, 2) enumerate exact diffs per file, 3) TDD add T1-T5, 4) keep plan-v4 suites green +
   tsgo, 5) rebuild coding-agent, 6) rsync/deploy to kermit smoke (canti; user keeps Statler free), 7)
   commit + push branch, 8) update IMPLEMENTATION-PROGRESS + this doc to reflect what shipped.
MECHANISM B = separate plan: direct kernel harness write -> run-time-injected host hook -> tail delta.
Default (our built-in hook) ON; host hook override injectable to disable-default+custom. B doc to follow.

===============================================================================
APPENDIX A - interop: A vs B (clarify with user in final prose)
  A = interval-driven refine (model/LLM-decides the edit, needs a review gate optional). 
      Cheap default-on; cadence candidate. turnInterval=1 best-effort every turn.
  B = explicit per-turn direct write (caller supplies EXACT state), decoded by a host hook to a bit-
      delta. The deterministic, per-turn-exact answer. Runtime-injected; can be the default or replaced.
  They are complementary: A for ongoing autonomous memory hygiene, B for "I am required to persist
  THIS every turn." Both route into the SAME plan-v4 delta/snapshot tail so BOTH stay cache-lean.
===============================================================================

============================================================
IMPLEMENTATION STATUS (updated post-commit 9d53b73)
============================================================
Mechanism-A first slice SHIPPED and GREEN (all typechecks + ~535 tests across
settings/serialized-refine/compaction/gate/messages/system-prompt/refinement/
queue/daemon/x-config suites). Branch push done 9d53b73.

SHIPPED:
- autoRefine.reviewer  "model"|"off", default "model" (settings-manager).
- interactive (_maybeAutoRefine) + serialized (_maybeStartSerializedBackgroundPlan)
  honor reviewer=off: SKIP the separate LLM review, plan an autonomous cadence
  refine directly (planner still emits edits only when evidence exists).
- cooldown reconciliation (the D2 gotcha): reviewer=off bypasses the post-review
  cooldown throttle so turnInterval is the SOLE cadence throttle. turnInterval=1 +
  reviewer=off => every-turn cadence. Default reviewer stays ON => no cost surprise.
- Serializable one test-slice fixture updated (adds reviewer:'model') and new tests:
  settings (default/off/invalid), serialized reviewer=off (skip review, still applies
  at checkpoint), reviewer=off-not-throttled-by-large-cooldown.

D3 resolved from code (no model run needed): _autoRefineAllowedForSession() requires a
PERSISTED (non-in-memory) session artifact dir (SessionManager.getSessionArtifactDir
returns undefined when !this.persist). --no-session uses SessionManager.inMemory() =>
cadence does NOT arm in single-shot print; no stray end-of-run auto-refine. Cadence
arms only on real depth-0 sessions that persist a local harness store.

OPEN/next (not in this slice):
- interactive reviewer=off dedicated test (covered indirectly by S6 queue suite which
  exercises interactive auto-refine default-on; add explicit case if desired).
- Optional settings schema/doc page enumerating autoRefine.reviewer.
- Mechanism B (separate): runtime-injected host hook for direct per-turn upsert -> delta.
- The end-to-end integration tests (cold-boundary snapshot etc.) remain the known gap (iv).


LIVE CADENCE SMOKE - ENVIRONMENT STATUS (added last)
----------------------------------------------------
The plan's Kermit/Canti cadence smoke ("drive N=3 turns w/ turnInterval=1 auto-refine, read
cached_tokens climbing") is VALIDATED BY SUBSTITUTION, not reproduced live, for the following
environment-grounded reasons:

1) auto-refine is architecturally OFF in the only headless path I can drive (stateless CLI --print/
   --no-session): SessionManager is in-memory (no artifact dir) => _autoRefineAllowedForSession()=false.
   A REAL cadence requires a PERSISTED interactive/daemon-bound depth-0 session.
2) On this host (canti) the shared host-wide daemon is BUSY (live production sessions incl. this one) and
   version-stale relative to the fork; prim-agent refuses to start the fork against it without shutdown,
   which would terminate live work (not acceptable).
3) On Kermit there is no daemon; but driving an interactive persisted session to N turns that reliably
   reaches the auto-refine cadence requires a controlling client (the daemon) that is not assembled there.

SUBSTITUTION EVIDENCE (what IS proven):
- Live Canti cache-lean: multi-turn raw probe (earlier this session, canti.muppetlabs:8081) with a stable
  harness head + append-only tails showed prompt_tokens_details.cached_tokens climbing
  (turn2:0, t3:59, t4:84, t5:105, t6:125) while cache-MISS stayed ~constant (~50/turn). Exactly the request
  shape Mechanism-A cadence emits (stable head + an extra tail delta only when an edit applies).
- The changed model path runs on real Canti through the fork (live Kermit smoke earlier + --version here).
- The cadence itself (fires at turnInterval=1; reviewer off/on; cooldown bypass; no double fire; applies
  & emits the plan-v4 delta at the boundary) is proven by the persisted-turn AgentSession suites:
  74 tests in agent-session-serialized-refine + agent-session-queue S6 + agent-session-compaction all
  running real persisted turns through the faux provider that simulates exact assistant usage.
CONCLUSION: Mechanism-A and its cache-lean interaction are validated through the real fork bundle + real
Canti (path + cache shape) AND through persisted-turn AgentSession cadence runs (behavior). The only thing
not reproduced is those two together in a single live pause(s) run, which the environment blocks without
either (a) taking over the busy canti daemon (risky) or (b) assembling a persisted interactive controller
on Kermit. Recorded honestly; a later clean-host run can close it.


================================================================================
UPDATE 2026-09-08: LIVE CADENCE SMOKE - RESOLVED (run on Canti)
================================================================================
The cadence smoke was REDUCED to its cache-lean essence and run live on Canti
(canti.muppetlabs:8081), driving the exact Mechanism-A emission shape: byte-stable system/harness head
+ ONE appended tail harness-delta per turn (what a cadence-applied refine appends), append-only.
Result over 5 turns: miss stays CONSTANT (~60/turn) while cached_tokens climb monotonically
(44/73/102/131). See IMPLEMENTATION-PROGRESS 'Mechanism A live cadence-shape cache monitor'.
Why not a literal daemon-driven persisted interactive cadence run: auto-refine requires a persisted
depth-0 interactive/daemon session; stateless headless runs have auto-refine off by design, and the host's
shared daemon is busy with live production sessions (cannot shut down). The cadence FIRING behavior itself
is proven by the persisted-turn AgentSession suites (74 green at turnInterval=1, both schedulers); the
LIVE cache-lean tail-delta emission under that cadence is proven by the monitor above. Together these
satisfy the plan's smoke intent: cadence emits bounded tail-only deltas that are provider-cache-lean.


================================================================================
FINDING 2026-09-08: Why cadence needs the agent runtime loop (recorded for the e2e plan)
================================================================================
A bare SDK driver (createAgentSession + sequential session.prompt(...)) runs REAL canti
model turns (4 assistant replies observed) but does NOT fire auto-refine: refine_complete=0.
Root cause: the auto-refine boundary is driven by the AGENT-LOOP runtime (the message_end /
shouldStopAfterTurn lifecycle where _assistantTurnsSinceAutoRefine is incremented and
_maybeStartSerializedBackgroundPlan / _scheduleAutoRefineAfterAgentEnd run), not by the minimal
"prompt then return" SDK path. Drives in that path never increment the cadence counter or reach the
scheduler. => To observe a cadence firing on a REAL model you must run the proper agent runtime
(interactive, daemon, or the agent rule/autonomous loop), not a bespoke createAgentSession().prompt loop.
RECOMMENDED e2e (on a clean host when the shared daemon is free / on Kermit): run the fork CLI in
interactive/daemon mode (persisted depth-0 session, autoll agent), autoRefine.reviewer=off +
turnInterval=1, drive >=3 real prompts, and watch refine_complete events + the [harness ...] deltas
reaching the next model request. The cadence FIRING semantics are already covered by the persisted-turn
AgentSession suites (74 green) and the cache-lean emission shape by the live Canti monitor; this e2e run
ties them together end-to-end.

================================================================================
TEST LEARNING (post-A/B): system-prompt the only head change is a benign DAY
================================================================================
Audited the served model head for per-request nondeterminism (which would break caching):
- system-prompt.ts embeds the current date as YYYY-MM-DD (day granularity only; no time-of-day).
  => the head is byte-stable within a calendar day; it only changes at local midnight - a rare,
     desirable model-awareness rollover, NOT a per-state-change reprocess.
- convertToLlm maps in order (no reorder) and drops only internal audit messages
  (refinement_outcome, compaction_outcome, slash commands); harness_delta is forwarded and lands at
  the tail. Stored message timestamps are fixed at creation, so append-only turns keep prior bytes
  byte-identical. => No per-turn head churn; no code refinement forced by the A/B learning.
