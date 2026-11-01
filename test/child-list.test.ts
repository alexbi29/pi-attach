// Tests for the subagent list itself: which conversations it lists, and how it behaves inside the child view.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { ChildList, isRecent, rosterEntries } from "../src/child-list.ts";
import { child, MINUTE, NOW, run } from "./fixtures.ts";

describe("rosterEntries", () => {
	it("lists every started child: active ones first, then the rest, newest first in each", () => {
		const entries = rosterEntries([
			run("done-new", [child("complete", NOW - 3 * MINUTE, { endedAt: NOW - MINUTE })]),
			run("run-old", [child("running", NOW - 5 * MINUTE)]),
			run("run-new", [child("queued", NOW - MINUTE)]),
			run("done-old", [child("failed", NOW - 90 * MINUTE, { endedAt: NOW - 80 * MINUTE })]),
			run("workflow", [child("pending", NOW)]),
		]);
		assert.deepEqual(
			entries.map((entry) => entry.target.runId),
			["run-new", "run-old", "done-new", "done-old"],
		);
	});

	it("lists a resumed conversation once, as its newest run, and keeps its siblings", () => {
		const entries = rosterEntries([
			run("before-resume", [child("paused", NOW - 5 * MINUTE, { sessionFile: "/s/one.jsonl", endedAt: NOW - 4 * MINUTE })]),
			run("resumed", [child("complete", NOW - 3 * MINUTE, { sessionFile: "/s/one.jsonl", endedAt: NOW - MINUTE })]),
			run("parallel", [child("complete", NOW - 9 * MINUTE, { sessionFile: "/s/two.jsonl", endedAt: NOW - 8 * MINUTE })]),
			run("unsaved", [child("running", NOW - 2 * MINUTE)]),
		]);
		assert.deepEqual(
			entries.map((entry) => entry.target.runId),
			["unsaved", "resumed", "parallel"],
		);
	});

	it("numbers the children of a multi-step run and targets each by index", () => {
		const [first, second] = rosterEntries([run("wf", [child("running", NOW - 2), child("running", NOW - 1)])]);
		assert.deepEqual(second?.target, { runId: "wf", asyncDir: "/runs/wf", index: 0 });
		assert.equal(second?.step, "1/2");
		assert.equal(first?.step, "2/2");
	});
});

describe("isRecent", () => {
	it("keeps active children and ones that ended in the last ten minutes", () => {
		const entries = rosterEntries([
			run("running", [child("running", NOW - 3)]),
			run("fresh", [child("complete", NOW - 2, { endedAt: NOW - 9 * MINUTE })]),
			run("stale", [child("paused", NOW - 1, { endedAt: NOW - 11 * MINUTE })]),
		]);
		assert.deepEqual(Object.fromEntries(entries.map((entry) => [entry.target.runId, isRecent(entry, NOW)])), {
			running: true,
			fresh: true,
			stale: false,
		});
	});
});

// Unstyled theme: rows come out as plain text.
const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

const DOWN = "\x1b[B";
const ENTER = "\r";

describe("ChildList in the child view", () => {
	const runs = () => [
		run("here", [child("complete", NOW - 30 * MINUTE, { task: "the one on screen", endedAt: NOW - 20 * MINUTE })]),
		run("other", [child("running", NOW - MINUTE, { task: "another child", waiting: "supervisor" })]),
	];
	const viewList = () => {
		const list = new ChildList("view");
		list.setCurrent({ runId: "here", asyncDir: "/runs/here", index: 0 });
		list.update(runs(), NOW);
		return list;
	};

	it("starts with a main row, keeps the shown child although it is old, and selects it", () => {
		const list = viewList();
		assert.equal(list.open(), true);
		const lines = list.render(100, plainTheme).map((line) => line.trimEnd());
		assert.match(lines[0] ?? "", /^ {2}main {6}the main session/);
		assert.match(lines[1] ?? "", /^ {2}delegate {2}another child/);
		assert.match(lines[2] ?? "", /^› delegate {2}the one on screen/);
		assert.deepEqual(
			list.others().map((entry) => entry.target.runId),
			["other"],
		);
	});

	it("opens another child, goes back to main from the main row, and just closes on the shown child", () => {
		const list = viewList();
		list.open();
		assert.deepEqual(list.handleKey(ENTER), { kind: "consumed" });
		assert.equal(list.isOpen, false);
		list.open();
		list.select("other:0");
		assert.deepEqual(list.handleKey(ENTER), { kind: "open", target: { runId: "other", asyncDir: "/runs/other", index: 0 } });
		// The view switches and keeps the list open: the new child is now current and selected.
		list.setCurrent({ runId: "other", asyncDir: "/runs/other", index: 0 });
		assert.equal(list.isOpen, true);
		assert.match(list.render(100, plainTheme).find((line) => line.startsWith("›")) ?? "", /another child/);
		list.select("main");
		assert.deepEqual(list.handleKey(ENTER), { kind: "main" });
	});

	it("hands typing back to the editor", () => {
		const list = viewList();
		list.open();
		assert.deepEqual(list.handleKey("x"), { kind: "passed" });
		assert.equal(list.isOpen, false);
		list.open();
		assert.deepEqual(list.handleKey(DOWN), { kind: "consumed" });
	});
});
