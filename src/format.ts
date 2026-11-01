// Text shared by the view and the inline list: token counts, durations, states, key hints and split lines.
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Keybinding, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Token counts as pi's footer writes them: 950, 3.6k, 24k, 262k, 1.2M, 12M. */
export function formatTokens(count: number): string {
	if (count < 1000) return String(Math.round(count));
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

/** "24k / 262k ctx": tokens in the context window out of its size; just "24k ctx" when the size is unknown. */
export function formatContext(context: number, limit: number | undefined): string {
	return limit === undefined ? `${formatTokens(context)} ctx` : `${formatTokens(context)} / ${formatTokens(limit)} ctx`;
}

/** pi's footer colors for context use: `normal` up to 70%, warning above, error above 90%. */
export function contextColor(context: number, limit: number | undefined, normal: ThemeColor): ThemeColor {
	const percent = limit ? (context / limit) * 100 : 0;
	return percent > 90 ? "error" : percent > 70 ? "warning" : normal;
}

/** 42_000 → "42s", 80_000 → "1m 20s". */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Like pi's keyHint, but names only the first bound key, in its short form: "esc back", not "escape/ctrl+c back". */
export function shortKeyHint(keybinding: Keybinding, description: string, theme: Theme): string {
	const key = getKeybindings().getKeys(keybinding)[0] ?? "";
	return theme.fg("dim", KEY_NAMES[key] ?? key) + theme.fg("muted", ` ${description}`);
}

const KEY_NAMES: Record<string, string> = { escape: "esc", up: "↑", down: "↓", left: "←", right: "→" };

/** `left` and `right` on one line, `right` flush with the edge; when both do not fit, `right` gives way first. */
export function spread(left: string, right: string, width: number): string {
	const leftText = truncateToWidth(left, width, "…");
	// pi's footer keeps at least two columns between its halves.
	const rightText = truncateToWidth(right, Math.max(0, width - visibleWidth(leftText) - 2), "");
	return leftText + " ".repeat(Math.max(0, width - visibleWidth(leftText) - visibleWidth(rightText))) + rightText;
}

/**
 * pi-subagents' state as the list and the view name it: "queued" counts as running, "complete" reads "done",
 * and a child waiting on its parent's answer ("asking") or on a slow tool ("attention") says so over its state.
 */
export function stateLabel(state: string, waiting?: "supervisor" | "tool"): string {
	if (waiting === "supervisor") return "asking";
	if (waiting === "tool") return "attention";
	if (state === "queued") return "running";
	if (state === "complete" || state === "completed") return "done";
	if (state === "error") return "failed";
	return state;
}

/** The color for a `stateLabel`: running accent, done success, failed error, anything else (asking, paused…) warning. */
export function stateColor(label: string, theme: Theme): (text: string) => string {
	const color = label === "running" ? "accent" : label === "done" ? "success" : label === "failed" ? "error" : "warning";
	return (text) => theme.fg(color, text);
}
