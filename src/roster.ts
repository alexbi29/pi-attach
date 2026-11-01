// Inline list of this session's subagents under the editor: ↓ on an empty editor enters it, Enter opens one.
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Editor, getKeybindings, isKeyRelease, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatCount, formatDuration, shortKeyHint } from "./format.ts";
import type { ChildStatus, RunStatus, SessionRuns } from "./run-status.ts";
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

	private render(width: number, theme: Theme): string[] {
		if (this.entries.length === 0) return [];
		if (!this.active) {
			return [truncateToWidth(`  ${summary(this.entries, theme)} ${theme.fg("dim", "·")} ${shortKeyHint("tui.editor.cursorDown", "to open", theme)}`, width)];
		}
		const index = this.selectedIndex();
		const start = index < MAX_ROWS ? 0 : index - MAX_ROWS + 1;
		const visible = this.entries.slice(start, start + MAX_ROWS);
		const now = Date.now();
		const rows = visible.map((entry, offset) => row(entry, start + offset === index, now, width, theme));
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

// "› delegate  Run the bash command sleep 150…            running · 1m 20s · 3.6k tokens"
function row(entry: RosterEntry, selected: boolean, now: number, width: number, theme: Theme): string {
	const { child } = entry;
	const name = selected ? theme.bold(child.agent) : child.agent;
	const step = entry.step ? theme.fg("dim", ` ${entry.step}`) : "";
	const task = child.task ? `  ${theme.fg("muted", child.task)}` : "";
	const left = `  ${selected ? theme.fg("accent", "›") : " "} ${name}${step}${task}`;
	const label = stateLabel(child.state);
	const facts = [
		child.startedAt === undefined ? undefined : formatDuration((isActive(child) ? now : (child.endedAt ?? now)) - child.startedAt),
		child.tokens === undefined ? undefined : `${formatCount(child.tokens)} tokens`,
	].filter((fact) => fact !== undefined);
	const right = [stateColor(label, theme)(label), ...facts.map((fact) => theme.fg("dim", fact))].join(theme.fg("dim", " · "));
	return rightAlign(left, right, width);
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

function rightAlign(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	const clamped = truncateToWidth(left, Math.max(0, width - rightWidth - 1));
	const gap = Math.max(1, width - visibleWidth(clamped) - rightWidth);
	return truncateToWidth(`${clamped}${" ".repeat(gap)}${right}`, width);
}
