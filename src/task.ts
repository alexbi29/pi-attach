// A child's task in one line, taken from the first user message of its session file.
import { closeSync, openSync, readSync } from "node:fs";

/**
 * The first line of the task the child was given, without pi-subagents' "Task:" and "[Read from: …]"
 * framing; undefined while the session file has no user message yet.
 */
export function readTask(sessionFile: string): string | undefined {
	const text = firstUserText(sessionFile);
	return text === undefined ? undefined : taskLine(text);
}

/** "Task: [Read from: plan.md]\n\nOpen the file…" → "Open the file…". */
export function taskLine(text: string): string | undefined {
	const body = text.replace(/^\s*Task:\s*/, "").replace(/^\s*\[Read from: [^\]]*\]\s*/, "");
	const line = body.split("\n").find((candidate) => candidate.trim() !== "");
	return line?.replace(/\s+/g, " ").trim();
}

// The task follows the session header and the system prompt entries; this much covers them.
const HEAD_BYTES = 64 * 1024;

function firstUserText(sessionFile: string): string | undefined {
	let head: string;
	try {
		const fd = openSync(sessionFile, "r");
		try {
			const buffer = Buffer.alloc(HEAD_BYTES);
			head = buffer.toString("utf-8", 0, readSync(fd, buffer, 0, HEAD_BYTES, 0));
		} finally {
			closeSync(fd);
		}
	} catch {
		return undefined;
	}
	// The last line may be cut off by the read; only complete lines are parsed.
	for (const line of head.split("\n").slice(0, -1)) {
		const text = userText(line);
		if (text !== undefined) return text;
	}
	return undefined;
}

function userText(line: string): string | undefined {
	let entry: { type?: unknown; message?: { role?: unknown; content?: unknown } };
	try {
		entry = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (entry.type !== "message" || entry.message?.role !== "user") return undefined;
	const content = entry.message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	// Session file content: keep only well-formed text parts.
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}
