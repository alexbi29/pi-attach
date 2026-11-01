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
	startedAt?: number;
	endedAt?: number;
	/** The start of the child's task, from pi-subagents' session name ("delegate: Run the…"). */
	task?: string;
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
	return new SessionRuns(parentSession, runsRoot).list().sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/**
 * Follows one parent session's async runs. Polled every second, so a run's status.json is read again
 * only while the run is in flight: a finished run never changes (resume starts a new run).
 */
export class SessionRuns {
	private readonly parentSession: string;
	private readonly runsRoot: string;
	// Settled run ids: the final status of this session's finished runs, undefined for other sessions' runs.
	private readonly settled = new Map<string, RunStatus | undefined>();

	constructor(parentSession: string, runsRoot: string) {
		this.parentSession = parentSession;
		this.runsRoot = runsRoot;
	}

	/** This session's runs, in directory order. */
	list(): RunStatus[] {
		let ids: string[];
		try {
			ids = readdirSync(this.runsRoot);
		} catch {
			return [];
		}
		const runs: RunStatus[] = [];
		for (const id of ids) {
			if (this.settled.has(id)) {
				const run = this.settled.get(id);
				if (run) runs.push(run);
				continue;
			}
			// Undefined until the runner has written status.json; try again next time.
			const run = readRunStatus(join(this.runsRoot, id), id);
			if (!run) continue;
			if (run.parentSession !== this.parentSession) {
				// A status written before its session id is known may still turn out to be ours.
				if (run.parentSession) this.settled.set(id, undefined);
				continue;
			}
			if (!IN_FLIGHT_STATES.has(run.state)) this.settled.set(id, run);
			runs.push(run);
		}
		return runs;
	}
}

const IN_FLIGHT_STATES = new Set(["queued", "pending", "running"]);

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
		...optional("startedAt", number(step.startedAt)),
		...optional("endedAt", number(step.endedAt)),
		...optional("task", task(step)),
	};
}

function task(step: Record<string, unknown>): string | undefined {
	const name = text(step.sessionName);
	const agent = text(step.agent);
	const body = agent && name?.startsWith(`${agent}: `) ? name.slice(agent.length + 2) : name;
	// Tasks can span lines; the list shows them on one row.
	return body?.replace(/\s+/g, " ").trim() || undefined;
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
