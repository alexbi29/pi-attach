// Compact text shared by the view and the inline list: context size, durations and key hints.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Keybinding } from "@earendil-works/pi-tui";

/** "24.4k / 262k ctx": tokens in the context window out of its size; just "24.4k ctx" when the size is unknown. */
export function formatContext(context: number, limit: number | undefined): string {
	return limit === undefined ? `${formatCount(context)} ctx` : `${formatCount(context)} / ${formatLimit(limit)} ctx`;
}

// 950 → "950", 24_416 → "24.4k", 2_400_000 → "2.4M".
function formatCount(value: number): string {
	if (value < 1000) return String(Math.round(value));
	return value < 1_000_000 ? `${(value / 1000).toFixed(1)}k` : `${(value / 1_000_000).toFixed(1)}M`;
}

// Window sizes are round numbers in practice: 262_144 → "262k", 1_000_000 → "1M".
function formatLimit(value: number): string {
	if (value < 1000) return String(value);
	if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
	return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
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
