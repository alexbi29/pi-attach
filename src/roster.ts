// Inline list of this session's subagents under the editor: ↓ on an empty editor enters it, Enter opens one.
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Editor, getKeybindings, isKeyRelease, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatContext, formatDuration, shortKeyHint } from "./format.ts";
import type { ChildStatus, RunStatus, SessionRuns } from "./run-status.ts";
import { readTask } from "./task.ts";
import type { ViewTarget } from "./view.ts";

/** One listed child: where to open it and what its row shows. */
export interface RosterEntry {
	key: string;
	target: ViewTarget;
	child: ChildStatus;
	/** "2/4" for a child of a multi-step run; absent for a single child. */
	step?: string;
}

/** Children worth listing at `now`: active ones first, then ones that ended in the last 10 minutes; newest first in each. */
export function rosterEntries(runs: RunStatus[], now: number): RosterEntry[] {
	const entries = runs.flatMap((run) =>
		run.children.flatMap((child, index): RosterEntry[] => {
			// A child that has not started has nothing to show yet.
			if (child.state === "pending") return [];
			const ended = child.endedAt ?? run.endedAt ?? now;
			if (!isActive(child) && now - ended > RECENT_MS) return [];
			return [
				{
					key: `${run.runId}:${index}`,
					target: { runId: run.runId, asyncDir: run.asyncDir, index },
					child,
					...(run.children.length > 1 ? { step: `${index + 1}/${run.children.length}` } : {}),
				},
			];
		}),
	);
	return entries.sort(
		(a, b) => Number(isActive(b.child)) - Number(isActive(a.child)) || (b.child.startedAt ?? 0) - (a.child.startedAt ?? 0),
	);
}

// Long enough to read a result after a child ends; older children stay reachable through the picker.
const RECENT_MS = 10 * 60_000;

function isActive(child: ChildStatus): boolean {
	return child.state === "running" || child.state === "queued";
}

/** The widget and its keys for one session; `dispose` removes both. */
export class Roster {
	private readonly runs: SessionRuns;
	private readonly open: (target: ViewTarget) => void;
	private readonly ctx: ExtensionContext;
	private readonly timer: NodeJS.Timeout;
	private readonly stopInput: () => void;
	private entries: RosterEntry[] = [];
	private selectedKey: string | undefined;
	// True while ↑↓ move the selection instead of the editor cursor.
	private active = false;
	private shown = false;
	private tui: TUI | undefined;
	// Task lines by session file: a child's task never changes, so its file is read once.
	private readonly tasks = new Map<string, string>();

	constructor(runs: SessionRuns, open: (target: ViewTarget) => void, ctx: ExtensionContext) {
		this.runs = runs;
		this.open = open;
		this.ctx = ctx;
		this.stopInput = ctx.ui.onTerminalInput((data) => this.handleKey(data));
		// Also ticks the elapsed time of running children.
		this.timer = setInterval(() => this.refresh(), REFRESH_MS);
		this.timer.unref();
		this.refresh();
	}

	dispose(): void {
		clearInterval(this.timer);
		this.stopInput();
		if (this.shown) this.ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	private refresh(): void {
		this.entries = rosterEntries(this.runs.list(), Date.now());
		if (this.entries.length === 0) {
			this.active = false;
			if (this.shown) this.ctx.ui.setWidget(WIDGET_KEY, undefined);
			this.shown = false;
			return;
		}
		for (const { child } of this.entries) {
			if (!child.sessionFile || this.tasks.has(child.sessionFile)) continue;
			const task = readTask(child.sessionFile);
			if (task) this.tasks.set(child.sessionFile, task);
		}
		if (!this.entries.some((entry) => entry.key === this.selectedKey)) this.selectedKey = this.entries[0]?.key;
		if (this.shown) return this.tui?.requestRender();
		this.shown = true;
		this.ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				this.tui = tui;
				return {
					render: (width) => this.render(width, theme),
					invalidate: () => {},
					// pi drops widgets on its own too (reload, theme change); the next refresh re-adds it.
					dispose: () => {
						this.shown = false;
						this.tui = undefined;
					},
				};
			},
			{ placement: "belowEditor" },
		);
	}

	private handleKey(data: string): { consume: true } | undefined {
		if (isKeyRelease(data) || this.entries.length === 0) return undefined;
		if (!this.editorFocused()) {
			if (this.active) this.setActive(false);
			return undefined;
		}
		const kb = getKeybindings();
		if (!this.active) {
			if (!kb.matches(data, "tui.editor.cursorDown") || this.ctx.ui.getEditorText() !== "") return undefined;
			this.selectedKey = this.entries[0]?.key;
			this.setActive(true);
			return CONSUME;
		}
		const index = this.selectedIndex();
		if (kb.matches(data, "tui.select.down")) {
			this.select(Math.min(index + 1, this.entries.length - 1));
		} else if (kb.matches(data, "tui.select.up")) {
			// Up from the first row hands the keys back to the editor, as if the list were below it.
			if (index === 0) this.setActive(false);
			else this.select(index - 1);
		} else if (kb.matches(data, "tui.select.confirm")) {
			const entry = this.entries[index];
			this.setActive(false);
			if (entry) this.open(entry.target);
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.setActive(false);
		} else {
			// Typing leaves the list and goes to the editor.
			this.setActive(false);
			return undefined;
		}
		return CONSUME;
	}

	// pi-tui keeps the focused component private. The main editor is the focused component with
	// getText/setText; while a dialog or an overlay (such as the child view) has focus, keys are left alone.
	private editorFocused(): boolean {
		const focused = (this.tui as unknown as { focusedComponent?: Partial<Editor> } | undefined)?.focusedComponent;
		return typeof focused?.getText === "function" && typeof focused.setText === "function";
	}

	private setActive(active: boolean): void {
		this.active = active;
		this.tui?.requestRender();
	}

	private select(index: number): void {
		this.selectedKey = this.entries[index]?.key;
		this.tui?.requestRender();
	}

	private selectedIndex(): number {
		return Math.max(
			0,
			this.entries.findIndex((entry) => entry.key === this.selectedKey),
		);
	}

	// pi-subagents' session name holds only the task's first 60 or so characters; the session file has all of it.
	private taskOf(child: ChildStatus): string {
		return (child.sessionFile ? this.tasks.get(child.sessionFile) : undefined) ?? child.task ?? "";
	}

	private render(width: number, theme: Theme): string[] {
		if (this.entries.length === 0) return [];
		if (!this.active) {
			return [truncateToWidth(`  ${summary(this.entries, theme)} ${theme.fg("dim", "·")} ${shortKeyHint("tui.editor.cursorDown", "to open", theme)}`, width)];
		}
		const index = this.selectedIndex();
		const start = index < MAX_ROWS ? 0 : index - MAX_ROWS + 1;
		const visible = this.entries.slice(start, start + MAX_ROWS);
		const now = Date.now();
		// Column widths come from every entry, not just the visible ones, so scrolling never shifts them.
		const table = this.entries.map((entry) => cells(entry, this.taskOf(entry.child), now));
		const widths = columnWidths(table, width);
		const rows = visible.map((_entry, offset) => row(table[start + offset] as Cells, start + offset === index, widths, width, theme));
		const hidden = this.entries.length - visible.length;
		const hints = [
			shortKeyHint("tui.select.confirm", "open", theme),
			shortKeyHint("tui.select.cancel", "back", theme),
			...(hidden > 0 ? [theme.fg("dim", `${hidden} more`)] : []),
		];
		return [...rows, truncateToWidth(`    ${hints.join(theme.fg("dim", " · "))}`, width)];
	}
}

