// pi-attach entry: opens pi-subagents children inside the main pi window, from the list under the editor, FleetView, a shortcut or /attach.
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fleetViewEnabled, loadConfig } from "./config.ts";
import { type Registration, registerInspector } from "./inspector.ts";
import { publishLiveStream } from "./live-stream.ts";
import { Roster } from "./roster.ts";
import { defaultRunsRoot, SessionRuns } from "./run-status.ts";
import { openView } from "./view.ts";

/** Extension factory: the live-stream publisher in subagents; inspector, subagent list, shortcut and /attach in parents. */
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

	const showList = (ctx: ExtensionContext) => {
		if (roster) return roster.show();
		if (fleetViewEnabled()) {
			const config = "~/.pi/agent/extensions/subagent/config.json";
			return ctx.ui.notify(`pi-attach's list is off while pi-subagents' FleetView is on: set "fleetView": false in ${config}.`, "info");
		}
		ctx.ui.notify("This session is not saved, so its subagent runs cannot be found.", "warning");
	};

	const { listShortcut } = loadConfig();
	if (listShortcut) {
		pi.registerShortcut(listShortcut, { description: "Show this session's subagents", handler: showList });
	}

	pi.registerCommand("attach", {
		description: "Show this session's subagents, or open one: /attach [async run dir] [child index]",
		handler: async (args, ctx) => {
			const [path, indexArg] = args.trim().split(/\s+/).filter(Boolean);
			if (!path) return showList(ctx);
			if (!existsSync(path)) return ctx.ui.notify(`No such async run directory: ${path}`, "error");
			const asyncDir = resolve(path);
			// pi-subagents names each async run directory after its run id.
			const target = { runId: basename(asyncDir), asyncDir, index: indexArg ? Number.parseInt(indexArg, 10) : 0 };
			await openView(target, pi.events, ctx);
		},
	});
}
