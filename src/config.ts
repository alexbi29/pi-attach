// User settings from `<agent dir>/extensions/pi-sagent/config.json`; every key is optional.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

/** Settings the extension reads once at load. */
export interface Config {
	/** Key that opens the child picker; `false` registers none. */
	pickerShortcut: KeyId | false;
}

/** Defaults merged with the user's config file; a missing or broken file yields the defaults. */
export function loadConfig(): Config {
	const path = join(getAgentDir(), "extensions", "pi-sagent", "config.json");
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return DEFAULTS;
	}
	// User-edited JSON: accept only the documented key types.
	const shortcut = (raw as { pickerShortcut?: unknown } | null)?.pickerShortcut;
	return {
		pickerShortcut: typeof shortcut === "string" || shortcut === false ? (shortcut as KeyId | false) : DEFAULTS.pickerShortcut,
	};
}

// alt+a ("agents") is unbound in pi's default keymap.
const DEFAULTS: Config = { pickerShortcut: "alt+a" };
