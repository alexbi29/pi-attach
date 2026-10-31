// Child picker: lists this session's async children, newest first, and returns the one chosen.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultRunsRoot, listSessionRuns } from "./run-status.ts";
import type { ViewTarget } from "./view.ts";

/** Ask the user to pick one of this session's children; undefined when there are none or they cancel. */
export async function pickChild(ctx: ExtensionContext): Promise<ViewTarget | undefined> {
	const parentSession = ctx.sessionManager.getSessionFile();
	if (!parentSession) {
		ctx.ui.notify("This session is not saved, so its subagent runs cannot be found.", "warning");
		return undefined;
	}
	const choices = listSessionRuns(parentSession, defaultRunsRoot())
		.slice(0, MAX_RUNS)
		.flatMap((run) =>
			run.children.map((child, index) => ({
				label: `${child.agent} · ${child.state} · ${run.runId.slice(0, 8)}${run.children.length > 1 ? ` #${index}` : ""}${child.model ? ` · ${child.model}` : ""}`,
				target: { runId: run.runId, asyncDir: run.asyncDir, index },
			})),
		);
	if (choices.length === 0) {
		ctx.ui.notify("No subagent runs in this session yet.", "info");
		return undefined;
	}
	const label = await ctx.ui.select(
		"Open subagent",
		choices.map((choice) => choice.label),
	);
	return choices.find((choice) => choice.label === label)?.target;
}

const MAX_RUNS = 30;
