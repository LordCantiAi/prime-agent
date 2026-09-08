# Mechanism A — side-effects analysis (D1/D2/D3)

Date: 2026-09-08 · Follow-up to design-mechanism-A-auto-refine-cadence.md
Purpose: "measure twice, cut once" — trace each recommended decision's cascading effects BEFORE
committing, using VERIFIED code (not assumptions). Companion of the plan doc; both are inputs to sign-off.

## Verified ground truth (read from code before analysis)
- TWO parallel schedulers emit interval auto-refine:
  * interactive + daemon:  _scheduleAutoRefineAfterAgentEnd -> _scheduleAutoRefine (setTimeout 0) ->
    _maybeAutoRefine -> _reviewAutoRefine -> _runApprovedRefine -> this.refine({trigger:"auto"}).
    Fired at agent_end call sites ~3826/7993/8019. Timer-based (fire-and-forget via _autoRefineOperations).
  * print/json/rpc (main.ts:705 sets serializedRefine = appMode!=='interactive'&&!=='daemon'):
    _maybeStartSerializedBackgroundPlan (at assistant message_end, ~3754) -> _runBackgroundPlan.
    Plan applied at _shouldStopAfterTurn boundary (~2328). Overlaps planning with tools, never a model req.
  BOTH gated by _autoRefineAllowedForSession() = (_rlmDepth===0 && _localHarnessStateDir()!==undefined).
- Default interval review MODEL CALL is real and unavoidable unless host supplies autoRefineReviewer:
  _reviewAutoRefine() when this._autoRefineReviewer undefined falls through to reviewAutoRefine() in
  refinement.ts which does completeWithProviderRetry(...) — a SECOND model request with its OWN
  AUTO_REFINE_REVIEW_SYSTEM_PROMPT (NOT the main system prompt => unaffected by cache-stability), reading
  last 40k chars of conversation + merged harness overview + history. autoRefineReviewer is NEVER set by
  main.ts / sdk.ts / worker wiring today — it is purely host-injectable (per-session config only).
- turnInterval already clamps >=1; turnInterval=1 is broadly exercised in existing tests with cooldownMs:0.
- Cooldown stamps _lastAutoRefineReviewAt = Date.now() after apply / decline / review-fail / RefineSkipped
  (default 20min). A review DECLINE also RESETS _assistantTurnsSinceAutoRefine=0 (line ~8171).
- Concurrency guards: _autoRefineInProgress, _autoRefineOperations (set), _refineInFlight,
  _pendingAutoRefineReview{reason,review}, _turnIntervalAutoRefinePending/_compactAutoRefinePending,
  _serializedPlanInFlight, _refinePlanInFlight, _scheduledAutoRefineTimers, branch versions
  (_autoRefineBranchVersion) invalidating stale plan/review/apply. _shouldSkipAutoRefineForActiveAgent =
  isStreaming || isCompacting. _scheduleDeferredAutoRefineIfIdle retries deferred after stream/compact.
- Refine apply only flags _refineInFlight (blocks turn ENTRY via _waitForRefineIdle), NEVER agent.abort;
  planning backgrounded. apply phase = disk I/O + in-memory; _rebuildSystemPrompt runs after apply but
  harness state is NOT in it (plan v4) => system-prompt bytes unchanged by a refine (cache head stable).
- my plan-v4 per-refinement harness_delta is emitted in _recordRefinementOutcome, reached by the SHARED
  apply used by BOTH schedulers => any cadence-driven edit that applies gets the delta. No separate hook.
==================================================================================================

## D1 — Deterministic vs candidate cadence
RECOMMENDED: A-suggest baseline + turnInterval=1 honored + route "must persist every single turn"
to Mechanism B. Analyze effects of choosing A-suggest first.

### D1a. A-suggest consequences (already largely the current behavior)
1) Behavior parity / LOW RISK: A-suggest ≈ existing interval auto-refine. Today, when enabled and
   turnInterval reached: review runs; if review.shouldRefine=false -> NOTHING applied that turn (decline
   also resets _assistantTurnsSinceAutoRefine=0 and stamps cooldown). So the ONLY change A-suggest
   introduces is guaranteeing the cadence is ARMABLE/cheap and visible + turnInterval honored + tests.
   No new review/apply path is added => the whole surface of concurrency/cooldown above is UNCHANGED.
