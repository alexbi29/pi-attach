// FleetView hook: an inspector plugin so Enter/H on a child opens our view instead of a terminal pane.
import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ViewTarget } from "./view.ts";

/** Handle to undo a registration; safe to call more than once. */
export interface Registration {
	dispose(): void;
}

/**
 * Register with pi-subagents through its versioned event (docs/extension-api.md, "Register an external
 * inspector"). Returns undefined when pi-subagents is not loaded.
 */
export function registerInspector(
	events: EventBus,
	open: (target: ViewTarget, ctx: ExtensionContext) => Promise<unknown>,
	getContext: () => ExtensionContext | undefined,
): Registration | undefined {
	const request: RegistrationRequest = { version: 1, plugin: createPlugin(open, getContext) };
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

function createPlugin(
	open: (target: ViewTarget, ctx: ExtensionContext) => Promise<unknown>,
	getContext: () => ExtensionContext | undefined,
): InspectorPlugin {
	return {
		name: "pi-attach",
		available: () => getContext()?.mode === "tui",
		// The view lives in this pi window and closes with it; there is no pane binding to own.
		owns: () => false,
		async open({ target }) {
			const ctx = getContext();
			if (!ctx) return result("pi-attach has no active session.", true);
			const view = { runId: target.runId, asyncDir: target.asyncDir, index: target.index ?? 0 };
			// Fleet awaits open(); the view stays up after it returns, stacked above Fleet's overlay.
			void open(view, ctx);
			return result(`Opened ${target.runId.slice(0, 8)} in this window.`);
		},
	};
}

function result(text: string, isError = false): InspectorResult {
	return {
		content: [{ type: "text", text }],
		details: { mode: "management", results: [] },
		...(isError ? { isError: true } : {}),
	};
}
