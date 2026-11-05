// Full-screen child view: a pi-style transcript above an editor, shown over the main chat.
import {
	type EventBus,
	type ExtensionContext,
	getSelectListTheme,
	SettingsManager,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type Focusable,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { type FSWatcher, watch } from "node:fs";
import { dirname, join } from "node:path";
import { ChildList, summary } from "./child-list.ts";
import type { MainActivity } from "./main-activity.ts";
import { contextColor, formatDuration, formatTokens, shortKeyHint, spread, stateColor, stateLabel } from "./format.ts";
import { connectLiveStream, type LiveStreamConnection, type StreamFrame } from "./live-stream.ts";
import { interrupt, resume, steer } from "./rpc.ts";
import { type ChildStatus, type RunStatus, readRunStatus, type SessionRuns } from "./run-status.ts";
import { readTask } from "./task.ts";
import { Transcript, type TranscriptDisplay } from "./transcript.ts";

/** One child of an async run: the run's id and directory plus the child's index in it. */
export interface ViewTarget {
	runId: string;
	asyncDir: string;
	index: number;
}

/** What the view works with besides its target: pi-subagents' RPC, the main session's activity, its runs. */
export interface ViewServices {
	events: EventBus;
	main: MainActivity;
	/** This session's runs, for the list inside the view; absent for an unsaved session. */
	runs: SessionRuns | undefined;
	/** pi-subagents' long tool call threshold, for reading the shown child's run record. */
	longToolMs: number;
}

/** Whether the view starts with its subagent list open: it does when entered from the list, to stay in it. */
export type ListStart = "open" | "closed";

/** How the user left the view: Enter on the list's "main" row, or back (Esc) from the child shown last. */
export type ViewExit = { kind: "main" } | { kind: "back"; shown: ViewTarget };

/** Show `target` over the main chat until the user closes it; resolves with how they left. */
export async function openView(
	target: ViewTarget,
	list: ListStart,
	services: ViewServices,
	ctx: ExtensionContext,
): Promise<ViewExit | undefined> {
	// Start as the main chat shows things. pi saves its thinking toggle to settings on every press, so the file
	// is current; toggles inside the view stay in the view.
	const display: TranscriptDisplay = {
		toolsExpanded: ctx.ui.getToolsExpanded(),
		hideThinking: SettingsManager.create(ctx.cwd).getHideThinkingBlock(),
	};
	return ctx.ui.custom<ViewExit>(
		(tui, theme, keybindings, done) => new ChildView(tui, theme, keybindings, target, list, services, display, ctx.cwd, done),
		// Covers the whole terminal so the child reads like the main chat, not a dialog.
		{ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } },
	);
}

// Child states that take live input; any other state is revived with `resume`.
const STEERABLE_STATES = new Set(["running", "queued"]);
const HEADER_ROWS = 1;
// The key hint row and pi's stats line.
const STATUS_ROWS = 2;
// File watchers fire in bursts while the child writes; one sync per burst is enough.
const SYNC_DEBOUNCE_MS = 30;
// Safety net for missed watcher events and the clock in the header.
const TICK_MS = 1000;

