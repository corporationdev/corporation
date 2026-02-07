import type { Connection, WSMessage } from "agents";
import { Agent, routeAgentRequest } from "agents";
import { Hono } from "hono";
import type { UniversalEvent, UniversalItem } from "sandbox-agent";

type Env = {
	SandboxAgent: DurableObjectNamespace;
};

type SendMessageRequest = {
	type: "send_message";
	content: string;
};

type ClientMessage = SendMessageRequest;

type EventMessage = {
	type: "event";
	data: UniversalEvent;
};

type ServerMessage = EventMessage;

const STREAM_DELAY_MS = 50;

export class SandboxAgent extends Agent<Env> {
	private events: UniversalEvent[] = [];
	private sequenceCounter = 0;

	async onConnect(connection: Connection) {
		const storedEvents = await this.ctx.storage.get<UniversalEvent[]>("events");
		if (storedEvents) {
			this.events = storedEvents;
			this.sequenceCounter = storedEvents.length;
		}

		for (const event of this.events) {
			const message: ServerMessage = { type: "event", data: event };
			connection.send(JSON.stringify(message));
		}
	}

	async onMessage(_connection: Connection, message: WSMessage) {
		if (typeof message !== "string") {
			return;
		}

		let parsed: ClientMessage;
		try {
			parsed = JSON.parse(message) as ClientMessage;
		} catch {
			return;
		}

		if (parsed.type === "send_message") {
			await this.handleSendMessage(parsed.content);
		}
	}

	private async handleSendMessage(content: string) {
		const sessionId = this.ctx.id.toString();

		const userItemId = crypto.randomUUID();
		const userItem: UniversalItem = {
			item_id: userItemId,
			kind: "message",
			role: "user",
			status: "completed",
			content: [{ type: "text", text: content }],
		};

		await this.emitEvent({
			type: "item.started",
			data: { item: userItem },
			session_id: sessionId,
		});

		await this.emitEvent({
			type: "item.completed",
			data: { item: userItem },
			session_id: sessionId,
		});

		const assistantItemId = crypto.randomUUID();
		const assistantItem: UniversalItem = {
			item_id: assistantItemId,
			kind: "message",
			role: "assistant",
			status: "in_progress",
			content: [],
		};

		await this.emitEvent({
			type: "item.started",
			data: { item: assistantItem },
			session_id: sessionId,
		});

		const responseText = "Hello, World!";
		for (const char of responseText) {
			await this.emitEvent({
				type: "item.delta",
				data: {
					item_id: assistantItemId,
					delta: char,
				},
				session_id: sessionId,
			});
			await new Promise((resolve) => setTimeout(resolve, STREAM_DELAY_MS));
		}

		const completedAssistantItem: UniversalItem = {
			item_id: assistantItemId,
			kind: "message",
			role: "assistant",
			status: "completed",
			content: [{ type: "text", text: responseText }],
		};

		await this.emitEvent({
			type: "item.completed",
			data: { item: completedAssistantItem },
			session_id: sessionId,
		});
	}

	private async emitEvent(
		partial: Omit<
			UniversalEvent,
			"event_id" | "sequence" | "time" | "source" | "synthetic"
		>
	) {
		const event: UniversalEvent = {
			event_id: crypto.randomUUID(),
			sequence: this.sequenceCounter++,
			time: new Date().toISOString(),
			source: "daemon",
			synthetic: false,
			...partial,
		};

		this.events.push(event);
		await this.ctx.storage.put("events", this.events);

		const message: ServerMessage = { type: "event", data: event };
		this.broadcast(JSON.stringify(message));
	}
}

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("OK"));
app.get("/health", (c) => c.text("OK"));

app.all("/agents/*", async (c) => {
	const response = await routeAgentRequest(c.req.raw, c.env);
	return response ?? c.text("Agent not found", 404);
});

export default app;
