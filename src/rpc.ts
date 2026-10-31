// Client for pi-subagents' in-process event-bus RPC (docs/extension-api.md, "In-process event-bus RPC").
import { randomUUID } from "node:crypto";
import type { EventBus } from "@earendil-works/pi-coding-agent";

/** Where a request is aimed: an async run id plus the child index inside it. */
export interface RunTarget {
	// `interrupt` resolves runs by id only; `steer` accepts either, so the id serves both.
	id: string;
	index?: number;
}

/** Outcome of one RPC call, as pi-subagents reports it. */
export type RpcResult = { ok: true; text: string; details: Record<string, unknown> } | { ok: false; error: string };

/** A resumed child runs as a new async run; `runId` names it when pi-subagents reports it. */
export type ResumeResult = { ok: true; text: string; runId?: string; asyncDir?: string } | { ok: false; error: string };

/** Delivery modes pi-subagents accepts for `steer`. */
export type SteerMode = "steer" | "follow_up" | "auto";

const REQUEST_EVENT = "subagents:rpc:v1:request";
const REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";
// pi-subagents answers synchronously or within one executor turn; a missing reply means it is not loaded.
const REPLY_TIMEOUT_MS = 10_000;

/** Send a message to a running child (or queue it as a follow-up). */
export function steer(events: EventBus, target: RunTarget, message: string, mode: SteerMode): Promise<RpcResult> {
	return call(events, "steer", { ...target, message, mode });
}

/** Revive a paused, completed or failed child with `message`; it continues as a new async run. */
export async function resume(events: EventBus, target: RunTarget, message: string): Promise<ResumeResult> {
	const result = await call(events, "resume", { ...target, message });
	if (!result.ok) return result;
	const { runId, asyncId, asyncDir } = result.details;
	const id = typeof runId === "string" ? runId : typeof asyncId === "string" ? asyncId : undefined;
	return {
		ok: true,
		text: result.text,
		...(id ? { runId: id } : {}),
		...(typeof asyncDir === "string" ? { asyncDir } : {}),
	};
}

/** Ask a running child to stop its current turn; the run stays resumable. */
export function interrupt(events: EventBus, target: RunTarget): Promise<RpcResult> {
	return call(events, "interrupt", { ...target });
}

interface RpcReply {
	success?: boolean;
	data?: { text?: unknown; details?: unknown };
	error?: { message?: unknown };
}

function call(events: EventBus, method: string, params: Record<string, unknown>): Promise<RpcResult> {
	const requestId = randomUUID();
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			unsubscribe();
			resolve({ ok: false, error: `pi-subagents did not answer ${method}; is it installed?` });
		}, REPLY_TIMEOUT_MS);
		const unsubscribe = events.on(`${REPLY_EVENT_PREFIX}${requestId}`, (raw) => {
			clearTimeout(timer);
			unsubscribe();
			// Wire input from another extension: check the shape before trusting it.
			const reply = (raw ?? {}) as RpcReply;
			if (reply.success) {
				const details = reply.data?.details;
				resolve({
					ok: true,
					text: typeof reply.data?.text === "string" ? reply.data.text : "",
					details: details && typeof details === "object" ? (details as Record<string, unknown>) : {},
				});
			}
			else resolve({ ok: false, error: String(reply.error?.message ?? `${method} failed`) });
		});
		events.emit(REQUEST_EVENT, { version: 1, requestId, method, params });
	});
}