2) Guarantee semantics MUST be stated honestly (side-effect of labeling): if we tell ops/model "state
   change each turn," a decline means none happens. Risk = user/agent expectation mismatch. Mitigate by
   (a) docs calling it "candidate, review-gated", (b) counting a DECLINE as meeting cadence (it consumed
   the opportunity) — which today already resets the turn counter, so T2 can assert that; no code change.
3) No latency regression on the main turn: interactive path is timer-0 fire-and-forget after agent_end;
   serialized path overlaps planning with tool execution and only awaits apply at shouldStopAfterTurn
   (apply = disk/in-memory microtask, plus _recordRefinementOutcome -> prepend/arm already).
   CAVEAT: the apply at shouldStopAfterTurn DOES run _rebuildSystemPrompt + possibly arm/prepend logic;
   it is not customer-perceived latency but DOES add a bounded microtask before "mayContinue?" — existing
   behavior, unchanged by A-suggest. No new risk.
4) Interaction with compaction: compact auto-refine shares the turn_interval counter. If turnInterval=1,
   a compact auto-refine that runs ALSO satisfies interval cadence (counter resets). No double.
5) Regression surface: existing suites (serialized-refine 2605 lines, compaction 1578, queue 3625)
   extensively pin enabled/turnInterval(1/25/999)/cooldown/reviewer-mock semantics. A-suggest must NOT
   alter default `enabled ?? true`, the `!settings.enabled` short-circuit, or cooldown stamping, else
   dozens of assertions break. Keep A-suggest = additive guarantee + tests ONLY.

### D1b. If instead A-deterministic (force a refine every due turn ignoring review)
Effects/changes (NOT recommended as the A default):
1) Would require bypassing review.shouldRefine => new branch around ~8165 (decline) so a forced reason
   still plans+applies. That branch today does decline bookkeeping (reset turn count + stamp cooldown);
   skipping it must still reset the counter or turnInterval=1 would re-arm immediately -> risk of a
   tight self-re-scheduling loop via _scheduleDeferredAutoRefineIfIdle after every apply. HIGH attention.
2) A forced refine each turn ALWAYS calls plan (LLM) -> extra per-turn cost proportional to plan+apply.
   With no review that's 1 extra model request/turn (plan), sometimes 2 (if plan then apply is same
   request? -- no, plan is a model call; apply applies the returned plan). So deterministic = +1 LLM
   request per turn minimum on the serialized path. At turnInterval=1 that is effectively doubling model
   traffic vs A-suggest when review declines. Not "cheap."
3) The deferred retry surface (_scheduleDeferredAutoRefineIfIdle) + _pendingAutoRefineReview already
   encode "opportunistic, retry-if-busy." Forcing could fight isStreaming/isCompacting deferrals and
   cause a backlog of forced refinements queued behind tool/compact. Would need a bounded-quota guard.
4) Forced refine writes only if there IS an edit proposal; a no-op still consumes a look-ahead. The
   delta only appears on an APPLIED edit. So even deterministic does NOT strictly give "a delta every
   turn" unless the plan returns an edit each time. => deterministic is worse than it sounds for the
   literal goal; Mechanism B (explicit write) is the correct deterministic vehicle.
CONCLUSION(D1): A-suggest recommended; it is near-zero-risk/additive and matches existing review-gated
semantics, and it cleanly delegates the strict guarantee to Mechanism B. A-known-side-effect: labeling
must not overpromise "delta every turn". Accept.

## D2 — Reviewer on/off (extra model call per cadence)
RECOMMENDED: make reviewer OPTIONAL/disableable; when disabled, cadence plans directly (skip review)
like explicit refine.run(skipReview=true). Analyze:
1) What "reviewer disabled" means concretely today: there is no setting; _autoRefineReviewer is only
   host-injectable per session. To disable by SETTING we must add a config/settings signal (e.g.,
   autoRefine.reviewer: "model"|"off"|autoRefineReviewer fn override) OR thread keep autoRefineReviewer
   injection + add settings.reviewMode. Which one has fewer effects? SEE 4.
