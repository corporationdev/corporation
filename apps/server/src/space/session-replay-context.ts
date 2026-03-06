import type { SessionEvent } from "@corporation/shared/session-protocol";
import { and, asc, eq, gt } from "drizzle-orm";
import { sessionStreamFrames } from "../db/schema";
import type { SpaceRuntimeContext } from "./types";

const REPLAY_PREFIX = "Previous session history is replayed below";
const REPLAY_PAGE_SIZE = 200;

export type SessionPromptPart = { type: "text"; text: string };

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
}

function extractUserPromptText(event: SessionEvent): string | null {
	if (event.sender !== "client") {
		return null;
	}
	const payload = asRecord(event.payload);
	if (!payload || payload.method !== "session/prompt") {
		return null;
	}
	const params = asRecord(payload.params);
	const prompt = Array.isArray(params?.prompt) ? params.prompt : null;
	if (!prompt) {
		return null;
	}

	const parts: string[] = [];
	for (const item of prompt) {
		const block = asRecord(item);
		if (!block || block.type !== "text" || typeof block.text !== "string") {
			continue;
		}
		const text = block.text.trim();
		if (text.length === 0 || text.startsWith(REPLAY_PREFIX)) {
			continue;
		}
		parts.push(text);
	}

	const text = parts.join("\n\n").trim();
	return text.length > 0 ? text : null;
}

function extractAssistantChunk(event: SessionEvent): string | null {
	if (event.sender !== "agent") {
		return null;
	}
	const payload = asRecord(event.payload);
	if (!payload || payload.method !== "session/update") {
		return null;
	}
	const params = asRecord(payload.params);
	const update = asRecord(params?.update);
	if (!update || update.sessionUpdate !== "agent_message_chunk") {
		return null;
	}
	const content = asRecord(update.content);
	if (!content || content.type !== "text" || typeof content.text !== "string") {
		return null;
	}
	return content.text;
}

function buildReplayHistory(events: SessionEvent[]): string | null {
	if (events.length === 0) {
		return null;
	}

	const ordered = [...events].sort((left, right) => {
		if (left.createdAt !== right.createdAt) {
			return left.createdAt - right.createdAt;
		}
		if (left.eventIndex !== right.eventIndex) {
			return left.eventIndex - right.eventIndex;
		}
		return left.id.localeCompare(right.id);
	});

	const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
	let assistantText = "";
	const flushAssistant = () => {
		const text = assistantText.trim();
		if (text.length > 0) {
			turns.push({ role: "assistant", text });
		}
		assistantText = "";
	};

	for (const event of ordered) {
		const userText = extractUserPromptText(event);
		if (userText) {
			flushAssistant();
			turns.push({ role: "user", text: userText });
			continue;
		}

		const chunk = extractAssistantChunk(event);
		if (chunk) {
			assistantText += chunk;
		}
	}
	flushAssistant();

	if (turns.length === 0) {
		return null;
	}

	return turns
		.map((turn) =>
			turn.role === "user" ? `User:\n${turn.text}` : `Assistant:\n${turn.text}`
		)
		.join("\n\n");
}

function toSessionEvent(row: {
	data: Record<string, unknown>;
}): SessionEvent | null {
	const kind = row.data.kind;
	if (kind !== "event") {
		return null;
	}
	const event = row.data.event;
	if (!event || typeof event !== "object") {
		return null;
	}
	return event as SessionEvent;
}

export async function buildPromptWithReplay(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	content: string
): Promise<SessionPromptPart[]> {
	const fallbackPrompt: SessionPromptPart[] = [{ type: "text", text: content }];
	const events: SessionEvent[] = [];
	let lastOffset = -1;

	for (;;) {
		const conditions = [
			eq(sessionStreamFrames.sessionId, sessionId),
			eq(sessionStreamFrames.kind, "event"),
			gt(sessionStreamFrames.offset, lastOffset),
		];

		const rows = await ctx.vars.db
			.select({
				offset: sessionStreamFrames.offset,
				data: sessionStreamFrames.data,
			})
			.from(sessionStreamFrames)
			.where(and(...conditions))
			.orderBy(asc(sessionStreamFrames.offset))
			.limit(REPLAY_PAGE_SIZE);

		if (rows.length === 0) {
			break;
		}

		const pageEvents = rows
			.map(toSessionEvent)
			.filter((event): event is SessionEvent => event !== null);
		events.push(...pageEvents);

		const lastRow = rows.at(-1);
		if (!lastRow || rows.length < REPLAY_PAGE_SIZE) {
			break;
		}
		lastOffset = lastRow.offset;
	}

	const replayHistory = buildReplayHistory(events);
	if (!replayHistory) {
		return fallbackPrompt;
	}

	return [
		{
			type: "text",
			text: `${REPLAY_PREFIX}. Treat this as transcript context only.\n\n${replayHistory}`,
		},
		{ type: "text", text: content },
	];
}
