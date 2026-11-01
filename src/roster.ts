// The subagent list under the main editor: a one-line count, ↓ on an empty editor or the shortcut opens the list.
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Editor, getKeybindings, isKeyRelease, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { ChildList, summary, targetKey } from "./child-list.ts";
import { shortKeyHint } from "./format.ts";
import type { SessionRuns } from "./run-status.ts";
import type { ViewTarget } from "./view.ts";

/** The widget and its keys for one session; `dispose` removes both. */
export class Roster {
	private readonly runs: SessionRuns;
	// Shows the child view; resolves with the child shown last when the user leaves it.
	private readonly onOpen: (target: ViewTarget) => Promise<ViewTarget | undefined>;
	private readonly ctx: ExtensionContext;
	private readonly timer: NodeJS.Timeout;
	private readonly stopInput: () => void;
	private readonly list = new ChildList("main");
	// True while a child view this list opened covers the screen; the list waits underneath, still open.
	private viewing = false;
	private shown = false;
	private tui: TUI | undefined;

	constructor(runs: SessionRuns, onOpen: (target: ViewTarget) => Promise<ViewTarget | undefined>, ctx: ExtensionContext) {
		this.runs = runs;
		this.onOpen = onOpen;
		this.ctx = ctx;
		this.stopInput = ctx.ui.onTerminalInput((data) => this.handleKey(data));
		// Also ticks the elapsed time of running children.
		this.timer = setInterval(() => this.refresh(), REFRESH_MS);
		this.timer.unref();
		this.refresh();
	}

	/** Open the list from a shortcut or command: recent children, or all of them when none is recent. */
	show(): void {
		this.list.update(this.runs.list(), Date.now());
		if (!this.list.open()) return this.ctx.ui.notify("No subagent runs in this session yet.", "info");
		this.refresh();
	}

	dispose(): void {
		clearInterval(this.timer);
		this.stopInput();
		if (this.shown) this.ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	private refresh(): void {
		this.list.update(this.runs.list(), Date.now());
		if (!this.list.isOpen && this.list.others().length === 0) {
			if (this.shown) this.ctx.ui.setWidget(WIDGET_KEY, undefined);
			this.shown = false;
			return;
		}
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
		if (this.viewing || isKeyRelease(data) || !this.shown) return undefined;
		if (!this.editorFocused()) {
			if (this.list.isOpen) this.closeAndRefresh();
			return undefined;
		}
		if (!this.list.isOpen) {
			if (!getKeybindings().matches(data, "tui.editor.cursorDown") || this.ctx.ui.getEditorText() !== "") return undefined;
			if (this.list.open()) this.tui?.requestRender();
			return CONSUME;
		}
		const result = this.list.handleKey(data);
		if (result.kind === "open") void this.view(result.target);
		// Closing can hide rows ("all" back to "recent"), so the widget is recomputed.
		else this.refresh();
		return result.kind === "passed" ? undefined : CONSUME;
	}

	// Esc in the child view comes back to the list, on the child viewed last.
	private async view(target: ViewTarget): Promise<void> {
		this.viewing = true;
		try {
			const last = await this.onOpen(target);
			if (last) this.list.select(targetKey(last));
		} finally {
			this.viewing = false;
			this.refresh();
		}
	}

	private closeAndRefresh(): void {
		this.list.close();
		this.refresh();
	}

	// pi-tui keeps the focused component private. The main editor is the focused component with
	// getText/setText; while a dialog or an overlay (such as the child view) has focus, keys are left alone.
	private editorFocused(): boolean {
		const focused = (this.tui as unknown as { focusedComponent?: Partial<Editor> } | undefined)?.focusedComponent;
		return typeof focused?.getText === "function" && typeof focused.setText === "function";
	}

	private render(width: number, theme: Theme): string[] {
		if (this.list.isOpen) return this.list.render(width, theme);
		const others = this.list.others();
		if (others.length === 0) return [];
		return [truncateToWidth(`${summary(others, theme)} ${theme.fg("dim", "·")} ${shortKeyHint("tui.editor.cursorDown", "to open", theme)}`, width)];
	}
}

const WIDGET_KEY = "pi-attach-roster";
const REFRESH_MS = 1000;
const CONSUME = { consume: true } as const;
