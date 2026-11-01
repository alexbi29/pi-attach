// The subagent list itself: rows, selection, scope and keys. Drawn under the main editor and inside the child view.
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { contextColor, formatContext, formatDuration, shortKeyHint, stateColor, stateLabel } from "./format.ts";
import type { ChildStatus, RunStatus } from "./run-status.ts";
import { readTask } from "./task.ts";
import type { ViewTarget } from "./view.ts";

/** One listed child: where to open it and what its row shows. */
export interface RosterEntry {
	key: string;
	target: ViewTarget;
	child: ChildStatus;
	/** "2/4" for a child of a multi-step run; absent for a single child. */
	step?: string;
	/** When the child ended; absent while it is active. */
	endedAt?: number;
}

/** What a key did to an open list. */
export type ListKeyResult =
	| { kind: "consumed" }
	// The list closed and the key belongs to the editor (typing leaves the list).
	| { kind: "passed" }
	| { kind: "open"; target: ViewTarget }
	// The "main" row of a list inside the child view.
	| { kind: "main" };

/** Where a list lives: under the main editor, or inside the child view, where a "main" row leads back. */
export type ListPlace = "main" | "view";

/** The list key of a child: its run id and index. */
export function targetKey(target: ViewTarget): string {
	return `${target.runId}:${target.index}`;
}

/**
 * Every started conversation in `runs`, one row each: active ones first, then the rest; newest first in each.
 * A resumed child is a new run writing the same session file, so only its newest run is listed.
 */
export function rosterEntries(runs: RunStatus[]): RosterEntry[] {
	const children = runs.flatMap((run) =>
		run.children.flatMap((child, index): RosterEntry[] => {
			// A child that has not started has nothing to show yet.
			if (child.state === "pending") return [];
			const endedAt = isActive(child) ? undefined : (child.endedAt ?? run.endedAt);
			const target = { runId: run.runId, asyncDir: run.asyncDir, index };
			return [
				{
					key: targetKey(target),
					target,
					child,
					...(run.children.length > 1 ? { step: `${index + 1}/${run.children.length}` } : {}),
					...(endedAt === undefined ? {} : { endedAt }),
				},
			];
		}),
	);
	return latestPerSession(children).sort(
		(a, b) => Number(isActive(b.child)) - Number(isActive(a.child)) || (b.child.startedAt ?? 0) - (a.child.startedAt ?? 0),
	);
}

/** Whether `entry` belongs to the default view at `now`: active (no end time), or ended in the last 10 minutes. */
export function isRecent(entry: RosterEntry, now: number): boolean {
	return entry.endedAt === undefined || now - entry.endedAt <= RECENT_MS;
}

