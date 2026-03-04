import type { SessionEvent } from "sandbox-agent";
import { z } from "zod";

const sessionEventSchema: z.ZodType<SessionEvent> = z.object({
	id: z.string().min(1),
	eventIndex: z.number().int(),
	sessionId: z.string().min(1),
	createdAt: z.number(),
	connectionId: z.string().min(1),
	sender: z.enum(["client", "agent"]),
	payload: z.custom<SessionEvent["payload"]>(
		(value) => typeof value === "object" && value !== null,
		"Turn runner event payload must be an object"
	),
});

const turnRunnerErrorSchema = z.object({
	name: z.string().min(1),
	message: z.string().min(1),
	stack: z.string().nullable().optional(),
});

const turnRunnerCallbackBaseSchema = z.object({
	turnId: z.string().min(1),
	sessionId: z.string().min(1),
	token: z.string().min(1),
	sequence: z.number().int().gte(1),
	timestamp: z.number(),
	lastEventIndex: z.number().int().nonnegative().optional(),
});

const turnRunnerCallbackPayloadSchema = z.discriminatedUnion("kind", [
	turnRunnerCallbackBaseSchema.extend({
		kind: z.literal("events"),
		events: z.array(sessionEventSchema),
	}),
	turnRunnerCallbackBaseSchema.extend({
		kind: z.literal("completed"),
		stopReason: z.string().nullable(),
	}),
	turnRunnerCallbackBaseSchema.extend({
		kind: z.literal("failed"),
		error: turnRunnerErrorSchema,
	}),
]);

export type TurnRunnerCallbackPayload = z.infer<
	typeof turnRunnerCallbackPayloadSchema
>;

function zodPath(path: PropertyKey[]): string {
	if (path.length === 0) {
		return "(root)";
	}
	return path
		.map((segment) =>
			typeof segment === "symbol" ? segment.toString() : String(segment)
		)
		.join(".");
}

export function parseTurnRunnerCallbackPayload(
	value: unknown
): TurnRunnerCallbackPayload {
	const parsed = turnRunnerCallbackPayloadSchema.safeParse(value);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		if (!issue) {
			throw new Error("Turn runner callback payload is invalid");
		}
		throw new Error(
			`Turn runner callback payload is invalid at ${zodPath(issue.path)}: ${issue.message}`
		);
	}
	return parsed.data;
}
