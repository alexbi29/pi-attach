// Tests for reading a child's task line from its session file.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readTask, taskLine } from "../src/task.ts";

function sessionFile(...entries: unknown[]): string {
	const file = join(mkdtempSync(join(tmpdir(), "pi-attach-test-")), "session.jsonl");
	writeFileSync(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
	return file;
}

describe("taskLine", () => {
	it("drops pi-subagents' framing and keeps the first line", () => {
		assert.equal(taskLine("Task: [Read from: /p/plan.md]\n\nOpen /tmp/wave21.txt and   transcribe it.\nMore detail."), "Open /tmp/wave21.txt and transcribe it.");
		assert.equal(taskLine("Run the tests"), "Run the tests");
	});
});

describe("readTask", () => {
	it("reads the first user message, as a string or as text parts", () => {
		const header = { type: "session", id: "s" };
		assert.equal(
			readTask(sessionFile(header, { type: "message", message: { role: "user", content: "Task: Fix the bug" } })),
			"Fix the bug",
		);
		assert.equal(
			readTask(sessionFile(header, { type: "message", message: { role: "user", content: [{ type: "image" }, { type: "text", text: "Review src/" }] } })),
			"Review src/",
		);
	});

	it("returns undefined before the task is written and for a missing file", () => {
		assert.equal(readTask(sessionFile({ type: "session", id: "s" })), undefined);
		assert.equal(readTask(join(tmpdir(), "pi-attach-no-such-session.jsonl")), undefined);
	});
});
