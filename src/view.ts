// Full-screen child view: a pi-style transcript above an editor, shown over the main chat.
import {
	type EventBus,
	type ExtensionContext,
	getSelectListTheme,
	keyHint,
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
} from "@earendil-works/pi-tui";
import { interrupt, type RunTarget, steer } from "./rpc.ts";
import { Transcript, type TranscriptDisplay } from "./transcript.ts";

/** What the view shows and where its input goes. */
export interface ViewTarget {
	title: string;
	sessionFile: string;
	run: RunTarget;
}

/** Show `target` over the main chat until the user closes it; resolves on close. */
export async function openView(target: ViewTarget, events: EventBus, ctx: ExtensionContext): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, keybindings, done) => new ChildView(tui, theme, keybindings, target, events, ctx.cwd, done),
		// Covers the whole terminal so the child reads like the main chat, not a dialog.
		{ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } },
	);
}

const HEADER_ROWS = 1;
const STATUS_ROWS = 1;

class ChildView implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly target: ViewTarget;
	private readonly events: EventBus;
	private readonly done: () => void;
	private readonly display: TranscriptDisplay = { toolsExpanded: false, hideThinking: false };
	private readonly transcript: Transcript;
	private readonly editor: Editor;
	// Lines hidden below the viewport; 0 keeps the view pinned to the newest output.
	private scrollFromEnd = 0;
	private transcriptRows = 0;
	private status = "";
	private focusedValue = false;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		target: ViewTarget,
		events: EventBus,
		cwd: string,
		done: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.target = target;
		this.events = events;
		this.done = done;
		this.transcript = new Transcript(tui, cwd, this.display);
		this.editor = new Editor(tui, {
			borderColor: (text) => theme.fg("borderMuted", text),
			selectList: getSelectListTheme(),
		});
		this.editor.onSubmit = (text) => this.submit(text);
		this.reload();
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
		this.transcriptRows = Math.max(1, rows - HEADER_ROWS - STATUS_ROWS - editorLines.length);
		const body = this.transcript.render(width);
		const maxScroll = Math.max(0, body.length - this.transcriptRows);
		this.scrollFromEnd = Math.min(this.scrollFromEnd, maxScroll);
		const end = body.length - this.scrollFromEnd;
		const visible = body.slice(Math.max(0, end - this.transcriptRows), end);
		const padding = Array.from({ length: this.transcriptRows - visible.length }, () => "");
		return [this.renderHeader(width), ...padding, ...visible, ...editorLines, this.renderStatus(width)];
	}

	handleInput(data: string): void {
		const kb = this.keybindings;
		if (kb.matches(data, "app.exit") && this.editor.getText() === "") return this.done();
		if (kb.matches(data, "app.interrupt")) return void this.interrupt();
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

	private reload(): void {
		try {
			this.transcript.load(this.target.sessionFile);
		} catch (error) {
			this.status = `Cannot read ${this.target.sessionFile}: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	private async submit(text: string): Promise<void> {
		const message = text.trim();
		if (!message) return;
		this.editor.setText("");
		this.setStatus("Sending…");
		// "auto" steers a busy child and queues a follow-up for an idle one.
		const result = await steer(this.events, this.target.run, message, "auto");
		this.setStatus(result.ok ? result.text || "Delivered." : result.error);
	}

	private async interrupt(): Promise<void> {
		this.setStatus("Interrupting…");
		const result = await interrupt(this.events, this.target.run);
		this.setStatus(result.ok ? result.text || "Interrupted." : result.error);
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

	private renderHeader(width: number): string {
		const position = this.scrollFromEnd > 0 ? this.theme.fg("dim", ` · ↑${this.scrollFromEnd}`) : "";
		return truncateToWidth(`${this.theme.fg("accent", this.theme.bold(this.target.title))}${position}`, width);
	}

	private renderStatus(width: number): string {
		const hints = [
			keyHint("tui.input.submit", "send"),
			keyHint("app.interrupt", "interrupt"),
			keyHint("app.tools.expand", "tools"),
			keyHint("app.exit", "close"),
		].join(" · ");
		return truncateToWidth(this.status ? `${this.theme.fg("dim", this.status)} · ${hints}` : hints, width);
	}
}