const WIDGET_KEY = "pi-attach-roster";
const REFRESH_MS = 1000;
const MAX_ROWS = 6;
const CONSUME = { consume: true } as const;

// "2 running · 1 done": one count per state, in the order a reader cares about.
function summary(entries: RosterEntry[], theme: Theme): string {
	const counts = new Map<string, number>();
	for (const { child } of entries) counts.set(stateLabel(child.state), (counts.get(stateLabel(child.state)) ?? 0) + 1);
	const order = ["running", "paused", "failed", "done"];
	const labels = [...counts.keys()].sort((a, b) => rank(order, a) - rank(order, b));
	return labels.map((label) => stateColor(label, theme)(`${counts.get(label)} ${label}`)).join(theme.fg("dim", " · "));
}

function rank(order: string[], label: string): number {
	const index = order.indexOf(label);
	return index === -1 ? order.length : index;
}

// One row's plain-text cells; `row` pads and colors them.
interface Cells {
	name: string;
	task: string;
	state: string;
	elapsed: string;
	context: string;
}

function cells(entry: RosterEntry, task: string, now: number): Cells {
	const { child } = entry;
	const end = isActive(child) ? now : (child.endedAt ?? now);
	return {
		name: entry.step ? `${child.agent} ${entry.step}` : child.agent,
		task,
		state: stateLabel(child.state),
		elapsed: child.startedAt === undefined ? "" : formatDuration(end - child.startedAt),
		context: child.context === undefined ? "" : formatContext(child.context, child.contextLimit),
	};
}

type Widths = Record<keyof Cells, number>;

// Every column as wide as its widest cell; only the task column gives way when the terminal is narrow.
function columnWidths(table: Cells[], width: number): Widths {
	const widest = (key: keyof Cells) => Math.max(0, ...table.map((cells) => visibleWidth(cells[key])));
	const widths = { name: widest("name"), task: 0, state: widest("state"), elapsed: widest("elapsed"), context: widest("context") };
	const fixed = ROW_INDENT + widths.name + widths.state + widths.elapsed + widths.context + 4 * GAP.length;
	return { ...widths, task: Math.max(0, Math.min(widest("task"), MAX_TASK_WIDTH, width - fixed)) };
}

// Keeps state, time and context next to the task on a wide terminal instead of at its far edge.
const MAX_TASK_WIDTH = 80;

// "  › delegate  Run the bash command sleep 150…  running  1m 20s  24.4k / 262k ctx"
function row(cells: Cells, selected: boolean, widths: Widths, width: number, theme: Theme): string {
	const name = pad(cells.name, widths.name);
	const task = pad(truncateToWidth(cells.task, widths.task, "…"), widths.task);
	const columns = [
		`  ${selected ? theme.fg("accent", "›") : " "} ${selected ? theme.bold(name) : name}`,
		theme.fg("muted", task),
		stateColor(cells.state, theme)(pad(cells.state, widths.state)),
		theme.fg("dim", padStart(cells.elapsed, widths.elapsed)),
		theme.fg("dim", padStart(cells.context, widths.context)),
	];
	return truncateToWidth(columns.join(GAP), width);
}

// Width of "  › " before the name column.
const ROW_INDENT = 4;
const GAP = "  ";

function pad(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function padStart(text: string, width: number): string {
	return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}

function stateLabel(state: string): string {
	if (state === "queued") return "running";
	if (state === "complete" || state === "completed") return "done";
	if (state === "error") return "failed";
	return state;
}

function stateColor(label: string, theme: Theme): (text: string) => string {
	const color = label === "running" ? "accent" : label === "done" ? "success" : label === "failed" ? "error" : "warning";
	return (text) => theme.fg(color, text);
}
