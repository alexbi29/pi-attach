// pi-attach entry: opens pi-subagents children inside the main pi window, from the list under the editor, FleetView, a shortcut or /attach.
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fleetViewEnabled, loadConfig } from "./config.ts";
import { type Registration, registerInspector } from "./inspector.ts";
import { publishLiveStream } from "./live-stream.ts";
import { MainActivity } from "./main-activity.ts";
import { Roster } from "./roster.ts";
import { defaultRunsRoot, SessionRuns } from "./run-status.ts";
import { type ListStart, openView, type ViewTarget } from "./view.ts";

/** Extension factory: the live-stream publisher in subagents; inspector, subagent list, shortcut and /attach in parents. */
export default function (pi: ExtensionAPI) {
	// Global extensions also load inside every subagent: there, the only job is serving the live stream.
	if (process.env.PI_SUBAGENT_CHILD === "1") return publishLiveStream(pi);

	// Inspector calls carry no UI handle, so keep the context of the live session (replaced on every start).
	let current: ExtensionContext | undefined;
	let registration: Registration | undefined;
	let roster: Roster | undefined;
	// This session's runs, shared by the list under the editor and the one in the view.
	let runs: SessionRuns | undefined;
	const main = new MainActivity(pi);
	const open = (target: ViewTarget, list: ListStart, ctx: ExtensionContext) =>
		openView(target, list, { events: pi.events, main, runs }, ctx);

	pi.on("session_start", (_event, ctx) => {
		current = ctx;
		registration?.dispose();
		registration = registerInspector(pi.events, (target, ctx) => open(target, "closed", ctx), () => current);
		roster?.dispose();
		const parentSession = ctx.sessionManager.getSessionFile();
		runs = parentSession ? new SessionRuns(parentSession, defaultRunsRoot()) : undefined;
		roster = ctx.mode === "tui" && runs && !fleetViewEnabled() ? new Roster(runs, (target) => open(target, "open", ctx), ctx) : undefined;
	});
	pi.on("session_shutdown", () => {
		registration?.dispose();
		registration = undefined;
		roster?.dispose();
		roster = undefined;
		runs = undefined;
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
			await open(target, "closed", ctx);
		},
	});
}
