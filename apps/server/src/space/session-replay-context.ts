import type { SessionEvent } from "@corporation/shared/session-protocol";
import { and, asc, eq, gt } from "drizzle-orm";
import { sessionEvents } from "../db/schema";
import type { SpaceRuntimeContext } from "./types";

const REPLAY_PREFIX = "Previous session history is replayed below";
const REPLAY_PAGE_SIZE = 200;
const MAX_REPLAY_EVENTS = 2000;
const MAX_REPLAY_TURNS = 24;
const MAX_REPLAY_CHARS = 12_000;

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

	let replayTurns = turns.slice(-MAX_REPLAY_TURNS);
	while (replayTurns.length > 1) {
		const formatted = replayTurns
			.map((turn) =>
				turn.role === "user"
					? `User:\n${turn.text}`
					: `Assistant:\n${turn.text}`
			)
			.join("\n\n");
		if (formatted.length <= MAX_REPLAY_CHARS) {
			return formatted;
		}
		replayTurns = replayTurns.slice(1);
	}

	if (replayTurns.length === 0) {
		return null;
	}

	const lastTurn = replayTurns[0];
	if (!lastTurn) {
		return null;
	}
	const prefix = lastTurn.role === "user" ? "User:\n" : "Assistant:\n";
	const budget = Math.max(200, MAX_REPLAY_CHARS - prefix.length);
	return `${prefix}${lastTurn.text.slice(-budget)}`;
}

function toSessionEvent(row: typeof sessionEvents.$inferSelect): SessionEvent {
	return {
		id: row.id,
		eventIndex: row.eventIndex,
		sessionId: row.sessionId,
		createdAt: row.createdAt,
		connectionId: row.connectionId,
		sender: row.sender,
		payload: row.payload,
	};
}

export async function buildPromptWithReplay(
	ctx: SpaceRuntimeContext,
	sessionId: string,
	content: string
): Promise<SessionPromptPart[]> {
	const fallbackPrompt: SessionPromptPart[] = [{ type: "text", text: content }];
	const events: SessionEvent[] = [];
	let lastEventIndex: number | undefined;

	while (events.length < MAX_REPLAY_EVENTS) {
		const conditions = [eq(sessionEvents.sessionId, sessionId)];
		if (lastEventIndex !== undefined) {
			conditions.push(gt(sessionEvents.eventIndex, lastEventIndex));
		}

		const pageLimit = Math.min(
			REPLAY_PAGE_SIZE,
			MAX_REPLAY_EVENTS - events.length
		);
		const rows = await ctx.vars.db
			.select()
			.from(sessionEvents)
			.where(and(...conditions))
			.orderBy(asc(sessionEvents.eventIndex))
			.limit(pageLimit);

		if (rows.length === 0) {
			break;
		}

		const pageEvents = rows.map(toSessionEvent);
		events.push(...pageEvents);

		const lastRow = rows.at(-1);
		if (!lastRow || rows.length < pageLimit) {
			break;
		}
		lastEventIndex = lastRow.eventIndex;
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
