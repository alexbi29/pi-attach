// What the main session does while a child view covers it: whether its agent is working and what it said meanwhile.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Main-session activity for the child view, kept from pi's agent and message events. */
export class MainActivity {
	/** True from the main agent's start until it settles. */
	working = false;
	/** Messages the main session finished since the last `markSeen()`: replies and notices such as completions. */
	unseen = 0;
	private readonly listeners = new Set<() => void>();

	constructor(pi: ExtensionAPI) {
		pi.on("agent_start", () => this.update(() => (this.working = true)));
		pi.on("agent_settled", () => this.update(() => (this.working = false)));
		pi.on("message_end", (event) => {
			// The user's own messages (typed before opening the view) are not news.
			if (event.message.role !== "user") this.update(() => this.unseen++);
		});
	}

	/** Start counting from zero; the view calls it when it opens. */
	markSeen(): void {
		this.update(() => (this.unseen = 0));
	}

	/** Call `listener` after every change; returns the unsubscribe function. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private update(change: () => unknown): void {
		change();
		for (const listener of this.listeners) listener();
	}
}
