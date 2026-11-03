// User settings from `<agent dir>/extensions/pi-attach/config.json`; every key is optional.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

/** Settings the extension reads once at load. */
export interface Config {
	/** Key that opens the subagent list from anywhere; `false` registers none. */
	listShortcut: KeyId | false;
}

/** Defaults merged with the user's config file; a missing or broken file yields the defaults. */
export function loadConfig(): Config {
	const path = join(getAgentDir(), "extensions", "pi-attach", "config.json");
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return DEFAULTS;
	}
	// User-edited JSON: accept only the documented key types.
	const shortcut = (raw as { listShortcut?: unknown } | null)?.listShortcut;
	return {
		listShortcut: typeof shortcut === "string" || shortcut === false ? (shortcut as KeyId | false) : DEFAULTS.listShortcut,
	};
}

/**
 * Whether pi-subagents draws its own inline FleetView. The two lists would both take ↓ under the editor,
 * so pi-attach shows its list only once `"fleetView": false` is set in pi-subagents' config.
 */
export function fleetViewEnabled(): boolean {
	const path = join(getAgentDir(), "extensions", "subagent", "config.json");
	try {
		// pi-subagents' own file: only the documented boolean switch matters here.
		return (JSON.parse(readFileSync(path, "utf-8")) as { fleetView?: unknown } | null)?.fleetView !== false;
	} catch {
		return true;
	}
}

/**
 * How long a tool call runs before pi-subagents flags its child: `control.activeNoticeAfterMs` in
 * pi-subagents' config, 4 minutes by default. The list shows such a child as "long tool".
 */
export function longToolAfterMs(): number {
	const path = join(getAgentDir(), "extensions", "subagent", "config.json");
	let value: unknown;
	try {
		// pi-subagents' own file: only its documented positive integer matters here.
		value = (JSON.parse(readFileSync(path, "utf-8")) as { control?: { activeNoticeAfterMs?: unknown } } | null)?.control
			?.activeNoticeAfterMs;
	} catch {
		return DEFAULT_LONG_TOOL_MS;
	}
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : DEFAULT_LONG_TOOL_MS;
}

// pi-subagents' DEFAULT_CONTROL_CONFIG.activeNoticeAfterMs.
const DEFAULT_LONG_TOOL_MS = 240_000;

// Unbound in pi's default keymap. Not alt+a: macOS terminals type "å" for Option+A unless Option is set to send Meta.
// Ctrl+Shift needs a terminal that reports it (kitty keyboard protocol or modifyOtherKeys), as pi's own ctrl+shift keys do.
const DEFAULTS: Config = { listShortcut: "ctrl+shift+a" };
