// Run records for list tests: a run with children, and a child with only the fields a test cares about.
import type { ChildStatus, RunStatus } from "../src/run-status.ts";

export const MINUTE = 60_000;
export const NOW = 100 * MINUTE;

export function run(runId: string, children: ChildStatus[], endedAt?: number): RunStatus {
	return { runId, asyncDir: `/runs/${runId}`, state: "running", children, ...(endedAt === undefined ? {} : { endedAt }) };
}

export function child(state: string, startedAt: number, extra: Partial<ChildStatus> = {}): ChildStatus {
	return { agent: "delegate", state, startedAt, ...extra };
}
