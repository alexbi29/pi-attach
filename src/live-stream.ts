// Live channel from a child session to viewers: streaming text, thinking and tool output over a local socket.
import { createHash } from "node:crypto";
import { mkdirSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, SessionContext } from "@earendil-works/pi-coding-agent";

type AgentMessage = SessionContext["messages"][number];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

/** A tool's output so far, in the shape ToolExecutionComponent.updateResult takes. */
export interface ToolOutput {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	isError: boolean;
}

/** One newline-delimited JSON frame on the wire. */
export type StreamFrame =
	| { type: "partial"; message: AssistantMessage }
	| { type: "message_end" }
	| { type: "tool_start"; toolCallId: string }
	| { type: "tool_update"; toolCallId: string; output: ToolOutput };

/**
 * Child side: serve this session's live events on the socket derived from its session file.
 * Costs nothing beyond one listening socket until a viewer connects.
 */
export function publishLiveStream(pi: ExtensionAPI): void {
	let server: Server | undefined;
	let socketPath: string | undefined;
	const viewers = new Set<Socket>();
	let partial: AssistantMessage | undefined;
	let flushTimer: NodeJS.Timeout | undefined;

	const send = (frame: StreamFrame) => {
		if (viewers.size === 0) return;
		const line = `${JSON.stringify(frame)}\n`;
		for (const viewer of viewers) viewer.write(line);
	};
	// message_update fires per token; viewers get the latest snapshot at most every PARTIAL_INTERVAL_MS.
	const flushPartial = () => {
		flushTimer = undefined;
		if (partial) send({ type: "partial", message: partial });
	};

	pi.on("session_start", (_event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;
		server?.close();
		socketPath = liveSocketPath(sessionFile);
		mkdirSync(SOCKET_DIR, { recursive: true, mode: 0o700 });
		// A resumed child reuses its session file; the previous runner's socket file is stale.
		removeSocket(socketPath);
		server = createServer((viewer) => {
			viewers.add(viewer);
			viewer.on("close", () => viewers.delete(viewer));
			viewer.on("error", () => viewers.delete(viewer));
			if (partial) viewer.write(`${JSON.stringify({ type: "partial", message: partial })}\n`);
		});
		server.on("error", () => undefined);
		server.listen(socketPath);
		server.unref();
	});

	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		partial = event.message;
		if (viewers.size > 0 && !flushTimer) flushTimer = setTimeout(flushPartial, PARTIAL_INTERVAL_MS);
	});
	pi.on("message_end", () => {
		clearTimeout(flushTimer);
		flushTimer = undefined;
		partial = undefined;
		send({ type: "message_end" });
	});
	pi.on("tool_execution_start", (event) => send({ type: "tool_start", toolCallId: event.toolCallId }));
	pi.on("tool_execution_update", (event) => {
		// Tool results are tool-defined; forward the documented fields the renderer reads.
		const result = (event.partialResult ?? {}) as { content?: ToolOutput["content"]; details?: unknown };
		send({
			type: "tool_update",
			toolCallId: event.toolCallId,
			output: { content: result.content ?? [], details: result.details, isError: false },
		});
	});

	pi.on("session_shutdown", () => {
		clearTimeout(flushTimer);
		for (const viewer of viewers) viewer.destroy();
		viewers.clear();
		server?.close();
		if (socketPath) removeSocket(socketPath);
		server = undefined;
	});
}

/** A connected viewer; `close()` ends it without affecting the child. */
export interface LiveStreamConnection {
	close(): void;
}

/** Parent side: connect to a child's live socket; `onClose` fires when it is gone or never existed. */
export function connectLiveStream(
	sessionFile: string,
	onFrame: (frame: StreamFrame) => void,
	onClose: () => void,
): LiveStreamConnection {
	const socket = connect(liveSocketPath(sessionFile));
	let buffered = "";
	socket.setEncoding("utf-8");
	socket.on("data", (chunk: string) => {
		buffered += chunk;
		let newline = buffered.indexOf("\n");
		while (newline >= 0) {
			const line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			// Frames come from our own child-side code; a parse failure means a truncated write, so skip it.
			try {
				onFrame(JSON.parse(line) as StreamFrame);
			} catch {}
			newline = buffered.indexOf("\n");
		}
	});
	socket.on("error", () => undefined);
	socket.on("close", onClose);
	return { close: () => socket.destroy() };
}

const PARTIAL_INTERVAL_MS = 50;
// Unix socket paths are limited to about 104 bytes, so the session file is hashed into a short name.
const SOCKET_DIR = join(tmpdir(), `pi-sagent-${process.getuid?.() ?? "user"}`);

function liveSocketPath(sessionFile: string): string {
	return join(SOCKET_DIR, `${createHash("sha256").update(sessionFile).digest("hex").slice(0, 16)}.sock`);
}

function removeSocket(path: string): void {
	try {
		unlinkSync(path);
	} catch {}
}
