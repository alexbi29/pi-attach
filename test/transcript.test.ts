// Tests for turning a child's session file into pi components and following it as it grows.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Transcript } from "../src/transcript.ts";

// Message components only ask the TUI to re-render; nothing here draws to a terminal.
const tui = { requestRender: () => {} } as unknown as TUI;

let entryCount = 0;
function entry(message: Record<string, unknown>): string {
	entryCount++;
	const parentId = entryCount === 1 ? null : `e${entryCount - 1}`;
	return `${JSON.stringify({ type: "message", id: `e${entryCount}`, parentId, timestamp: new Date(0).toISOString(), message })}\n`;
}

const user = (text: string) => ({ role: "user", content: text, timestamp: 0 });
const assistant = (content: unknown[]) => ({
	role: "assistant",
	content,
	api: "test",
	provider: "test",
	model: "test",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop",
	timestamp: 0,
});

function sessionFile(...lines: string[]): string {
	entryCount = 0;
	const file = join(mkdtempSync(join(tmpdir(), "pi-attach-test-")), "session.jsonl");
	writeFileSync(file, `${JSON.stringify({ type: "session", id: "s", timestamp: new Date(0).toISOString(), cwd: "/" })}\n`);
	for (const line of lines) appendFileSync(file, line);
	return file;
}

function text(transcript: Transcript): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI styling from rendered lines
	return transcript.render(100).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

function count(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

function newTranscript(): Transcript {
	return new Transcript(tui, "/", { toolsExpanded: true, hideThinking: false });
}

before(() => initTheme("dark"));

describe("Transcript.open", () => {
	it("renders user text, thinking, assistant text and tool calls with their results", () => {
		entryCount = 0;
		const file = sessionFile();
		appendFileSync(file, entry(user("count the files")));
		appendFileSync(
			file,
			entry(
				assistant([
					{ type: "thinking", thinking: "use ls first" },
					{ type: "text", text: "Listing now." },
					{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
				]),
			),
		);
		appendFileSync(
			file,
			entry({ role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "a.txt" }], isError: false, timestamp: 0 }),
		);
		const transcript = newTranscript();
		transcript.open(file);
		const rendered = text(transcript);
		for (const expected of ["count the files", "use ls first", "Listing now.", "ls", "a.txt"]) {
			assert.ok(rendered.includes(expected), `missing ${expected}`);
		}
	});
});

describe("Transcript.refresh", () => {
	it("appends new entries and waits for a half-written line", () => {
		const file = sessionFile();
		appendFileSync(file, entry(user("first")));
		const transcript = newTranscript();
		transcript.open(file);
		const line = entry(assistant([{ type: "text", text: "second" }]));
		appendFileSync(file, line.slice(0, 20));
		assert.equal(transcript.refresh(), false);
		assert.ok(!text(transcript).includes("second"));
		appendFileSync(file, line.slice(20));
		assert.equal(transcript.refresh(), true);
		assert.ok(text(transcript).includes("second"));
		assert.equal(transcript.refresh(), false);
	});

	it("rebuilds when the file shrinks", () => {
		const file = sessionFile();
		appendFileSync(file, entry(user("old history")));
		const transcript = newTranscript();
		transcript.open(file);
		writeFileSync(file, "");
		assert.equal(transcript.refresh(), true);
		assert.ok(!text(transcript).includes("old history"));
	});
});

describe("Transcript.showPartial", () => {
	it("shows the streaming message once and hands over to the finished one", () => {
		const file = sessionFile();
		appendFileSync(file, entry(user("go")));
		const transcript = newTranscript();
		transcript.open(file);
		transcript.showPartial(assistant([{ type: "text", text: "streamed reply" }]) as never);
		assert.equal(count(text(transcript), "streamed reply"), 1);
		appendFileSync(file, entry(assistant([{ type: "text", text: "streamed reply" }])));
		transcript.refresh();
		assert.equal(count(text(transcript), "streamed reply"), 1);
	});

	it("keeps the streaming message last when other entries arrive first", () => {
		const file = sessionFile();
		const transcript = newTranscript();
		transcript.open(file);
		transcript.showPartial(assistant([{ type: "text", text: "still typing" }]) as never);
		appendFileSync(file, entry(user("steer: hurry")));
		transcript.refresh();
		const rendered = text(transcript);
		assert.ok(rendered.indexOf("steer: hurry") < rendered.indexOf("still typing"));
	});
});

describe("Transcript.showToolOutput", () => {
	it("applies output that arrived before the tool call reached the file", () => {
		const file = sessionFile();
		const transcript = newTranscript();
		transcript.open(file);
		transcript.showToolOutput("call-9", { content: [{ type: "text", text: "early line" }], isError: false });
		appendFileSync(file, entry(assistant([{ type: "toolCall", id: "call-9", name: "bash", arguments: { command: "run" } }])));
		transcript.refresh();
		assert.ok(text(transcript).includes("early line"));
	});
});

describe("Transcript.thinkingLevel", () => {
	it("follows the session's thinking level changes", () => {
		const file = sessionFile();
		const transcript = newTranscript();
		transcript.open(file);
		assert.equal(transcript.thinkingLevel, "off");
		entryCount++;
		appendFileSync(
			file,
			`${JSON.stringify({ type: "thinking_level_change", id: `e${entryCount}`, parentId: null, timestamp: new Date(0).toISOString(), thinkingLevel: "max" })}\n`,
		);
		transcript.refresh();
		assert.equal(transcript.thinkingLevel, "max");
		transcript.open(file);
		assert.equal(transcript.thinkingLevel, "max");
	});
});
