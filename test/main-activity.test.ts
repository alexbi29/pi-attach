// Tests for following the main session while a child view covers it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MainActivity } from "../src/main-activity.ts";

type Handler = (event: unknown) => void;

// MainActivity only subscribes to events; a map of handlers stands in for the extension API.
function fakeMain() {
	const handlers = new Map<string, Handler>();
	const pi = { on: (name: string, handler: Handler) => handlers.set(name, handler) } as unknown as ExtensionAPI;
	const main = new MainActivity(pi);
	const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event);
	return { main, emit };
}

describe("MainActivity", () => {
	it("is working from agent start until the agent settles", () => {
		const { main, emit } = fakeMain();
		emit("agent_start");
		assert.equal(main.working, true);
		emit("agent_settled");
		assert.equal(main.working, false);
	});

	it("counts replies and notices since markSeen, but not the user's own messages", () => {
		const { main, emit } = fakeMain();
		emit("message_end", { message: { role: "assistant" } });
		main.markSeen();
		emit("message_end", { message: { role: "user" } });
		emit("message_end", { message: { role: "custom" } });
		emit("message_end", { message: { role: "assistant" } });
		assert.equal(main.unseen, 2);
	});

	it("tells listeners about every change until they unsubscribe", () => {
		const { main, emit } = fakeMain();
		let calls = 0;
		const stop = main.onChange(() => calls++);
		emit("agent_start");
		main.markSeen();
		stop();
		emit("agent_settled");
		assert.equal(calls, 2);
	});
});
