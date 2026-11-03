// Tests for the subagent list under the main editor: its summary line, its keys, and leaving and returning from a view.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { Roster } from "../src/roster.ts";
import type { RunStatus, SessionRuns } from "../src/run-status.ts";
import type { ViewTarget } from "../src/view.ts";

import { child, MINUTE, run } from "./fixtures.ts";

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
	// The child view stays open until the test calls closeView(), which reports the child shown last.
	let closeView = (_shown?: ViewTarget) => {};
	const open = (target: ViewTarget) => {
		opened.push(target);
		return new Promise<ViewTarget | undefined>((resolve) => {
			closeView = resolve;
		});
	};
	const roster = new Roster({ list: () => runs } as unknown as SessionRuns, open, ctx);
	return {
		roster,
		opened,
		// Leave the child view, then let the list notice.
		closeView: async (shown?: ViewTarget) => {
			closeView(shown);
			await new Promise((resolve) => setImmediate(resolve));
		},
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

	it("shows one summary line until ↓ on an empty editor opens the list on its first child, under main", () => {
		const ui = harness(twoChildren());
		assert.deepEqual(ui.lines(), ["2 running · ↓ to open"]);
		ui.type("draft");
		assert.equal(ui.press(DOWN), false);
		ui.type("");
		assert.equal(ui.press(DOWN), true);
		// The longest task ("the main session") plus its 10-column margin: the task column is exactly that wide.
		assert.deepEqual(ui.lines(51), [
			"  main      the main session",
			"› delegate  second task                 running  1s",
			"  delegate  first task                  running  2s",
			"  enter open · esc back",
		]);
		ui.roster.dispose();
	});

	it("puts children waiting on an answer or a long tool call first in the summary and names them in their row", () => {
		const now = Date.now();
		const ui = harness([
			run("a", [child("running", now - 3000, { task: "busy" })]),
			run("c", [child("running", now - 2000, { task: "slow", waiting: "tool" })]),
			run("b", [child("running", now - 1000, { task: "stuck", waiting: "supervisor" })]),
		]);
		assert.deepEqual(ui.lines(), ["1 asking · 1 long tool · 1 running · ↓ to open"]);
		ui.press(DOWN);
		assert.match(ui.lines()[1] ?? "", /^› delegate {2}stuck +asking +1s$/);
		assert.match(ui.lines()[2] ?? "", /^ {2}delegate {2}slow +long tool +2s$/);
		ui.roster.dispose();
	});

	it("puts the cursor on the child viewed last when the view switched children", async () => {
		const ui = harness(twoChildren());
		ui.press(DOWN);
		ui.press(ENTER);
		await ui.closeView({ runId: "a", asyncDir: "/runs/a", index: 0 });
		assert.match(ui.lines()[2] ?? "", /^› delegate {2}first task/);
		ui.roster.dispose();
	});

	it("lines up every column across rows", () => {
		const now = Date.now();
		const ui = harness([
			run("a", [child("running", now - 84_000, { agent: "worker", task: "a long task text", model: "deepseek-v4-flash", context: 24_416, contextLimit: 262_144 })]),
			run("b", [child("paused", now - 395_000, { agent: "reviewer", task: "short", model: "qwen3.8-flash-next", endedAt: now, context: 210_488, contextLimit: 1_000_000 })]),
		]);
		ui.press(DOWN);
		assert.deepEqual(ui.lines(92).slice(1, 3), [
			"› worker    a long task text            deepseek-v4-flash   running  1m 24s   24k / 262k ctx",
			"  reviewer  short                       qwen3.8-flash-next  paused   6m 35s  210k / 1.0M ctx",
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
			const rows = ui.lines(width).slice(1, 3);
			assert.deepEqual(
				rows.map((row) => visibleWidth(row)),
				[width, width],
			);
			assert.ok(rows.every((row) => row.endsWith(" ctx")));
			// A task too long for its column stops 10 columns short of the next one.
			// biome-ignore lint/suspicious/noControlCharactersInRegex: pi-tui wraps the ellipsis in reset codes
			if (width === 60) assert.match(rows[0] ?? "", /…(\x1b\[0m)?\s{12}\S/);
		}
		ui.roster.dispose();
	});

	it("opens the selected child on Enter and comes back to the same row when the view closes", async () => {
		const ui = harness(twoChildren());
		ui.press(DOWN);
		ui.press(DOWN);
		assert.equal(ui.press(ENTER), true);
		assert.deepEqual(ui.opened, [{ runId: "a", asyncDir: "/runs/a", index: 0 }]);
		// Keys typed into the view are the view's: the list neither moves nor closes.
		assert.equal(ui.press(ESC), false);
		await ui.closeView();
		assert.match(ui.lines()[2] ?? "", /^› delegate {2}first task/);
		assert.equal(ui.press(ESC), true);
		assert.equal(ui.lines().length, 1);
		ui.roster.dispose();
	});

	it("hands keys back to the editor on Esc, on ↑ from the main row and on typing", () => {
		const ui = harness(twoChildren());
		ui.press(DOWN);
		assert.equal(ui.press(ESC), true);
		assert.equal(ui.lines().length, 1);
		ui.press(DOWN);
		assert.equal(ui.press(UP), true);
		assert.match(ui.lines()[0] ?? "", /^› main/);
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
		assert.equal(ui.lines().length, 3);
		assert.equal(ui.lines()[2], "  enter open · tab 1 older · esc back");
		ui.press(TAB);
		assert.equal(ui.lines().length, 4);
		assert.match(ui.lines()[2] ?? "", /old task/);
		assert.equal(ui.lines()[3], "  enter open · tab recent only · esc back");
		ui.press(TAB);
		assert.equal(ui.lines().length, 3);
		ui.roster.dispose();
	});

	it("opens on all children from the shortcut when none is recent, and closes back to nothing", () => {
		const now = Date.now();
		const ui = harness([run("old", [child("complete", now - 3 * 60 * MINUTE, { task: "old task", endedAt: now - 2 * 60 * MINUTE })])]);
		assert.deepEqual(ui.lines(), []);
		ui.type("half-typed message");
		ui.roster.show();
		assert.match(ui.lines()[1] ?? "", /^› delegate {2}old task/);
		// Nothing is recent, so there is no "recent only" to switch to.
		assert.equal(ui.lines()[2], "  enter open · esc back");
		assert.equal(ui.press(TAB), true);
		assert.equal(ui.lines().length, 3);
		assert.equal(ui.press(ESC), true);
		assert.deepEqual(ui.lines(), []);
		ui.roster.dispose();
	});

	it("closes the list on Enter on the main row, the session already on screen", () => {
		const ui = harness(twoChildren());
		ui.press(DOWN);
		ui.press(UP);
		assert.equal(ui.press(ENTER), true);
		assert.deepEqual(ui.opened, []);
		assert.equal(ui.lines().length, 1);
		ui.roster.dispose();
	});

	it("tells the user when the session has no subagents yet", () => {
		const ui = harness([]);
		ui.roster.show();
		assert.deepEqual(ui.notices, ["No subagent runs in this session yet."]);
		ui.roster.dispose();
	});
});
