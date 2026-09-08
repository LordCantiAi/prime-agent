# dogfood/cache-stable-v0.9.4 — cache-stable Continual Harness (dogfood branch)

Declarative intent of this branch. Read this before doing anything on it.

## What this branch is FOR

To DOGFOOD the "cache-stable Continual Harness context" feature (plan v4) as the live Prime Agent on
Canti: prove the immutable-log + append-only-tail model works in real, sustained agent session work —
not just unit tests or one-shot probes. Success = the model-visible harness deltas/snapshots behave
correctly across many turns, compactions, and side-questions while staying provider-cache-lean.

When it is proven (let the dog get fat and happy), the code is squashed/merged and eventually proposed
upstream. Until then this branch is the runnable release we point the real agent at.

## Declarative contract (what must remain true when this is a good dogfood release)

1. CACHE-LEAN: a new turn that changes harness state must see provider cache-hits CLIMB, and the whole
   prompt must NOT be reprocessed just because a state line changed. (Regress = fail.)
2. IMMUTABLE LOG: once served, a model payload is never rewritten/reordered; harness state reaches the
   model only as APPENDED tail bytes. (Regress = fail.)
3. SNAPSHOT ONLY AT COLD BOUNDARIES: a full current-state snapshot appears exactly at session start and
   after each compaction — never mid-log. (Regress = fail.)
4. HARNESS NOT IN SYSTEM PROMPT: the served head is byte-stable; state lives in body snapshots/deltas.
5. CADENCE (Mechanism A): autoRefine.reviewer = "model"|"off" honored on every cadence; turnInterval is
   the only throttle when reviewer is off.
6. NO SIDE-QUESTION STEAL: a spawned side-agent must never consume the parent's armed cold-boundary
   snapshot.

## Active branches & history

- Working feature HEAD merged into:  (see git log)
- This branch is cut from the cache-stable work so it can carry a release + dogfood tweaks without
  disturbing the feature branch history.

## Where everything lives (paths start at ~/ = /home/jfgrissom)

Feature source & commits:
  ~/Repos/prime-agent-fork/                     working clone on this host
  branch (feature): implement/v4-cache-stable-harness
  branch (this):    dogfood/cache-stable-v0.9.4
  remote: git@github.com:LordCantiAi/prime-agent.git

Design / spec (authoritative):
  ~/Repos/prime-agent-fork/docs/design/cache-stable-continual-harness.md    <- plan v4 model + invariants
  ~/Repos/prime-agent-fork/docs/design/design-mechanism-A-auto-refine-cadence.md
  ~/Repos/prime-agent-fork/docs/design/analysis-mechanism-A-side-effects.md
  ~/Repos/prime-agent-fork/docs/design/IMPLEMENTATION-PROGRESS.md

Workspace mirrors (kept in ~/Agents/workspace, cross-host):
  ~/Agents/workspace/knowledge/specs/handoff-v4*.md etc. (earlier copies)

Touchpoints in code (decode the declarative contract into concrete files):
  ~/Repos/prime-agent-fork/packages/coding-agent/src/core/system-prompt.ts            harness NOT here
  ~/Repos/prime-agent-fork/packages/coding-agent/src/core/messages.ts                  convertToLlm fwd
  ~/Repos/prime-agent-fork/packages/coding-agent/src/core/harness-context-gate.ts       snapshot gate
  ~/Repos/prime-agent-fork/packages/coding-agent/src/core/agent-session.ts             append deltas
  ~/Repos/prime-agent-fork/packages/coding-agent/src/core/sdk.ts                        cold boundary
  ~/Repos/prime-agent-fork/packages/coding-agent/src/core/side-question.ts              no snapshot steal

Tests that lock the contract:
  ~/Repos/prime-agent-fork/packages/coding-agent/test/harness-context-gate.test.ts
  ~/Repos/prime-agent-fork/packages/coding-agent/test/harness-context-messages.test.ts
  ~/Repos/prime-agent-fork/packages/coding-agent/test/system-prompt.test.ts
  ~/Repos/prime-agent-fork/packages/coding-agent/test/suite/agent-session-serialized-refine.test.ts

## Dogfood release mechanics (this branch)

Goal: install THIS build as the live Prime Agent on Canti, not the published npm 0.9.3.

Blockers found (so nobody re-discovers them):
- The fork is NOT logged into the public npm registry (ENEEDAUTH) and the scope
  (@earendil-works) belongs to upstream; do NOT publish to npm.
- So dogfood = build the fork locally and run THAT binary; the live installed agent currently is the
  published npm one at:
    ~/.local/bin/prime-agent  ->  ~/.local/lib/node_modules/prime-agent/dist/bundle/cli.js
  (same code path the CLI uses; the published install is ~/.prime/agent under THIS canti host user)

Version bump (when we actually cut):
  npm run version:patch   (from ~/Repos/prime-agent-fork)  bumps all 4 workspaces 0.9.3 -> 0.9.4
  (private root prime-agent is workspace-internal; the public publish target is the @earendil-works pkgs)

## When is this branch "done"

A real agent session on Canti runs this build across >= several turns + >=1 compaction + >=1
side-question and: (a) no snapshot steal on side questions, (b) exact-one snapshot at session start &
post-compaction, (c) cache stays lean under state changes (see A/B evidence in IMPLEMENTATION-PROGRESS),
(d) cadence fires when configured. Then squash-merge to main; propagate to LordCantiAi upstream.
