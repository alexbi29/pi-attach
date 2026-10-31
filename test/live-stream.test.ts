// Tests for the live channel between a child session and the view.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectLiveStream, publishLiveStream, type StreamFrame } from "../src/live-stream.ts";

type Handler = (event: unknown, ctx?: unknown) => void;

// The publisher only subscribes to events; a map of handlers stands in for the extension API.
function fakeChild(sessionFile: string) {
	const handlers = new Map<string, Handler>();
	const pi = { on: (name: string, handler: Handler) => handlers.set(name, handler) } as unknown as ExtensionAPI;
	publishLiveStream(pi);
	const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, undefined);
	handlers.get("session_start")?.({}, { sessionManager: { getSessionFile: () => sessionFile } });
	return { emit };
}

function nextFrame(frames: StreamFrame[]): Promise<StreamFrame> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + 2000;
		const poll = () => {
			const frame = frames.shift();
			if (frame) return resolve(frame);
			if (Date.now() > deadline) return reject(new Error("no frame"));
			setTimeout(poll, 5);
		};
		poll();
	});
}

function connected(sessionFile: string, frames: StreamFrame[], onClose = () => {}) {
	return new Promise<ReturnType<typeof connectLiveStream>>((resolve) => {
		const connection = connectLiveStream(sessionFile, (frame) => frames.push(frame), onClose);
		// The server registers the viewer on accept; give the handshake a moment.
		setTimeout(() => resolve(connection), 50);
	});
}

const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

describe("live stream", () => {
	it("delivers the latest streaming snapshot, then message_end", async () => {
		const sessionFile = `/sessions/${randomUUID()}.jsonl`;
		const child = fakeChild(sessionFile);
		const frames: StreamFrame[] = [];
		const connection = await connected(sessionFile, frames);
		child.emit("message_update", { message: assistant("Hel") });
		child.emit("message_update", { message: assistant("Hello") });
		// Updates inside one throttle window collapse into the newest snapshot.
		assert.deepEqual(await nextFrame(frames), { type: "partial", message: assistant("Hello") });
		child.emit("message_end");
		assert.deepEqual(await nextFrame(frames), { type: "message_end" });
		connection.close();
		child.emit("session_shutdown");
	});

	it("forwards tool start and partial output", async () => {
		const sessionFile = `/sessions/${randomUUID()}.jsonl`;
		const child = fakeChild(sessionFile);
		const frames: StreamFrame[] = [];
		const connection = await connected(sessionFile, frames);
		child.emit("tool_execution_start", { toolCallId: "call-1" });
		child.emit("tool_execution_update", { toolCallId: "call-1", partialResult: { content: [{ type: "text", text: "line 1" }] } });
		assert.deepEqual(await nextFrame(frames), { type: "tool_start", toolCallId: "call-1" });
		assert.deepEqual(await nextFrame(frames), {
			type: "tool_update",
			toolCallId: "call-1",
			output: { content: [{ type: "text", text: "line 1" }], isError: false },
		});
		connection.close();
		child.emit("session_shutdown");
	});

	it("sends a viewer that joins mid-message the current snapshot", async () => {
		const sessionFile = `/sessions/${randomUUID()}.jsonl`;
		const child = fakeChild(sessionFile);
		child.emit("message_update", { message: assistant("already streaming") });
		const frames: StreamFrame[] = [];
		const connection = await connected(sessionFile, frames);
		assert.deepEqual(await nextFrame(frames), { type: "partial", message: assistant("already streaming") });
		connection.close();
		child.emit("session_shutdown");
	});

	it("closes viewers when the child session ends", async () => {
		const sessionFile = `/sessions/${randomUUID()}.jsonl`;
		const child = fakeChild(sessionFile);
		let closed = false;
		await connected(sessionFile, [], () => {
			closed = true;
		});
		child.emit("session_shutdown");
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(closed, true);
	});

	it("reports close when no child serves the session", async () => {
		const closed = await new Promise<boolean>((resolve) => {
			connectLiveStream(`/sessions/${randomUUID()}.jsonl`, () => {}, () => resolve(true));
		});
		assert.equal(closed, true);
	});
});
