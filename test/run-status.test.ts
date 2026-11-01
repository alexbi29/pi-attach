// Tests for reading pi-subagents' async run records.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { listSessionRuns, readRunStatus, SessionRuns } from "../src/run-status.ts";

function writeRun(root: string, runId: string, status: Record<string, unknown>): string {
	const dir = join(root, runId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "status.json"), JSON.stringify(status));
	return dir;
}

describe("readRunStatus", () => {
	it("reads the run and child fields the view shows", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-attach-test-"));
		const dir = writeRun(root, "run-1", {
			state: "running",
			sessionId: "/parent.jsonl",
			startedAt: 10,
			steps: [
				{
					agent: "delegate",
					status: "running",
					model: "epyc/flash",
					sessionFile: "/child.jsonl",
					tokens: { total: 1234 },
					toolCount: 3,
				},
			],
		});
		assert.deepEqual(readRunStatus(dir, "run-1"), {
			runId: "run-1",
			asyncDir: dir,
			state: "running",
			parentSession: "/parent.jsonl",
			startedAt: 10,
			children: [
				{
					agent: "delegate",
					state: "running",
					model: "epyc/flash",
					sessionFile: "/child.jsonl",
					tokens: 1234,
					toolCount: 3,
				},
			],
		});
	});

	it("returns undefined before the runner writes status.json", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-attach-test-"));
		assert.equal(readRunStatus(join(root, "missing"), "missing"), undefined);
	});

	it("drops fields with unexpected types instead of passing them on", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-attach-test-"));
		const dir = writeRun(root, "run-2", { state: 7, steps: [{ agent: 1, tokens: "many" }] });
		assert.deepEqual(readRunStatus(dir, "run-2"), {
			runId: "run-2",
			asyncDir: dir,
			state: "unknown",
			children: [{ agent: "subagent", state: "unknown" }],
		});
	});
});

describe("listSessionRuns", () => {
	it("keeps only the parent session's runs, newest first", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-attach-test-"));
		writeRun(root, "old", { sessionId: "/mine.jsonl", startedAt: 1, steps: [] });
		writeRun(root, "other", { sessionId: "/theirs.jsonl", startedAt: 3, steps: [] });
		writeRun(root, "new", { sessionId: "/mine.jsonl", startedAt: 2, steps: [] });
		mkdirSync(join(root, "no-status"));
		assert.deepEqual(
			listSessionRuns("/mine.jsonl", root).map((run) => run.runId),
			["new", "old"],
		);
	});

	it("returns nothing when the runs directory does not exist", () => {
		assert.deepEqual(listSessionRuns("/mine.jsonl", join(tmpdir(), "pi-attach-no-such-dir")), []);
	});
});

describe("SessionRuns", () => {
	it("re-reads in-flight runs and keeps a finished run's last status", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-attach-test-"));
		writeRun(root, "live", { state: "running", sessionId: "/mine.jsonl", steps: [] });
		writeRun(root, "done", { state: "complete", sessionId: "/mine.jsonl", steps: [] });
		const runs = new SessionRuns("/mine.jsonl", root);
		assert.deepEqual(states(runs), { done: "complete", live: "running" });
		writeRun(root, "live", { state: "complete", sessionId: "/mine.jsonl", steps: [] });
		// A finished run never changes, so a rewrite of its file is not read.
		writeRun(root, "done", { state: "running", sessionId: "/mine.jsonl", steps: [] });
		assert.deepEqual(states(runs), { done: "complete", live: "complete" });
	});

	it("picks up a run whose status was written without its session at first", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-attach-test-"));
		writeRun(root, "new", { state: "running", steps: [] });
		const runs = new SessionRuns("/mine.jsonl", root);
		assert.deepEqual(states(runs), {});
		writeRun(root, "new", { state: "running", sessionId: "/mine.jsonl", steps: [] });
		assert.deepEqual(states(runs), { new: "running" });
	});
});

function states(runs: SessionRuns): Record<string, string> {
	return Object.fromEntries(runs.list().map((run) => [run.runId, run.state]));
}
