// Tests for the inline subagent list under the editor: which children it lists and how its keys behave.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { isRecent, Roster, rosterEntries } from "../src/roster.ts";
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

// A fake UI that records the widget and the terminal input listener the list installs.
function harness(runs: RunStatus[]) {
	let onInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let widget: Component | undefined;
	let editorText = "";
	const opened: ViewTarget[] = [];
	const notices: string[] = [];
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
			notify: (message: string) => notices.push(message),
		},
	} as unknown as ExtensionContext;
	const roster = new Roster({ list: () => runs } as unknown as SessionRuns, (target) => opened.push(target), ctx);
	return {
		roster,
		opened,
		notices,
		tui,
		press: (key: string) => onInput?.(key)?.consume === true,
		// Rows fill the width; tests pick a width or trim the padding.
		lines: (width = 120) => (widget?.render(width) ?? []).map((line) => line.trimEnd()),
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
const TAB = "\t";

describe("Roster", () => {
	const twoChildren = () => [
		run("a", [child("running", Date.now() - 2000, { task: "first task" })]),
		run("b", [child("running", Date.now() - 1000, { task: "second task" })]),
	];

	it("shows one summary line until ↓ on an empty editor opens the list", () => {
		const ui = harness(twoChildren());
		assert.deepEqual(ui.lines(), ["2 running · ↓ to open"]);
		ui.type("draft");
		assert.equal(ui.press(DOWN), false);
		ui.type("");
		assert.equal(ui.press(DOWN), true);
		// At the table's natural width the task column is exactly as wide as its longest task.
		assert.deepEqual(ui.lines(36), [
			"› delegate  second task  running  1s",
			"  delegate  first task   running  2s",
			"  enter open · esc back",
		]);
		ui.roster.dispose();
	});

	it("puts children waiting on an answer first in the summary and names them in their row", () => {
		const now = Date.now();
		const ui = harness([
			run("a", [child("running", now - 2000, { task: "busy" })]),
			run("b", [child("running", now - 1000, { task: "stuck", waiting: "supervisor" })]),
		]);
		assert.deepEqual(ui.lines(), ["1 asking · 1 running · ↓ to open"]);
		ui.press(DOWN);
		assert.match(ui.lines()[0] ?? "", /^› delegate {2}stuck +asking +1s$/);
		ui.roster.dispose();
	});

	it("lines up every column across rows", () => {
		const now = Date.now();
		const ui = harness([
			run("a", [child("running", now - 84_000, { agent: "worker", task: "a long task text", model: "deepseek-v4-flash", context: 24_416, contextLimit: 262_144 })]),
			run("b", [child("paused", now - 395_000, { agent: "reviewer", task: "short", model: "qwen3.8-flash-next", endedAt: now, context: 210_488, contextLimit: 1_000_000 })]),
		]);
		ui.press(DOWN);
		assert.deepEqual(ui.lines(82).slice(0, 2), [
			"› worker    a long task text  deepseek-v4-flash   running  1m 24s   24k / 262k ctx",
			"  reviewer  short             qwen3.8-flash-next  paused   6m 35s  210k / 1.0M ctx",
		]);
		ui.roster.dispose();
	});

	it("ends every row at the terminal's edge, where pi's footer ends", () => {
		const now = Date.now();
		const ui = harness([
			run("a", [child("running", now - 84_000, { task: "a long task text", context: 24_416, contextLimit: 262_144 })]),
			run("b", [child("paused", now - 395_000, { task: "short", endedAt: now, context: 210_488, contextLimit: 1_000_000 })]),
		]);
		ui.press(DOWN);
		for (const width of [60, 150]) {
			const rows = ui.lines(width).slice(0, 2);
			assert.deepEqual(
				rows.map((row) => visibleWidth(row)),
				[width, width],
			);
			assert.ok(rows.every((row) => row.endsWith(" ctx")));
		}
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

	it("shows older children on Tab and only recent ones again on a second Tab", () => {
		const now = Date.now();
		const ui = harness([
			run("new", [child("running", now - 1000, { task: "new task" })]),
			run("old", [child("complete", now - 3 * 60 * MINUTE, { task: "old task", endedAt: now - 2 * 60 * MINUTE })]),
		]);
		ui.press(DOWN);
		assert.equal(ui.lines().length, 2);
		assert.equal(ui.lines()[1], "  enter open · tab 1 older · esc back");
		ui.press(TAB);
		assert.equal(ui.lines().length, 3);
		assert.match(ui.lines()[1] ?? "", /old task/);
		assert.equal(ui.lines()[2], "  enter open · tab recent only · esc back");
		ui.press(TAB);
		assert.equal(ui.lines().length, 2);
		ui.roster.dispose();
	});

	it("opens on all children from the shortcut when none is recent, and closes back to nothing", () => {
		const now = Date.now();
		const ui = harness([run("old", [child("complete", now - 3 * 60 * MINUTE, { task: "old task", endedAt: now - 2 * 60 * MINUTE })])]);
		assert.deepEqual(ui.lines(), []);
		ui.type("half-typed message");
		ui.roster.show();
		assert.match(ui.lines()[0] ?? "", /^› delegate {2}old task/);
		// Nothing is recent, so there is no "recent only" to switch to.
		assert.equal(ui.lines()[1], "  enter open · esc back");
		assert.equal(ui.press(TAB), true);
		assert.equal(ui.lines().length, 2);
		assert.equal(ui.press(ESC), true);
		assert.deepEqual(ui.lines(), []);
		ui.roster.dispose();
	});

	it("tells the user when the session has no subagents yet", () => {
		const ui = harness([]);
		ui.roster.show();
		assert.deepEqual(ui.notices, ["No subagent runs in this session yet."]);
		ui.roster.dispose();
	});
});
