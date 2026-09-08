import { describe, expect, test } from "vitest";
import {
	convertToLlm,
	createHarnessDeltaMessage,
	createHarnessSnapshotMessage,
	HARNESS_DELTA_CUSTOM_TYPE,
	HARNESS_SNAPSHOT_CUSTOM_TYPE,
	isHarnessContextMessage,
} from "../src/core/messages.js";

describe("harness context messages (plan v4: model-visible, cache-stable)", () => {
	test("snapshot message is role custom, display false, and carries digest text", () => {
		const msg = createHarnessSnapshotMessage("# Continual Harness State\nmemory: <routing>", { snapshotId: "snap1" });
		expect(msg.customType).toBe(HARNESS_SNAPSHOT_CUSTOM_TYPE);
		expect(msg.role).toBe("custom");
		expect(msg.display).toBe(false);
		expect(msg.details?.snapshotId).toBe("snap1");
		expect(typeof msg.content).toBe("string");
	});

	test("delta message carries self-describing entries", () => {
		const msg = createHarnessDeltaMessage([
			{ op: "update", kind: "memory", id: "validation", line: 'memory "validation" = run check' },
			{ op: "delete", kind: "memory", id: "old", line: 'memory "old" no longer valid (removed)' },
		]);
		expect(msg.customType).toBe(HARNESS_DELTA_CUSTOM_TYPE);
		expect(msg.details?.entries).toHaveLength(2);
		expect(isHarnessContextMessage(msg)).toBe(true);
	});

	test("convertToLlm forwards harness snapshot and delta to the model as user text", () => {
		const snap = convertToLlm([createHarnessSnapshotMessage("snapshot-body", { snapshotId: "s" })]);
		expect(snap).toHaveLength(1);
		expect(snap[0].role).toBe("user");
		expect(snap[0].content).toEqual([{ type: "text", text: "snapshot-body" }]);

		const delta = convertToLlm([
			createHarnessDeltaMessage([{ op: "create", kind: "memory", id: "a", line: 'memory "a" = x' }]),
		]);
		expect(delta).toHaveLength(1);
		expect(delta[0].role).toBe("user");
	});
});

import { harnessDeltaEntriesFromAppliedEdits } from "../src/core/messages.js";
import type { AppliedRefinementEdit } from "../src/core/refinement/refinement.js";

describe("harnessDeltaEntriesFromAppliedEdits", () => {
	function entry(id: string, title: string, content: string) {
		return {
			id,
			kind: "memory" as const,
			title,
			content,
			path: "repo",
			scope: "local" as const,
			reference: {},
			arguments: {},
			metadata: {},
			source: "refine",
			created_at: "2026-06-08T00:00:00.000Z",
			updated_at: "2026-06-08T00:00:00.000Z",
			version: 1,
		};
	}
	function edit(over: Partial<AppliedRefinementEdit> = {}): AppliedRefinementEdit {
		return { action: "update", kind: "memory", id: "x", applied: true, after: entry("x", "X", "Run check."), ...over };
	}
	test("create/update become self-describing current-value lines with no override marker", () => {
		const out = harnessDeltaEntriesFromAppliedEdits([edit({ id: "v", after: entry("v", "V", "Run check.") })]);
		expect(out).toHaveLength(1);
		expect(out[0].op).toBe("update");
		expect(out[0].line).toContain('memory "v" =');
		expect(out[0].line).not.toContain("no longer valid");
	});
	test("delete becomes an explicit removal override marker", () => {
		const out = harnessDeltaEntriesFromAppliedEdits([edit({ action: "delete", id: "old", after: undefined })]);
		expect(out[0].op).toBe("delete");
		expect(out[0].line).toContain("old");
		expect(out[0].line).toContain("no longer valid");
	});
	test("unapplied edits are dropped", () => {
		const out = harnessDeltaEntriesFromAppliedEdits([edit({ applied: false })]);
		expect(out).toHaveLength(0);
	});
});

