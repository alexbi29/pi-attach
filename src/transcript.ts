// Child transcript: turns a child's session.jsonl into pi's own message components.
import { readFileSync } from "node:fs";
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

type AgentMessage = SessionContext["messages"][number];
// ToolExecutionComponent takes `ToolDefinition<any, any, any>`: each built-in tool has its own schema type.
// biome-ignore lint/suspicious/noExplicitAny: matches pi's own renderer slot type
type AnyToolDefinition = ToolDefinition<any, any, any>;

/** Display toggles that every rendered message follows, matching the main chat's Ctrl+O and thinking toggle. */
export interface TranscriptDisplay {
	toolsExpanded: boolean;
	hideThinking: boolean;
}

/** A child's conversation as a pi component tree, rebuilt from its session file. */
export class Transcript extends Container {
	private readonly tui: TUI;
	private readonly cwd: string;
	private readonly display: TranscriptDisplay;
	private readonly toolDefinitions: Map<string, AnyToolDefinition>;
	private tools: ToolExecutionComponent[] = [];
	private assistants: AssistantMessageComponent[] = [];

	constructor(tui: TUI, cwd: string, display: TranscriptDisplay) {
		super();
		this.tui = tui;
		this.cwd = cwd;
		this.display = display;
		this.toolDefinitions = builtInToolDefinitions(cwd);
	}

	/** Replace the rendered conversation with the current content of `sessionFile`. */
	load(sessionFile: string): void {
		const entries = parseSessionEntries(readFileSync(sessionFile, "utf-8")).filter(
			(entry): entry is SessionEntry => entry.type !== "session",
		);
		this.clear();
		this.tools = [];
		this.assistants = [];
		this.renderMessages(buildSessionContext(entries).messages);
	}

	/** Apply the current display toggles to every message already rendered. */
	applyDisplay(): void {
		for (const tool of this.tools) tool.setExpanded(this.display.toolsExpanded);
		for (const assistant of this.assistants) assistant.setHideThinkingBlock(this.display.hideThinking);
	}

	// Mirrors InteractiveMode.renderSessionItems: tool calls render under their assistant message,
	// and each tool result fills the call it answers.
	private renderMessages(messages: AgentMessage[]): void {
		const pending = new Map<string, ToolExecutionComponent>();
		for (const message of messages) {
			if (message.role === "user") {
				const text = userText(message.content);
				if (!text) continue;
				if (this.children.length > 0) this.addChild(new Spacer(1));
				this.addChild(new UserMessageComponent(text, getMarkdownTheme()));
			} else if (message.role === "assistant") {
				const assistant = new AssistantMessageComponent(message, this.display.hideThinking, getMarkdownTheme());
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
					this.tools.push(tool);
					this.addChild(tool);
					pending.set(part.id, tool);
				}
			} else if (message.role === "toolResult") {
				pending.get(message.toolCallId)?.updateResult(message);
				pending.delete(message.toolCallId);
			}
		}
	}
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
