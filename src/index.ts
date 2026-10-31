// pi-sagent entry: opens pi-subagents children inside the main pi window, from FleetView or /sagent.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Registration, registerInspector } from "./inspector.ts";
import { openView } from "./view.ts";

/** Extension factory: registers the FleetView inspector and the /sagent command in parent sessions. */
export default function (pi: ExtensionAPI) {
	// Global extensions also load inside every subagent; the child side has nothing to do until M3.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	// Inspector calls carry no UI handle, so keep the context of the live session (replaced on every start).
	let current: ExtensionContext | undefined;
	let registration: Registration | undefined;

	pi.on("session_start", (_event, ctx) => {
		current = ctx;
		registration?.dispose();
		registration = registerInspector(pi.events, () => current);
	});
	pi.on("session_shutdown", () => {
		registration?.dispose();
		registration = undefined;
		current = undefined;
	});

	pi.registerCommand("sagent", {
		description: "Open a subagent run in this window: /sagent <async run dir> [child index]",
		handler: async (args, ctx) => {
			const [path, indexArg] = args.trim().split(/\s+/);
			if (!path) return ctx.ui.notify("Usage: /sagent <async run dir> [child index]", "warning");
			const index = indexArg ? Number.parseInt(indexArg, 10) : 0;
			const target = resolvePath(path, index);
			if (typeof target === "string") return ctx.ui.notify(target, "error");
			await openView(target, pi.events, ctx);
		},
	});
}

function resolvePath(path: string, index: number) {
	if (!existsSync(path)) return `No such file or directory: ${path}`;
	if (!statSync(path).isDirectory()) return `${path} is not an async run directory.`;
	const steps = (JSON.parse(readFileSync(join(path, "status.json"), "utf-8")) as { steps?: { sessionFile?: string }[] })
		.steps;
	const sessionFile = steps?.[index]?.sessionFile;
	if (!sessionFile) return `${path} has no session file for child ${index}.`;
	// pi-subagents names each async run directory after its run id.
	const id = basename(path);
	return { title: `${id.slice(0, 8)} #${index}`, sessionFile, run: { id, index } };
}
