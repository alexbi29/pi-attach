// Read-only access to pi-subagents' async run records (`<runs root>/<run id>/status.json`).
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

/** One child of an async run, as far as the view needs it. */
export interface ChildStatus {
	agent: string;
	model?: string;
	state: string;
	sessionFile?: string;
	tokens?: number;
	toolCount?: number;
}

/** An async run: its children plus the fields that place it in time and in a parent session. */
export interface RunStatus {
	runId: string;
	asyncDir: string;
	state: string;
	parentSession?: string;
	startedAt?: number;
	endedAt?: number;
	children: ChildStatus[];
}

/** Parse `<asyncDir>/status.json`; undefined while the runner has not written it yet. */
export function readRunStatus(asyncDir: string, runId: string): RunStatus | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(asyncDir, "status.json"), "utf-8"));
	} catch {
		return undefined;
	}
	// status.json is pi-subagents' internal record: read the documented-in-practice fields defensively.
	const status = record(raw);
	const steps = Array.isArray(status.steps) ? status.steps : [];
	return {
		runId,
		asyncDir,
		state: text(status.state) ?? "unknown",
		...optional("parentSession", text(status.sessionId)),
		...optional("startedAt", number(status.startedAt)),
		...optional("endedAt", number(status.endedAt)),
		children: steps.map((step) => childStatus(record(step))),
	};
}

/** Async runs started from `parentSession`, newest first. */
export function listSessionRuns(parentSession: string, runsRoot: string): RunStatus[] {
	let ids: string[];
	try {
		ids = readdirSync(runsRoot);
	} catch {
		return [];
	}
	return ids
		.map((id) => readRunStatus(join(runsRoot, id), id))
		.filter((run): run is RunStatus => run?.parentSession === parentSession)
		.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/**
 * pi-subagents' runs directory: `<tmpdir>/pi-subagents-<scope>/async-subagent-runs`
 * (docs/observability.md), with the root overridable through PI_SUBAGENTS_TEMP_ROOT.
 */
export function defaultRunsRoot(): string {
	const root = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
	return join(root || join(tmpdir(), `pi-subagents-${tempScope()}`), "async-subagent-runs");
}

// Same scope rule as pi-subagents' resolveTempScopeId (uid, then user name): one runs directory per OS user.
function tempScope(): string {
	const uid = process.getuid?.();
	if (uid !== undefined) return `uid-${uid}`;
	const name = process.env.USERNAME ?? process.env.USER ?? process.env.LOGNAME ?? userInfo().username;
	return `user-${name.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown"}`;
}

function childStatus(step: Record<string, unknown>): ChildStatus {
	const tokens = record(step.tokens);
	return {
		agent: text(step.agent) ?? "subagent",
		state: text(step.status) ?? "unknown",
		...optional("model", text(step.model)),
		...optional("sessionFile", text(step.sessionFile)),
		...optional("tokens", number(tokens.total)),
		...optional("toolCount", number(step.toolCount)),
	};
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
	return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}