2) Side effect of SKIPPING review: today decline stamps cooldown + resets turn counter (avoids hot-loop of
   re-review every turn). If we skip review and go straight to plan each due turn, we LOSE the cooldown/
   throttle that decline provided. Consequences:
   * At turnInterval default 25: negligible (auto-refine every 25 turns regardless).
   * At turnInterval=1 + reviewer off: we could auto-schedule a plan EVERY turn with only cooldown as a
     backstop => if cooldownMs left at 20min default, after the FIRST success it would NOT fire again for
     20min even though we "asked every turn." That would silently defeat "every turn." MUST reconcile
     default cooldown for reviewer-off+turnInterval=1 (either drop cooldown when reviewer off, or make
     explicit in docs that cadence is now governed by cooldown too). This is the #1 subtle D2 gotcha.
   * _assistantTurnsSinceAutoRefine reset after apply makes the turnInterval check pass again next turn,
     good; but ensure a skip-with-no-edit path STILL resets counter (else re-entry).
3) Cache side-effect of the review call: the review uses its OWN AUTO_REFINE_REVIEW_SYSTEM_PROMPT and a
   conversation-snapshot user message (last 40k) — provider-cache stable across cadences if the review
   prompt is constant and the 40k window stable; but when the conversation GROWS past 40k the LAST 40k
   chars CHURN each turn (rolling window) => review call may be cache-MISS-y and could be sizable. Turning
   the reviewer off entirely REMOVES that recurring model call and its cache churn => strictly less cost
   and no behavioral downside when the operator wants autonomous cheap cadence. Good.
   IMPORTANT: plan v4's cache-lean promise applies to the MAIN model request. The review is a SEPARATE
   request and is NOT part of plan v4's guarantee; but for an "on by default + cheap" cadence, a per-turn
   cache-churny review at turnInterval=1 would be a real cost — be explicit that reviewer-off removes it.
4) Wiring options / effects:
   (a) Add settings.autoRefine.reviewer:'off' consumed in getAutoRefineSettings + session check near the
        review call: smallest, no new types ripple, but host can't supply a FN via settings JSON (settings
        are serializable). Keep fn override via existing config autoRefineReviewer (host). TWO sources is
        a minor confusion risk; document precedence (host fn > settings 'on'/'off').
   (b) Only host fn: least surface, but then "disable reviewer" needs the host to pass an always-true fn
        (custom shim) => that's exactly the "injectable host hook" philosophy the user already endorsed
        for B, and it AVOIDS adding a settings field. RECOMMEND (b) OR (a) where default = reviewer ON
        (model) — preserving current cost until an operator opts into reviewer-off. Choose explicit:
        default reviewer ON (unchanged behavior => no surprise cost), opt-in reviewer OFF for cheap
        cadence. SIDE-EFFECT: because default stays ON-with-review, "turnInterval=1 default-on" alone
        would still add a model review each turn in stock config => recommend shipping default interval
        25 and DEFAULTING reviewer ON, and let "every-turn + cheap" be chosen together (turnInterval:1 +
        reviewer off). This is the honest default-on story.
CONCLUSION(D2): Make reviewer disable-able; DEFAULT it ON (avoid cost surprise); cooldown logic MUST be
reconciled for reviewer-off+turnInterval=1 so it doesn't silently throttle the cadence; reviewer-off
removes a recurring cache-churn model call. Implement via host fn override (existing seam) and/or a
settings reviewer:'off' — document precedence precisely and add tests T for both.

