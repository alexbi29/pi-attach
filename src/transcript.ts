// Child transcript: turns a child's session.jsonl into pi's own message components.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import {
	AssistantMessageComponent,
	buildSessionContext,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	getMarkdownTheme,
	parseSessionEntries,
	type SessionContext,
	type SessionEntry,
	type ToolDefinition,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, type TUI } from "@earendil-works/pi-tui";
import type { ToolOutput } from "./live-stream.ts";

type AgentMessage = SessionContext["messages"][number];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
// ToolExecutionComponent takes `ToolDefinition<any, any, any>`: each built-in tool has its own schema type.
// biome-ignore lint/suspicious/noExplicitAny: matches pi's own renderer slot type
type AnyToolDefinition = ToolDefinition<any, any, any>;

/** Display toggles that every rendered message follows, matching the main chat's Ctrl+O and thinking toggle. */
export interface TranscriptDisplay {
	toolsExpanded: boolean;
	hideThinking: boolean;
}

/** A child's conversation as a pi component tree, kept in step with its session file. */
export class Transcript extends Container {
	/** The child's current thinking level from its session file ("off" until it records one). */
	thinkingLevel = "off";
	private readonly tui: TUI;
	private readonly cwd: string;
	private readonly display: TranscriptDisplay;
	private readonly toolDefinitions: Map<string, AnyToolDefinition>;
	private sessionFile: string | undefined;
	// Bytes of the session file already rendered; always ends on a line break.
	private offset = 0;
	private tools: ToolExecutionComponent[] = [];
	private assistants: AssistantMessageComponent[] = [];
	// Tool calls still waiting for their result; results can arrive in a later append.
	private pending = new Map<string, ToolExecutionComponent>();
	// The assistant message the child is streaming, shown last until the session file holds it.
	private streaming: AssistantMessageComponent | undefined;
	// Live tool output that arrived before its tool call reached the session file.
	private readonly earlyOutputs = new Map<string, ToolOutput>();

	constructor(tui: TUI, cwd: string, display: TranscriptDisplay) {
		super();
		this.tui = tui;
		this.cwd = cwd;
		this.display = display;
		this.toolDefinitions = builtInToolDefinitions(cwd);
	}

	/** Forget the session file and everything rendered from it, as when the view switches to another child. */
	reset(): void {
		this.sessionFile = undefined;
		this.clearRendered();
		this.earlyOutputs.clear();
	}

	/** Render `sessionFile` from the start; later `refresh()` calls follow it. */
	open(sessionFile: string): void {
		this.sessionFile = sessionFile;
		this.reload();
	}

