# Cache-Stable Continual Harness Context

Status: DESIGN v4 (settled) / review before implementation
Repo: prime-agent (fork branch `harness-context-delta`)

-------------------------------------------------------------------------
## The model (approved)

IMMUTABLE LOG + APPEND-ONLY TAIL. Full current state is delivered ONLY at the two real cold
boundaries (session start, post-compaction). Everything else in the log never changes; state changes
during normal flow are introduced only as NEW bytes in the TAIL of the next payload to the provider.

-------------------------------------------------------------------------
## Invariants

- I1 IMMUTABLE LOG: once a model payload has been served, its entire context (system prompt + every
  message from the current cold-boundary onward) is immutable. It is never rewritten, dropped, edited,
  or re-sent differently - even to correct/override something in it.
- I2 FULL STATE AT COLD BOUNDARIES ONLY: a full "current Continual Harness State" snapshot is delivered
  exactly when a context boundary is (re)established:
     * session start
     * post-compaction
  The snapshot rides ON THE POST-COMPACTION HEAD (agreed: 3 votes - reviewer twice + author). Because
  compaction restarts/compresses context, carrying the authoritative harness in the post-compaction
  head resets the model's anchor cleanly rather than only in a later delta. (Matches upstream #2098's
  harnessDigest-on-compaction proposal.)
- I3 APPEND-ONLY TAIL FOR CHANGES (normal flow): between boundaries, any harness change (create /
  update / delete / rollback) reaches the model ONLY as new bytes appended to the tail of the next model
  payload, per recency. It becomes part of the immutable log the moment that payload is served and is
  never touched again.
- I4 CACHE LEAN: humans/agents may always lean on provider prefix cache for the immutable log. Cost grows
  only by the genuinely NEW tail bytes first introduced in a payload. Nothing already sent is ever
  re-transmitted (beyond the provider's cache read of the unchanged prefix).

-------------------------------------------------------------------------
## What is sent, when

A) SESSION START -> emit the full current harness snapshot (as a model-visible context line).
B) POST-COMPACTION -> re-emit the full current harness snapshot (context restarts at the boundary).
C) BETWEEN BOUNDARIES, when a harness entry changes:
     the change is captured as a self-describing TAIL line (new bytes). It is not retro-fitted anywhere.
     * create/update  -> line carries the entry's current value/content.
     * delete / rollback-to-none -> line carries a removal/override marker (see format below), because
       there is NO concrete current value for recency to lean on; explicit removal signal is required.
     * rollback-to-a-prior-value that still exists -> treated as UPDATE (emit the value it reverted
       TO); recency carries it - no marker needed.
     * coalesce: if several changes accrue before the next payload, send one line per affected entry
       with its CURRENT value (net), not a per-event replay.
D) NO harness change in a payload window -> no extra tail harness bytes -> prefix stays perfectly stable.

-------------------------------------------------------------------------


## Delta line format and override semantics (decision)

UPDATE / CREATE (incl. rollback-to-a-value that still exists):
  The NEW value IS the override signal. Short line:
      [harness] <kind> "<title/id>" = <current value>
  Recency makes the model use "B" over the earlier "A"; the value is present so it cannot read as a stray
  note. No extra "ignore earlier" marker needed.

DELETE / ROLLBACK-TO-NONE (no current value exists):
  Recency has nothing to lean on, so an explicit removal marker is REQUIRED - otherwise the model may keep
  trusting the value it saw earlier. Do NOT restate the full prior value unless the entry is material (the
  model may have begun relying on it); for material entries keep a short form:
      [harness] <kind> "<title/id>" no longer valid (removed)
      ... or, only when material: ... no longer valid (was: <short prior>)
  The marker names the entry + states the op, so the model can identify WHAT is being superseded.

RATIONALE: update and delete are asymmetric. For an update, the newest line carries the value recency
needs. For a delete there is no newest value, so we must signal the removal explicitly. Short form is safe
for update, not reliably safe for delete.


## Why this is correct (and cheap)

- Recency: newest tail line is authoritative over earlier mentions - no "corrective"/"reverted X" prose
  or bookkeeping needed. Rollback is just another append capturing the corrected current value.
- Immutability: providers (DeepSeek/Gemini/Anthropic) cache the identical prefix; adding to the tail is
  the only thing that changes between identical-log turns. Costs are proportional to true new info.
- Deletion/rollback safety: never mutate the log; the corrected value is appended as new tail data for
  the model to adopt in the same/next turn.
- Blast radius bounded: system prompt head is stable; harness full snapshots occur only at cold
  boundaries (rare by nature); tail deltas are the only ongoing traffic.

-------------------------------------------------------------------------
## Concrete seam notes (implementation)

- Live harness is NOT in buildSystemPrompt. Remove the harnessState inline digest (system-prompt.ts).
- Full snapshot = a model-visible CUSTOM context item (display:false for TUI) carrying
  formatHarnessStateForPrompt(currentState) - emitted at session start and after each compaction.
- Per-change tail line = a CUSTOM context item carrying the self-describing delta; appended when a
  refinement/rollback applies and next payload is assembled. The coalescing window is defined by the
  REQUEST-ASSEMBLY POINT (see Remaining review), not a separate ledger: changes since the last assembled
  payload collapse to one line per entry at its CURRENT value; an entry that did not change since it was
  last emitted is simply not present in the window. No "cursor"/watermark object is introduced.
- convertToLlm: let the two CUSTOM items through as user-role text (snapshot-* / harness-delta-*); keep
  refinement_outcome filtered (audit only). distinct custom types.
- providers unchanged. Tool array handled separately (stable-deterministic).

-------------------------------------------------------------------------
## Tests / acceptance

- [ ] no harness content in system prompt; prompt byte-stable across changes.
- [ ] session start and post-compaction each contain EXACTLY ONE full harness snapshot.
- [ ] a mid-flow create/update -> one self-describing tail line on NEXT payload; nothing earlier changes.
- [ ] a delete / rollback mid-flow -> one new tail line carrying corrected value; immutable log untouched
      (assert prior payload bytes identical).
- [ ] N changes before a payload -> coalesce to one line per entry (current value).
- [ ] no change -> no extra tail bytes (payload identical besides new user turn / continuation).
- [ ] served payload bytes for identical prior context differ ONLY by tail additions (cache-lean proof).
- [ ] DeepSeek live probe: two calls with a mid-... refine show cache hit on the unchanged prefix.

-------------------------------------------------------------------------
## Remaining review
- DEMARCATION (resolved): no persistent 'watermark' ledger is needed. The only boundary that matters is
  the REQUEST-ASSEMBLY POINT: harness changes newer than the last model payload that was assembled ride
  in the NEXT payload; once shipped they are permanently part of the immutable prefix. Coalescing window =
  'changes since the last assembled payload' (dedup to current value per entry). Delete/rollback semantics
  are in the format section above.
