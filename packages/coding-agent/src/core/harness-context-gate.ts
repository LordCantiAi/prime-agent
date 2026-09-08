/**
 * Cache-stable Continual Harness boundary gate (plan v4).
 * AgentSession arms this with the computed harness snapshot text at a cold
 * boundary (session start, post-compaction). The sdk transformContext hook then
 * consumes it exactly once and prepends a model-visible harness_snapshot to the
 * model request head. The snapshot is never written to the persistent transcript,
 * preserving the compaction_outcome-last and rollback contracts.
 */
const state = new WeakMap<object, { text: string }>();

export function armHarnessSnapshotBoundary(target: object, snapshotText: string): void {
	state.set(target, { text: snapshotText });
}

export function consumeHarnessSnapshotBoundary(target: object): string | undefined {
	const rec = state.get(target);
	if (!rec) return undefined;
	state.delete(target);
	return rec.text;
}

export function peekHarnessSnapshotBoundary(target: object): boolean {
	return state.has(target);
}

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createHarnessSnapshotMessage } from "./messages.js";

/**
 * If a cold-boundary snapshot is armed for `target`, consume it and return the
 * message list with a model-visible harness_snapshot prepended; otherwise return
 * messages unchanged. Pure and unit-testable; the SDK transformContext calls this.
 */
export function maybePrependHarnessSnapshot(target: object, messages: AgentMessage[]): AgentMessage[] {
	const text = consumeHarnessSnapshotBoundary(target);
	if (text === undefined || text.trim().length === 0) {
		return messages;
	}
	return [createHarnessSnapshotMessage(text, { snapshotId: `head-${Date.now()}` }), ...messages];
}