	/** Render what the session file gained since the last call; returns whether anything changed. */
	refresh(): boolean {
		if (!this.sessionFile) return false;
		const size = statSync(this.sessionFile).size;
		if (size < this.offset) return this.reload();
		if (size === this.offset) return false;
		const chunk = readCompleteLines(this.sessionFile, this.offset, size);
		if (!chunk) return false;
		this.offset += Buffer.byteLength(chunk);
		const entries = sessionEntries(chunk);
		// Compaction and similar entries rewrite the visible history: rebuild instead of appending.
		if (entries.some((entry) => !APPEND_ONLY_TYPES.has(entry.type))) return this.reload();
		for (const entry of entries) if (entry.type === "thinking_level_change") this.thinkingLevel = entry.thinkingLevel;
		this.renderMessages(entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : [])));
		return true;
	}

	/** Show the message the child is streaming below everything the session file holds. */
	showPartial(message: AssistantMessage): void {
		if (!this.streaming) {
			this.streaming = new AssistantMessageComponent(undefined, this.display.hideThinking, getMarkdownTheme());
			this.addChild(this.streaming);
		}
		this.streaming.updateContent(message, true);
	}

	/** Mark a tool call as executing, as the main chat does on `tool_execution_start`. */
	markToolStarted(toolCallId: string): void {
		this.pending.get(toolCallId)?.markExecutionStarted();
	}

	/** Show a running tool's output so far. */
	showToolOutput(toolCallId: string, output: ToolOutput): void {
		const tool = this.pending.get(toolCallId);
		if (tool) tool.updateResult(output, true);
		else this.earlyOutputs.set(toolCallId, output);
	}

	/** Apply the current display toggles to every message already rendered. */
	applyDisplay(): void {
		for (const tool of this.tools) tool.setExpanded(this.display.toolsExpanded);
		for (const assistant of this.assistants) assistant.setHideThinkingBlock(this.display.hideThinking);
		this.streaming?.setHideThinkingBlock(this.display.hideThinking);
	}

	private reload(): boolean {
		if (!this.sessionFile) return false;
		const size = statSync(this.sessionFile).size;
		const content = readCompleteLines(this.sessionFile, 0, size);
		this.clearRendered();
		this.offset = Buffer.byteLength(content);
		const context = buildSessionContext(sessionEntries(content));
		this.thinkingLevel = context.thinkingLevel;
		this.renderMessages(context.messages);
		return true;
	}

	private clearRendered(): void {
		this.offset = 0;
		this.thinkingLevel = "off";
		this.clear();
		this.tools = [];
		this.assistants = [];
		this.pending = new Map();
		this.streaming = undefined;
	}

	// Mirrors InteractiveMode.renderSessionItems: tool calls render under their assistant message,
	// and each tool result fills the call it answers.
	private renderMessages(messages: AgentMessage[]): void {
		const pending = this.pending;
		// New file content goes above the streaming message; a finished assistant message replaces it.
		const streaming = this.streaming;
		if (streaming) this.removeChild(streaming);
		let assistantArrived = false;
		for (const message of messages) {
			if (message.role === "user") {
				const text = userText(message.content);
				if (!text) continue;
				if (this.children.length > 0) this.addChild(new Spacer(1));
				this.addChild(new UserMessageComponent(text, getMarkdownTheme()));
			} else if (message.role === "assistant") {
				const assistant = new AssistantMessageComponent(message, this.display.hideThinking, getMarkdownTheme());
				assistantArrived = true;
				this.assistants.push(assistant);
				this.addChild(assistant);
				for (const part of message.content) {
					if (part.type !== "toolCall") continue;
					const tool = new ToolExecutionComponent(
						part.name,
						part.id,
						part.arguments,
						{},
						this.toolDefinitions.get(part.name),
						this.tui,
						this.cwd,
					);
					tool.setExpanded(this.display.toolsExpanded);
					const early = this.earlyOutputs.get(part.id);
					if (early) tool.updateResult(early, true);
					this.earlyOutputs.delete(part.id);
					this.tools.push(tool);
					this.addChild(tool);
					pending.set(part.id, tool);
				}
			} else if (message.role === "toolResult") {
				pending.get(message.toolCallId)?.updateResult(message);
				pending.delete(message.toolCallId);
			}
		}
		if (assistantArrived) this.streaming = undefined;
		else if (streaming) this.addChild(streaming);
	}
}

// Entry types that only add messages (or nothing visible) when appended to a linear child session.
const APPEND_ONLY_TYPES = new Set(["message", "thinking_level_change", "model_change", "usage", "custom", "label", "session_info"]);

function sessionEntries(content: string): SessionEntry[] {
	return parseSessionEntries(content).filter((entry): entry is SessionEntry => entry.type !== "session");
}

// The writer appends whole JSON lines; a read can still land mid-line, so stop at the last line break.
function readCompleteLines(file: string, start: number, end: number): string {
	const buffer = Buffer.alloc(end - start);
	const fd = openSync(file, "r");
	try {
		readSync(fd, buffer, 0, buffer.length, start);
	} finally {
		closeSync(fd);
	}
	const lastBreak = buffer.lastIndexOf(0x0a);
	return lastBreak < 0 ? "" : buffer.subarray(0, lastBreak + 1).toString("utf-8");
}

function userText(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter((part) => part.type === "text" && part.text)
		.map((part) => part.text)
		.join("\n");
}

// Tools from other extensions have no renderer here and fall back to ToolExecutionComponent's generic view.
function builtInToolDefinitions(cwd: string): Map<string, AnyToolDefinition> {
	const definitions: AnyToolDefinition[] = [
		createBashToolDefinition(cwd),
		createReadToolDefinition(cwd),
		createEditToolDefinition(cwd),
		createWriteToolDefinition(cwd),
		createGrepToolDefinition(cwd),
		createFindToolDefinition(cwd),
		createLsToolDefinition(cwd),
	];
	return new Map(definitions.map((definition) => [definition.name, definition]));
}
