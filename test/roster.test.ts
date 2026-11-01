// Tests for the inline subagent list under the editor: which children it lists and how its keys behave.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Roster, rosterEntries } from "../src/roster.ts";
import type { ChildStatus, RunStatus, SessionRuns } from "../src/run-status.ts";
import type { ViewTarget } from "../src/view.ts";

const MINUTE = 60_000;
const NOW = 100 * MINUTE;

function run(runId: string, children: ChildStatus[], endedAt?: number): RunStatus {
	return { runId, asyncDir: `/runs/${runId}`, state: "running", children, ...(endedAt === undefined ? {} : { endedAt }) };
}

const child = (state: string, startedAt: number, extra: Partial<ChildStatus> = {}): ChildStatus => ({
	agent: "delegate",
	state,
	startedAt,
	...extra,
});

describe("rosterEntries", () => {
	it("lists running children first, then recently finished ones, newest first in each", () => {
		const entries = rosterEntries(
			[
				run("done-new", [child("complete", NOW - 3 * MINUTE, { endedAt: NOW - MINUTE })]),
				run("run-old", [child("running", NOW - 5 * MINUTE)]),
				run("run-new", [child("queued", NOW - MINUTE)]),
				run("done-old", [child("failed", NOW - 9 * MINUTE, { endedAt: NOW - 8 * MINUTE })]),
			],
			NOW,
		);
		assert.deepEqual(
			entries.map((entry) => entry.target.runId),
			["run-new", "run-old", "done-new", "done-old"],
		);
	});

	it("drops children that ended more than ten minutes ago and children that have not started", () => {
		const entries = rosterEntries(
			[
				run("stale", [child("complete", NOW - 20 * MINUTE, { endedAt: NOW - 11 * MINUTE })]),
				run("workflow", [child("running", NOW - MINUTE), child("pending", NOW)]),
			],
			NOW,
		);
		assert.deepEqual(
			entries.map((entry) => entry.key),
			["workflow:0"],
		);
	});

	it("numbers the children of a multi-step run and targets each by index", () => {
		const [first, second] = rosterEntries([run("wf", [child("running", NOW - 2), child("running", NOW - 1)])], NOW);
		assert.deepEqual(second?.target, { runId: "wf", asyncDir: "/runs/wf", index: 0 });
		assert.equal(second?.step, "1/2");
		assert.equal(first?.step, "2/2");
	});
});

// A fake UI that records the widget and the terminal input listener the list installs.
function harness(runs: RunStatus[]) {
	let onInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let widget: Component | undefined;
	let editorText = "";
	const opened: ViewTarget[] = [];
	const editor = { getText: () => editorText, setText: () => {} };
	const tui = { focusedComponent: editor as object, requestRender: () => {} };
	const ctx = {
		ui: {
			onTerminalInput: (handler: typeof onInput) => {
				onInput = handler;
				return () => {
					onInput = undefined;
				};
			},
			setWidget: (_key: string, factory: ((tui: TUI, theme: Theme) => Component) | undefined) => {
				widget = factory?.(tui as unknown as TUI, plainTheme);
			},
			getEditorText: () => editorText,
		},
	} as unknown as ExtensionContext;
	const roster = new Roster({ list: () => runs } as unknown as SessionRuns, (target) => opened.push(target), ctx);
	return {
		roster,
		opened,
		tui,
		press: (key: string) => onInput?.(key)?.consume === true,
		lines: () => (widget?.render(120) ?? []).map((line) => line.trimEnd()),
		type: (text: string) => {
			editorText = text;
		},
	};
}

// Unstyled theme: rows come out as plain text.
const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";

describe("Roster", () => {
	const twoChildren = () => [
		run("a", [child("running", Date.now() - 2000, { task: "first task" })]),
		run("b", [child("running", Date.now() - 1000, { task: "second task" })]),
	];

	it("shows one summary line until ↓ on an empty editor opens the list", () => {
		const ui = harness(twoChildren());
		assert.deepEqual(ui.lines(), ["  2 running · ↓ to open"]);
		ui.type("draft");
		assert.equal(ui.press(DOWN), false);
		ui.type("");
		assert.equal(ui.press(DOWN), true);
		assert.deepEqual(ui.lines(), [
			"  › delegate  second task  running  1s",
			"    delegate  first task   running  2s",
			"    enter open · esc back",
		]);
		ui.roster.dispose();
	});

	it("lines up every column across rows", () => {
		const now = Date.now();
		const ui = harness([
			run("a", [child("running", now - 84_000, { agent: "worker", task: "a long task text", tokens: 851_700 })]),
			run("b", [child("paused", now - 395_000, { agent: "reviewer", task: "short", endedAt: now, tokens: 1_200_000 })]),
		]);
		ui.press(DOWN);
		assert.deepEqual(ui.lines().slice(0, 2), [
			"  › worker    a long task text  running  1m 24s  851.7k tokens",
			"    reviewer  short             paused   6m 35s    1.2M tokens",
		]);
		ui.roster.dispose();
	});

	it("opens the selected child on Enter and closes the list", () => {
		const ui = harness(twoChildren());
		ui.press(DOWN);
		ui.press(DOWN);
		assert.equal(ui.press(ENTER), true);
		assert.deepEqual(ui.opened, [{ runId: "a", asyncDir: "/runs/a", index: 0 }]);
		assert.equal(ui.lines().length, 1);
		ui.roster.dispose();
	});

	it("hands keys back to the editor on Esc, on ↑ from the first row and on typing", () => {
		const ui = harness(twoChildren());
		ui.press(DOWN);
		assert.equal(ui.press(ESC), true);
		assert.equal(ui.lines().length, 1);
		ui.press(DOWN);
		assert.equal(ui.press(UP), true);
		assert.equal(ui.lines().length, 1);
		ui.press(DOWN);
		assert.equal(ui.press("x"), false);
		assert.equal(ui.lines().length, 1);
		ui.roster.dispose();
	});

	it("leaves keys alone while something other than the editor has focus", () => {
		const ui = harness(twoChildren());
		ui.tui.focusedComponent = { render: () => [] };
		assert.equal(ui.press(DOWN), false);
		ui.roster.dispose();
	});
});