class ChildView implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	// Replaced when a resume continues the child as a new async run.
	private target: ViewTarget;
	private readonly events: EventBus;
	private readonly done: (exit: ViewExit) => void;
	private readonly main: MainActivity;
	private readonly runs: SessionRuns | undefined;
	private readonly longToolMs: number;
	// The same list as under the main editor, always on screen here so main and the other children are one
	// hop away; ↓ on an empty editor moves the cursor into it.
	private readonly list: ChildList | undefined;
	private readonly stopMain: () => void;
	private readonly display: TranscriptDisplay;
	private readonly transcript: Transcript;
	private readonly editor: Editor;
	private run: RunStatus | undefined;
	private watchedSessionFile: string | undefined;
	private runWatcher: FSWatcher | undefined;
	private sessionWatcher: FSWatcher | undefined;
	private live: LiveStreamConnection | undefined;
	private readonly tick: NodeJS.Timeout;
	private syncTimer: NodeJS.Timeout | undefined;
	// Lines hidden below the viewport; 0 keeps the view pinned to the newest output.
	private scrollFromEnd = 0;
	private transcriptRows = 0;
	private lastBodyLength = 0;
	private status = "";
	// The child's task line for the header; read from its session file once the task is written.
	private task: string | undefined;
	private focusedValue = false;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		target: ViewTarget,
		listStart: ListStart,
		services: ViewServices,
		display: TranscriptDisplay,
		cwd: string,
		done: (exit: ViewExit) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.target = target;
		this.events = services.events;
		this.runs = services.runs;
		this.longToolMs = services.longToolMs;
		this.list = services.runs ? new ChildList() : undefined;
		this.list?.setCurrent(target);
		this.done = done;
		this.main = services.main;
		this.display = display;
		this.main.markSeen();
		this.stopMain = this.main.onChange(() => tui.requestRender());
		this.transcript = new Transcript(tui, cwd, this.display);
		this.editor = new Editor(tui, {
			borderColor: (text) => theme.fg("borderMuted", text),
			selectList: getSelectListTheme(),
		});
		this.editor.onSubmit = (text) => this.submit(text);
		this.sync();
		// The first sync gave the list its rows, so it can open now.
		if (listStart === "open") this.list?.open();
		this.runWatcher = this.watch(target.asyncDir);
		this.tick = setInterval(() => this.sync(), TICK_MS);
	}

	get focused(): boolean {
		return this.focusedValue;
	}

	set focused(value: boolean) {
		this.focusedValue = value;
		this.editor.focused = value;
	}

	render(width: number): string[] {
		const rows = this.tui.terminal.rows;
		const editorLines = this.editor.render(width);
		const listLines = this.list ? this.list.render(width, this.theme) : [];
		this.transcriptRows = Math.max(1, rows - HEADER_ROWS - STATUS_ROWS - editorLines.length - listLines.length);
		const body = this.transcript.render(width);
		// Keep the lines the user scrolled to in place while new output arrives below them.
		if (this.scrollFromEnd > 0 && body.length > this.lastBodyLength) {
			this.scrollFromEnd += body.length - this.lastBodyLength;
		}
		this.lastBodyLength = body.length;
		const maxScroll = Math.max(0, body.length - this.transcriptRows);
		this.scrollFromEnd = Math.min(this.scrollFromEnd, maxScroll);
		const end = body.length - this.scrollFromEnd;
		const visible = body.slice(Math.max(0, end - this.transcriptRows), end);
		const padding = Array.from({ length: this.transcriptRows - visible.length }, () => "");
		return [
			this.renderHeader(width),
			...padding,
			...visible,
			...editorLines,
			...listLines,
			this.renderStatus(width),
			this.renderFooter(width),
		];
	}

	handleInput(data: string): void {
		const kb = this.keybindings;
		if (this.list?.isOpen) return this.handleListKey(this.list, data);
		// Esc means "back" here, not pi's abort: leaving the view must never stop the child by accident.
		if (kb.matches(data, "app.interrupt")) return this.back();
		if (kb.matches(data, "app.exit") && this.editor.getText() === "") return this.back();
		if (this.list && kb.matches(data, "tui.editor.cursorDown") && this.editor.getText() === "") {
			this.list.open();
			return this.tui.requestRender();
		}
		if (kb.matches(data, "app.clear")) return this.clearOrInterrupt();
		if (kb.matches(data, "app.tools.expand")) return this.toggle("toolsExpanded");
		if (kb.matches(data, "app.thinking.toggle")) return this.toggle("hideThinking");
		if (kb.matches(data, "tui.altScreen.pageUp")) return this.scroll(this.transcriptRows);
		if (kb.matches(data, "tui.altScreen.pageDown")) return this.scroll(-this.transcriptRows);
		if (kb.matches(data, "tui.altScreen.halfPageUp")) return this.scroll(Math.ceil(this.transcriptRows / 2));
		if (kb.matches(data, "tui.altScreen.halfPageDown")) return this.scroll(-Math.ceil(this.transcriptRows / 2));
		this.editor.handleInput(data);
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// Wheel deltas are positive downwards; scrollFromEnd grows upwards.
		if (event.type === "wheel") this.scroll(-(event.wheelDelta ?? 0));
		// Own every event: anything unhandled would reach the main chat behind the overlay.
		return { handled: true, render: event.type === "wheel" };
	}

	invalidate(): void {
		this.transcript.invalidate();
		this.editor.invalidate();
	}

	dispose(): void {
		this.stopMain();
		clearInterval(this.tick);
		clearTimeout(this.syncTimer);
		this.runWatcher?.close();
		this.sessionWatcher?.close();
		this.live?.close();
	}

	private get child(): ChildStatus | undefined {
		return this.run?.children[this.target.index];
	}

	// A path can vanish or not exist yet (a fresh run directory); the tick covers it until it does.
	private watch(path: string): FSWatcher | undefined {
		try {
			return watch(path, () => this.scheduleSync());
		} catch {
			return undefined;
		}
	}

	private scheduleSync(): void {
		clearTimeout(this.syncTimer);
		this.syncTimer = setTimeout(() => this.sync(), SYNC_DEBOUNCE_MS);
	}

	// Re-read the run record and the session file; render when either changed or the header clock runs.
	private sync(): void {
		const previous = JSON.stringify(this.run);
		this.run = readRunStatus(this.target.asyncDir, this.target.runId, this.longToolMs) ?? this.run;
		let changed = JSON.stringify(this.run) !== previous;
		const sessionFile = this.child?.sessionFile;
		try {
			if (sessionFile && sessionFile !== this.watchedSessionFile) {
				// The runner records the session file only once the child session exists.
				this.watchedSessionFile = sessionFile;
				this.transcript.open(sessionFile);
				this.sessionWatcher?.close();
				this.sessionWatcher = this.watch(sessionFile);
				changed = true;
			} else {
				changed = this.transcript.refresh() || changed;
			}
			if (!this.task && this.watchedSessionFile) {
				this.task = readTask(this.watchedSessionFile);
				changed = changed || this.task !== undefined;
			}
		} catch (error) {
			this.status = `Cannot read ${sessionFile}: ${error instanceof Error ? error.message : String(error)}`;
			changed = true;
		}
		this.connectLive();
		if (this.runs) this.list?.update(this.runs.list(), Date.now());
		// The list's times and states move every tick.
		if (changed || this.run?.endedAt === undefined || this.list) this.tui.requestRender();
	}

	// The child opens its socket at session start; until then (and after it ends) each tick retries.
	private connectLive(): void {
		const sessionFile = this.watchedSessionFile;
		if (this.live || !sessionFile || !STEERABLE_STATES.has(this.child?.state ?? "")) return;
		const connection = connectLiveStream(
			sessionFile,
			(frame) => this.onFrame(frame),
			() => {
				if (this.live === connection) this.live = undefined;
			},
		);
		this.live = connection;
	}

	private onFrame(frame: StreamFrame): void {
		switch (frame.type) {
			case "partial":
				this.transcript.showPartial(frame.message);
				break;
			case "tool_start":
				this.transcript.markToolStarted(frame.toolCallId);
				break;
			case "tool_update":
				this.transcript.showToolOutput(frame.toolCallId, frame.output);
				break;
			case "message_end":
				// The finished message lands in the session file next; pick it up without waiting for the tick.
				this.scheduleSync();
				break;
		}
		this.tui.requestRender();
	}

	private async submit(text: string): Promise<void> {
		const message = text.trim();
		if (!message) return;
		this.editor.setText("");
		// Like the main chat, sending jumps back to the newest output.
		this.scrollFromEnd = 0;
		this.setStatus("Sending…");
		if (STEERABLE_STATES.has(this.child?.state ?? "")) {
			// "auto" steers a busy child and queues a follow-up for an idle one.
			const result = await steer(this.events, this.runTarget(), message, "auto");
			return this.setStatus(result.ok ? result.text || "Delivered." : result.error);
		}
		const result = await resume(this.events, this.runTarget(), message);
		if (!result.ok) return this.setStatus(result.error);
		if (!result.runId) return this.setStatus(result.text || "Resumed.");
		this.follow({
			runId: result.runId,
			// pi-subagents keeps every async run directory side by side, named after its run id.
			asyncDir: result.asyncDir ?? join(dirname(this.target.asyncDir), result.runId),
			index: 0,
		});
		this.setStatus(`Resumed as ${result.runId.slice(0, 8)}.`);
	}

	// Switch to the run a resume started; its session usually continues the same file.
	private follow(target: ViewTarget): void {
		this.target = target;
		this.list?.setCurrent(target);
		this.run = undefined;
		// The resumed child runs in a new runner process with its own socket.
		this.live?.close();
		this.live = undefined;
		this.runWatcher?.close();
		this.runWatcher = this.watch(target.asyncDir);
		this.sync();
	}

	private handleListKey(list: ChildList, data: string): void {
		const result = list.handleKey(data);
		if (result.kind === "main") return this.done({ kind: "main" });
		if (result.kind === "open") this.switchTo(list, result.target);
		// Typing leaves the list and goes on into the editor.
		if (result.kind === "passed") this.editor.handleInput(data);
		this.tui.requestRender();
	}

	// Another child replaces this one in place: the view is reused, not stacked. The list stays open on it,
	// so the next hop is one more ↓ or ↑; Esc or Enter on it closes the list to talk to that child.
	private switchTo(list: ChildList, target: ViewTarget): void {
		list.setCurrent(target);
		this.transcript.reset();
		this.watchedSessionFile = undefined;
		this.sessionWatcher?.close();
		this.sessionWatcher = undefined;
		this.task = undefined;
		this.status = "";
		this.scrollFromEnd = 0;
		this.lastBodyLength = 0;
		this.follow(target);
	}

	private back(): void {
		this.done({ kind: "back", shown: this.target });
	}

	private clearOrInterrupt(): void {
		if (this.editor.getText() === "") return void this.interrupt();
		this.editor.setText("");
		this.tui.requestRender();
	}

	private async interrupt(): Promise<void> {
		this.setStatus("Interrupting…");
		const result = await interrupt(this.events, this.runTarget());
		this.setStatus(result.ok ? result.text || "Interrupted." : result.error);
	}

	private runTarget() {
		return { id: this.target.runId, index: this.target.index };
	}

	private toggle(key: keyof TranscriptDisplay): void {
		this.display[key] = !this.display[key];
		this.transcript.applyDisplay();
		this.tui.requestRender();
	}

	private scroll(lines: number): void {
		this.scrollFromEnd = Math.max(0, this.scrollFromEnd + lines);
		this.tui.requestRender();
	}

	private setStatus(text: string): void {
		// RPC replies are multi-line reports; the status row shows their first line.
		this.status = text.split("\n", 1)[0] ?? "";
		this.tui.requestRender();
	}

	// The title: which child this is and what it was asked to do, with its progress on the right.
	private renderHeader(width: number): string {
		const theme = this.theme;
		const child = this.child;
		const task = this.task ?? child?.task;
		const left = `${theme.fg("accent", theme.bold(child?.agent ?? "subagent"))} ${theme.fg("dim", this.target.runId.slice(0, 8))}${task ? `  ${theme.fg("muted", task)}` : ""}`;
		const facts = [
			child?.toolCount === undefined ? undefined : `${child.toolCount} tools`,
			this.run?.startedAt === undefined ? undefined : formatDuration((this.run.endedAt ?? Date.now()) - this.run.startedAt),
			this.scrollFromEnd > 0 ? `↑${this.scrollFromEnd}` : undefined,
		].filter((fact) => fact !== undefined);
		return spread(left, theme.fg("dim", facts.join(" · ")), width);
	}

	// Next to the editor, where the eyes are: whose editor this is, its state and the last reply, then the keys.
	private renderStatus(width: number): string {
		const theme = this.theme;
		const child = this.child;
		const state = stateLabel(child?.state ?? this.run?.state ?? "starting", child?.waiting);
		const identity = `${theme.fg("accent", "subagent")} ${theme.bold(child?.agent ?? "subagent")} ${theme.fg("dim", "·")} ${stateColor(state, theme)(state)}`;
		const left = [identity, this.mainNote(), this.othersNote(), this.status ? theme.fg("dim", this.status) : undefined]
			.filter((part) => part !== undefined)
			.join(theme.fg("dim", " · "));
		const hints = [
			shortKeyHint("tui.input.submit", "send", theme),
			...(this.list ? [shortKeyHint("tui.editor.cursorDown", "agents", theme)] : []),
			shortKeyHint("app.clear", "interrupt", theme),
			shortKeyHint("app.tools.expand", "tools", theme),
			shortKeyHint("app.interrupt", "back to main", theme),
		].join(theme.fg("dim", " · "));
		return spread(left, hints, width);
	}

	// The main session is hidden behind the view; say when it is busy or has something new to read.
	private mainNote(): string | undefined {
		if (this.main.working) return this.theme.fg("dim", "main working");
		if (this.main.unseen > 0) return this.theme.fg("warning", `main: ${this.main.unseen} new`);
		return undefined;
	}

	// Other children waiting on an answer or a slow tool would otherwise go unseen while this one is open.
	private othersNote(): string | undefined {
		const waiting = this.list?.others().filter((entry) => entry.child.waiting) ?? [];
		return waiting.length > 0 ? summary(waiting, this.theme) : undefined;
	}

	// pi's own stats line, for the child: "↑194k ↓8.9k 9.3%/262k" left, "(intl) qwen3.8-flash-next • high" right.
	private renderFooter(width: number): string {
		const child = this.child;
		const theme = this.theme;
		// Each part is dimmed on its own: the colored context share ends in a reset that would end an outer dim.
		const left = [
			child?.input ? theme.fg("dim", `↑${formatTokens(child.input)}`) : undefined,
			child?.output ? theme.fg("dim", `↓${formatTokens(child.output)}`) : undefined,
			child?.context === undefined ? undefined : contextUsage(child.context, child.contextLimit, theme),
		].filter((part) => part !== undefined);
		// The session file knows the level the child runs at now; status.json only what it was launched with.
		const level = this.transcript.thinkingLevel !== "off" ? this.transcript.thinkingLevel : child?.thinking;
		const model = child?.model ? `${child.provider ? `(${child.provider}) ` : ""}${child.model}${level ? ` • ${level}` : ""}` : "";
		return spread(left.join(" "), theme.fg("dim", model), width);
	}
}

// "9.3%/262k", colored as pi's footer colors its own context use.
function contextUsage(context: number, limit: number | undefined, theme: Theme): string {
	if (!limit) return theme.fg("dim", formatTokens(context));
	return theme.fg(contextColor(context, limit, "dim"), `${((context / limit) * 100).toFixed(1)}%/${formatTokens(limit)}`);
}