## D3 — Where default-on applies (depth-0 + local harness only)
RECOMMENDED: default-on = a normal top-level local-harness session; confirm no mode surprise.
Effects:
1) _autoRefineAllowedForSession() = _rlmDepth===0 && local harness dir != undefined. This ALREADY auto-
   disables interval auto-refine for: every rlm subagent (depth>0) and any session lacking a local
   harness dir (e.g., stateless print? need to confirm print gets a local harness dir).
   ACTION: confirm whether the fork's harness-v4 model path provides _localHarnessStateDir() in
   print/--no-session (smoke used a temp agent-dir with settings+models but NO harness_state.json yet).
   If a single --no-session print makes NO harness dir, then auto-refine simply never arms there
   (fine). If print DOES make one, turn_interval could auto-refine on a single-throwaway prompt (harmless
   but = a pointless model call at the very end). This is worth a quick empirical check before shipping.
2) Mode parity: daemon = _rlmDepth 0? need to confirm daemon worker depth. serializedRefine=true for
   print/json/rpc; main.ts:705. No effect on D3 which keys off depth + harness-dir, not serialized flag.
3) A "default-on" caption must map to reality: interval auto-refine stays OFF for rlm children (depth>0)
   and headless-without-local-harness. That is consistent with "normal interactive/x top-level session."
   If a user runs ONLY headless print/autonomous pipelines (common for cadence use), those are depth-0 and
   WILL get canti/cadence IF they have a local harness dir. So "default-on" effectively lands on print
   autonomous runs too (provided harness dir) — which is exactly where they'd want per-run cadence. Good,
   but adds a possible END-of-run stray auto-refine call if a single print is at turn>=interval before
   teardown; plan-v4 change doesn't alter this, but cadence docs should mention it.
4) Compaction interplay: post-compaction auto-refine (compact path + _settlePostCompactionContinue) also
   guarded by allowed-session; safe.
CONCLUSION(D3): Keep the depth-0+harness-dir gate (it is correct). Empirically confirm whether print/
--no-session creates a local harness dir and whether a single shot arms a stray auto-refine; if yes,
consider gating cadence on "session will continue" or a minimum expected-turn flag, but keep MINIMAL.
Default-on wording = "any depth-0 session that has a persisted local harness store."

================================================================================
AGGREGATED RISK TABLE (accept / mitigate / gate)
----------------------------------------------------------------
| Risk | from D | Severity | Handling |
| over-label 'delta every turn' when review can decline | D1 | medium | docs 'candidate'; count decline as cadence met; defer strict to B |
| forced cadence creates self re-scheduling loop / backlog | D1 (if deterministic) | high | reject deterministic as A default; route to B |
| reviewer off + turnInterval=1 + 20m cooldown silently throttles | D2 | HIGH gotcha | coalesce: drop/ignore cooldown when reviewer off OR set explicit; test |
| reviewer off removes recurring cache-churn review call (good) | D2 | - | makes cheap cadence feasible; document |
| two mechanisms (settings.reviewer vs host fn override) confuse | D2 | low-med | pick ONE canonical, document precedence |
| default reviewer ON keeps current cost (review model call) at turnInterval=1 | D2 | medium (bearable) | default interval 25 + reviewer ON; pair '1' w/ reviewer-off |
| stray end-of-run auto-refine in single shot print if harness dir exists | D3 | low | empirical check; maybe gate on continues/session expected turns |
| regression against ~existing suites pinning enabled/turnInterval/cooldown | D1 | medium | A-suggest additive only; run full relevant suites pre/post |
| rlm children (depth>0) never cadence (by design) | D3 | - | acceptable; B covers explicit per-turn in children via host hook |
================================================================================
RECOMMENDED COMMIT SCOPE after this analysis resolves cleanly:
A-suggest (candidate), reviewer optional-default-ON with a single canonical off switch + cooldown fix,
depth-0+harness-dir gate unchanged, additive tests T1-T5 + the cooldown-at-reviewer-off test + a print
single-shot empirical check. Deterministic per-turn guaranteed writes stay in Mechanism B (host hook).
Store this analysis alongside the plan: docs/design/design-mechanism-A-auto-refine-cadence.md (plan),
and docs/design/analysis-mechanism-A-side-effects.md (this). Then implement under TDD and keep the
~450 existing suite tests + plan-v4 gates green.

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
