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