/** "2 running · 1 done": one count per state, in the order a reader cares about. */
export function summary(entries: RosterEntry[], theme: Theme): string {
	const counts = new Map<string, number>();
	for (const { child } of entries) {
		const label = stateLabel(child.state, child.waiting);
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	const order = ["asking", "attention", "running", "paused", "failed", "done"];
	const labels = [...counts.keys()].sort((a, b) => rank(order, a) - rank(order, b));
	return labels.map((label) => stateColor(label, theme)(`${counts.get(label)} ${label}`)).join(theme.fg("dim", " · "));
}

// The old run stays behind as "paused" or "done" after a resume; opening it shows the same conversation.
function latestPerSession(entries: RosterEntry[]): RosterEntry[] {
	const latest = new Map<string, RosterEntry>();
	const unsaved: RosterEntry[] = [];
	for (const entry of entries) {
		const file = entry.child.sessionFile;
		if (!file) unsaved.push(entry);
		else if ((entry.child.startedAt ?? 0) >= (latest.get(file)?.child.startedAt ?? -1)) latest.set(file, entry);
	}
	return [...latest.values(), ...unsaved];
}

// Long enough to read a result after a child ends; Tab in the list shows older ones.
const RECENT_MS = 10 * 60_000;

function isActive(child: ChildStatus): boolean {
	return child.state === "running" || child.state === "queued";
}

function rank(order: string[], label: string): number {
	const index = order.indexOf(label);
	return index === -1 ? order.length : index;
}

// Which children the open list shows; it always opens on "recent" unless only older ones exist.
type Scope = "recent" | "all";

// A list row: the way back to the main session (inside the child view only) or a child.
type Row = { kind: "main" } | { kind: "child"; entry: RosterEntry };

const MAIN_KEY = "main";

/** The list's state for one place; the owner feeds it run records and draws what it renders. */
export class ChildList {
	private readonly place: ListPlace;
	// Task lines by session file: a child's task never changes, so its file is read once.
	private readonly tasks = new Map<string, string>();
	private all: RosterEntry[] = [];
	private recent: RosterEntry[] = [];
	private scope: Scope = "recent";
	private selectedKey: string | undefined;
	// The child the view shows; it stays listed even when it is no longer recent.
	private current: string | undefined;
	private openValue = false;

	constructor(place: ListPlace) {
		this.place = place;
	}

	/** Whether ↑↓ move the selection instead of the editor cursor. */
	get isOpen(): boolean {
		return this.openValue;
	}

	/** Active children and those that ended in the last 10 minutes, the current child aside. */
	others(): RosterEntry[] {
		return this.recent.filter((entry) => entry.key !== this.current);
	}

	/** Move the selection to `key` when it is listed. */
	select(key: string): void {
		if (this.rows().some((row) => rowKey(row) === key)) this.selectedKey = key;
	}

	/** Mark the child the view now shows. */
	setCurrent(target: ViewTarget): void {
		this.current = targetKey(target);
	}

	/** Take the latest run records; read once a second by the owner. */
	update(runs: RunStatus[], now: number): void {
		this.all = rosterEntries(runs);
		this.recent = this.all.filter((entry) => isRecent(entry, now) || entry.key === this.current);
		for (const { child } of this.entries()) {
			if (!child.sessionFile || this.tasks.has(child.sessionFile)) continue;
			const task = readTask(child.sessionFile);
			if (task) this.tasks.set(child.sessionFile, task);
		}
		const rows = this.rows();
		if (rows.length === 0) this.close();
		else if (!rows.some((row) => rowKey(row) === this.selectedKey)) this.selectedKey = rowKey(rows[0] as Row);
	}

	/** Open on recent children (all of them when none is recent), with the current child or the first row selected. */
	open(): boolean {
		this.scope = this.recent.length > 0 || this.place === "view" ? "recent" : "all";
		const rows = this.rows();
		if (rows.length === 0) return false;
		this.selectedKey = rows.some((row) => rowKey(row) === this.current) ? this.current : rowKey(rows[0] as Row);
		this.openValue = true;
		return true;
	}

	close(): void {
		this.openValue = false;
		this.scope = "recent";
	}

	/** A key pressed while the list is open. */
	handleKey(data: string): ListKeyResult {
		const kb = getKeybindings();
		const rows = this.rows();
		const index = this.selectedIndex(rows);
		if (kb.matches(data, "tui.select.down")) {
			this.selectedKey = rowKey(rows[Math.min(index + 1, rows.length - 1)] as Row);
		} else if (kb.matches(data, "tui.select.up")) {
			// Up from the first row hands the keys back to the editor, as if the list were below it.
			if (index === 0) this.close();
			else this.selectedKey = rowKey(rows[index - 1] as Row);
		} else if (kb.matches(data, "tui.select.confirm")) {
			return this.confirm(rows[index]);
		} else if (kb.matches(data, "tui.input.tab")) {
			this.toggleScope();
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.close();
		} else {
			this.close();
			return { kind: "passed" };
		}
		return { kind: "consumed" };
	}

	/** The open list: one row per child (plus "main" in the view) and a hint line. */
	render(width: number, theme: Theme): string[] {
		const rows = this.rows();
		const index = this.selectedIndex(rows);
		const start = index < MAX_ROWS ? 0 : index - MAX_ROWS + 1;
		const now = Date.now();
		// Column widths come from every row, not just the visible ones, so scrolling never shifts them.
		const table = rows.map((row) => (row.kind === "main" ? MAIN_CELLS : cells(row.entry, this.taskOf(row.entry.child), now)));
		const widths = columnWidths(table, width);
		const visible = table.slice(start, start + MAX_ROWS).map((rowCells, offset) => {
			const row = rows[start + offset] as Row;
			return renderRow(rowCells, { selected: start + offset === index, current: rowKey(row) === this.current }, widths, width, theme);
		});
		const hidden = rows.length - visible.length;
		const older = this.all.length - this.recent.length;
		const hints = [
			shortKeyHint("tui.select.confirm", "open", theme),
			...(this.canToggle() ? [shortKeyHint("tui.input.tab", this.scope === "all" ? "recent only" : `${older} older`, theme)] : []),
			shortKeyHint("tui.select.cancel", "back", theme),
			...(hidden > 0 ? [theme.fg("dim", `${hidden} more`)] : []),
		];
		return [...visible, truncateToWidth(`  ${hints.join(theme.fg("dim", " · "))}`, width)];
	}

	private entries(): RosterEntry[] {
		return this.scope === "all" ? this.all : this.recent;
	}

	private rows(): Row[] {
		const children = this.entries().map((entry): Row => ({ kind: "child", entry }));
		return this.place === "view" ? [{ kind: "main" }, ...children] : children;
	}

	private confirm(row: Row | undefined): ListKeyResult {
		if (!row) return { kind: "consumed" };
		if (row.kind === "main") return { kind: "main" };
		// Enter on the child already shown just closes the list.
		if (row.entry.key === this.current) {
			this.close();
			return { kind: "consumed" };
		}
		return { kind: "open", target: row.entry.target };
	}

	private toggleScope(): void {
		if (!this.canToggle()) return;
		this.scope = this.scope === "all" ? "recent" : "all";
		const rows = this.rows();
		if (!rows.some((row) => rowKey(row) === this.selectedKey)) this.selectedKey = rowKey(rows[0] as Row);
	}

	// "all" needs older children to add anything; "recent" needs at least one row to show.
	private canToggle(): boolean {
		return this.scope === "recent" ? this.all.length > this.recent.length : this.recent.length > 0;
	}

	private selectedIndex(rows: Row[]): number {
		return Math.max(
			0,
			rows.findIndex((row) => rowKey(row) === this.selectedKey),
		);
	}

	// pi-subagents' session name holds only the task's first 60 or so characters; the session file has all of it.
	private taskOf(child: ChildStatus): string {
		return (child.sessionFile ? this.tasks.get(child.sessionFile) : undefined) ?? child.task ?? "";
	}
}

const MAX_ROWS = 6;

function rowKey(row: Row): string {
	return row.kind === "main" ? MAIN_KEY : row.entry.key;
}

// One row's plain-text cells; `renderRow` pads and colors them.
interface Cells {
	name: string;
	task: string;
	model: string;
	state: string;
	elapsed: string;
	context: string;
	contextColor: ThemeColor;
}

const MAIN_CELLS: Cells = { name: "main", task: "the main session", model: "", state: "", elapsed: "", context: "", contextColor: "text" };

function cells(entry: RosterEntry, task: string, now: number): Cells {
	const { child } = entry;
	const end = isActive(child) ? now : (child.endedAt ?? now);
	return {
		name: entry.step ? `${child.agent} ${entry.step}` : child.agent,
		task,
		// Without the provider: it costs width and rarely tells children apart.
		model: child.model ?? "",
		state: stateLabel(child.state, child.waiting),
		elapsed: child.startedAt === undefined ? "" : formatDuration(end - child.startedAt),
		context: child.context === undefined ? "" : formatContext(child.context, child.contextLimit),
		contextColor: contextColor(child.context ?? 0, child.contextLimit, "text"),
	};
}

type Widths = Record<Exclude<keyof Cells, "contextColor">, number>;

// Every column as wide as its widest cell, except the task: it takes the rest of the width, so the last
// column ends at the terminal's edge, where pi's footer puts the model.
function columnWidths(table: Cells[], width: number): Widths {
	const widest = (key: keyof Widths) => Math.max(0, ...table.map((cells) => visibleWidth(cells[key])));
	const widths = {
		name: widest("name"),
		task: 0,
		model: widest("model"),
		state: widest("state"),
		elapsed: widest("elapsed"),
		context: widest("context"),
	};
	// Each shown column after the name brings one gap; the task's own gap is counted here too.
	const shown = [widths.model, widths.state, widths.elapsed, widths.context].filter((columnWidth) => columnWidth > 0);
	const fixed = ROW_INDENT + widths.name + shown.reduce((sum, columnWidth) => sum + columnWidth + GAP.length, 0) + GAP.length;
	return { ...widths, task: Math.max(0, width - fixed) };
}

// "› delegate  Run the bash command sleep 150…  deepseek-v4-flash  running  1m 20s  24k / 262k ctx"
function renderRow(cells: Cells, mark: { selected: boolean; current: boolean }, widths: Widths, width: number, theme: Theme): string {
	const padded = pad(cells.name, widths.name);
	// The child the view shows reads in the accent color; the selection is the cursor and bold.
	const tinted = mark.current ? theme.fg("accent", padded) : padded;
	const name = mark.selected ? theme.bold(tinted) : tinted;
	const columns: [number, string][] = [
		[widths.task, theme.fg("muted", pad(truncateToWidth(cells.task, Math.max(0, widths.task - TASK_MARGIN), "…"), widths.task))],
		[widths.model, theme.fg("dim", pad(cells.model, widths.model))],
		[widths.state, stateColor(cells.state, theme)(pad(cells.state, widths.state))],
		// Each column its own tone: time in a quiet blue, context in plain text unless it is filling up.
		[widths.elapsed, theme.fg("mdLink", padStart(cells.elapsed, widths.elapsed))],
		[widths.context, theme.fg(cells.contextColor, padStart(cells.context, widths.context))],
	];
	// A column empty in every row (no model known, say) is left out with its gap.
	const shown = columns.filter(([columnWidth]) => columnWidth > 0).map(([, text]) => text);
	return truncateToWidth([`${mark.selected ? theme.fg("accent", "›") : " "} ${name}`, ...shown].join(GAP), width);
}

// Blank columns kept after a long task, so its text does not run into the model and the numbers.
const TASK_MARGIN = 10;

// Width of "› " before the name column. Rows start flush left like the editor and pi's footer; hints line up with names.
const ROW_INDENT = 2;
const GAP = "  ";

function pad(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function padStart(text: string, width: number): string {
	return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}
