// Compact text shared by the view and the inline list: token counts, durations and key hints.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Keybinding } from "@earendil-works/pi-tui";

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
