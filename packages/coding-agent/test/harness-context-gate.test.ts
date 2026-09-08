import { describe, expect, it } from "vitest";
import {
	armHarnessSnapshotBoundary,
	consumeHarnessSnapshotBoundary,
	maybePrependHarnessSnapshot,
	peekHarnessSnapshotBoundary,
} from "../src/core/harness-context-gate.js";

describe("harness-context boundary gate (plan v4)", () => {
	it("not armed: consume undefined and peek false", () => {
		const target = {};
		expect(peekHarnessSnapshotBoundary(target)).toBe(false);
		expect(consumeHarnessSnapshotBoundary(target)).toBeUndefined();
	});
	it("arm+consume returns text once, then cleared", () => {
		const target = {};
		armHarnessSnapshotBoundary(target, "SNAPSHOT");
		expect(peekHarnessSnapshotBoundary(target)).toBe(true);
		expect(consumeHarnessSnapshotBoundary(target)).toBe("SNAPSHOT");
		expect(consumeHarnessSnapshotBoundary(target)).toBeUndefined();
		expect(peekHarnessSnapshotBoundary(target)).toBe(false);
	});
	it("is per-target", () => {
		const a = {};
		const b = {};
		armHarnessSnapshotBoundary(a, "A");
		expect(peekHarnessSnapshotBoundary(b)).toBe(false);
	});
});

describe("maybePrependHarnessSnapshot (sdk transformContext)", () => {
	it("prepends a model-visible harness_snapshot when armed, then clears", async () => {
		const target = { modelRunId: "root" } as never;
		armHarnessSnapshotBoundary(target, "SNAPSHOT-BODY");
		const base = [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
		] as never as import("@earendil-works/pi-agent-core").AgentMessage[];
		const out = maybePrependHarnessSnapshot(target, base);
		expect(out).toHaveLength(2);
		expect((out[0] as { customType?: string }).customType).toBe("harness_snapshot");
		expect((out[1] as { role?: string }).role).toBe("user");
		// consumed once
		expect(maybePrependHarnessSnapshot(target, base)).toEqual(base);
	});
	it("returns messages unchanged when not armed", async () => {
		const out = maybePrependHarnessSnapshot({}, []);
		expect(out).toEqual([]);
	});
});
