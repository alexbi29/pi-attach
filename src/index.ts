// pi-attach entry: opens pi-subagents children inside the main pi window, from the list under the editor, FleetView, a shortcut or /attach.
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fleetViewEnabled, loadConfig } from "./config.ts";
import { type Registration, registerInspector } from "./inspector.ts";
import { publishLiveStream } from "./live-stream.ts";
import { pickChild } from "./picker.ts";
import { Roster } from "./roster.ts";
import { defaultRunsRoot, SessionRuns } from "./run-status.ts";
import { openView } from "./view.ts";

/** Extension factory: the live-stream publisher in subagents; inspector, picker shortcut and /attach in parents. */
export default function (pi: ExtensionAPI) {
	// Global extensions also load inside every subagent: there, the only job is serving the live stream.
	if (process.env.PI_SUBAGENT_CHILD === "1") return publishLiveStream(pi);

	// Inspector calls carry no UI handle, so keep the context of the live session (replaced on every start).
	let current: ExtensionContext | undefined;
	let registration: Registration | undefined;
	let roster: Roster | undefined;

	pi.on("session_start", (_event, ctx) => {
		current = ctx;
		registration?.dispose();
		registration = registerInspector(pi.events, () => current);
		roster?.dispose();
		const parentSession = ctx.sessionManager.getSessionFile();
		roster =
			ctx.mode === "tui" && parentSession && !fleetViewEnabled()
				? new Roster(new SessionRuns(parentSession, defaultRunsRoot()), (target) => void openView(target, pi.events, ctx), ctx)
				: undefined;
	});
	pi.on("session_shutdown", () => {
		registration?.dispose();
		registration = undefined;
		roster?.dispose();
		roster = undefined;
		current = undefined;
	});

	const openPicked = async (ctx: ExtensionContext) => {
		const target = await pickChild(ctx);
		if (target) await openView(target, pi.events, ctx);
	};

	const { pickerShortcut } = loadConfig();
	if (pickerShortcut) {
		pi.registerShortcut(pickerShortcut, { description: "Open a subagent in this window", handler: openPicked });
	}

	pi.registerCommand("attach", {
		description: "Open a subagent in this window: /attach [async run dir] [child index]",
		handler: async (args, ctx) => {
			const [path, indexArg] = args.trim().split(/\s+/).filter(Boolean);
			if (!path) return openPicked(ctx);
			if (!existsSync(path)) return ctx.ui.notify(`No such async run directory: ${path}`, "error");
			const asyncDir = resolve(path);
			// pi-subagents names each async run directory after its run id.
			const target = { runId: basename(asyncDir), asyncDir, index: indexArg ? Number.parseInt(indexArg, 10) : 0 };
			await openView(target, pi.events, ctx);
		},
	});
}
