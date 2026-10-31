// FleetView hook: an inspector plugin so Enter/H on a child opens our view instead of a terminal pane.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openView } from "./view.ts";

/** Handle to undo a registration; safe to call more than once. */
export interface Registration {
	dispose(): void;
}

/**
 * Register with pi-subagents through its versioned event (docs/extension-api.md, "Register an external
 * inspector"). Returns undefined when pi-subagents is not loaded.
 */
export function registerInspector(events: EventBus, getContext: () => ExtensionContext | undefined): Registration | undefined {
	const request: RegistrationRequest = { version: 1, plugin: createPlugin(events, getContext) };
	events.emit(REGISTER_EVENT, request);
	if (!request.result) return undefined;
	if (!request.result.ok) throw request.result.error;
	return request.result.registration;
}

const REGISTER_EVENT = "pi-subagents:inspector-register:v1";

// Structural copies of the pi-subagents/inspectors types: an independently installed extension uses
// the event directly, so there is no runtime import of pi-subagents.
interface InspectorTarget {
	runId: string;
	asyncDir: string;
	index?: number;
	status: { steps?: unknown[] };
}
interface InspectorContext {
	target: InspectorTarget;
}
interface InspectorResult {
	content: { type: "text"; text: string }[];
	details: { mode: "management"; results: [] };
	isError?: boolean;
}
interface InspectorPlugin {
	readonly name: string;
	available(context: InspectorContext): boolean;
	owns(context: InspectorContext): boolean;
	open(context: InspectorContext): Promise<InspectorResult>;
}
interface RegistrationRequest {
	version: 1;
	plugin: InspectorPlugin;
	result?: { ok: true; registration: Registration } | { ok: false; error: Error };
}

function createPlugin(events: EventBus, getContext: () => ExtensionContext | undefined): InspectorPlugin {
	return {
		name: "pi-sagent",
		available: () => getContext()?.mode === "tui",
		// The view lives in this pi window and closes with it; there is no pane binding to own.
		owns: () => false,
		async open({ target }) {
			const ctx = getContext();
			if (!ctx) return result("pi-sagent has no active session.", true);
			const index = target.index ?? 0;
			const step = stepAt(target, index);
			if (!step?.sessionFile) return result(`Run ${target.runId} has no session file for child ${index} yet.`, true);
			const title = `${step.agent ?? "subagent"} · ${target.runId.slice(0, 8)}${target.index === undefined ? "" : ` #${index}`}`;
			// Fleet awaits open(); the view stays up after it returns, stacked above Fleet's overlay.
			void openView({ title, sessionFile: step.sessionFile, run: { id: target.runId, index } }, events, ctx);
			return result(`Opened ${title}.`);
		},
	};
}

interface StepInfo {
	agent?: string;
	sessionFile?: string;
}

// Status steps are pi-subagents' status.json records; read only the two fields the view needs.
function stepAt(target: InspectorTarget, index: number): StepInfo | undefined {
	const steps = target.status.steps ?? readStatusSteps(target.asyncDir);
	const step = steps?.[index];
	if (!step || typeof step !== "object") return undefined;
	const { agent, sessionFile } = step as Record<string, unknown>;
	return {
		...(typeof agent === "string" ? { agent } : {}),
		...(typeof sessionFile === "string" ? { sessionFile } : {}),
	};
}

function readStatusSteps(asyncDir: string): unknown[] | undefined {
	try {
		const status = JSON.parse(readFileSync(join(asyncDir, "status.json"), "utf-8")) as { steps?: unknown };
		return Array.isArray(status.steps) ? status.steps : undefined;
	} catch {
		return undefined;
	}
}

function result(text: string, isError = false): InspectorResult {
	return {
		content: [{ type: "text", text }],
		details: { mode: "management", results: [] },
		...(isError ? { isError: true } : {}),
	};
}
