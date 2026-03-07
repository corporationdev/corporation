import { z } from "zod";

export const sessionEventSenderSchema = z.enum(["client", "agent"]);
export type SessionEventSender = z.infer<typeof sessionEventSenderSchema>;

export const sessionEventSchema = z.object({
	connectionId: z.string().min(1),
	createdAt: z.number(),
	eventIndex: z.number().int(),
	id: z.string().min(1),
	payload: z.record(z.string(), z.unknown()),
	sender: sessionEventSenderSchema,
	sessionId: z.string().min(1),
});
export type SessionEvent = z.infer<typeof sessionEventSchema>;

export const sessionStatusSchema = z.enum(["idle", "running", "error"]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const sessionStreamEventFrameSchema = z.object({
	kind: z.literal("event"),
	offset: z.number().int().gte(0),
	event: sessionEventSchema,
});
export type SessionStreamEventFrame = z.infer<
	typeof sessionStreamEventFrameSchema
>;

export const sessionStreamStatusFrameSchema = z.object({
	kind: z.literal("status_changed"),
	offset: z.number().int().gte(0),
	status: sessionStatusSchema,
	reason: z.string().min(1).optional(),
});
export type SessionStreamStatusFrame = z.infer<
	typeof sessionStreamStatusFrameSchema
>;

export const sessionStreamFrameSchema = z.discriminatedUnion("kind", [
	sessionStreamEventFrameSchema,
	sessionStreamStatusFrameSchema,
]);
export type SessionStreamFrame = z.infer<typeof sessionStreamFrameSchema>;

export const sessionStreamStateSchema = z.object({
	sessionId: z.string().min(1),
	status: sessionStatusSchema,
	agent: z.string().nullable(),
	modelId: z.string().nullable(),
	lastOffset: z.number().int().gte(0),
});
export type SessionStreamState = z.infer<typeof sessionStreamStateSchema>;

export const promptPartSchema = z.object({
	type: z.string().min(1),
	text: z.string(),
});
export type PromptPart = z.infer<typeof promptPartSchema>;

export const promptRequestBodySchema = z.object({
	agent: z.string().min(1),
	callbackToken: z.string().min(1),
	callbackUrl: z.url(),
	cwd: z.string().min(1),
	modelId: z.string().optional(),
	prompt: z.array(promptPartSchema),
	sessionId: z.string().min(1),
	turnId: z.string().min(1),
});
export type PromptRequestBody = z.infer<typeof promptRequestBodySchema>;

export const turnRunnerErrorSchema = z.object({
	name: z.string().min(1),
	message: z.string().min(1),
	stack: z.string().nullable().optional(),
});
export type TurnRunnerError = z.infer<typeof turnRunnerErrorSchema>;

export const turnRunnerCallbackBaseSchema = z.object({
	turnId: z.string().min(1),
	sessionId: z.string().min(1),
	token: z.string().min(1),
	sequence: z.number().int().gte(1),
	timestamp: z.number(),
});

export const turnRunnerEventsCallbackSchema =
	turnRunnerCallbackBaseSchema.extend({
		kind: z.literal("events"),
		events: z.array(sessionEventSchema),
	});
export type TurnRunnerEventsCallback = z.infer<
	typeof turnRunnerEventsCallbackSchema
>;

export const turnRunnerCompletedCallbackSchema =
	turnRunnerCallbackBaseSchema.extend({
		kind: z.literal("completed"),
	});
export type TurnRunnerCompletedCallback = z.infer<
	typeof turnRunnerCompletedCallbackSchema
>;

export const turnRunnerFailedCallbackSchema =
	turnRunnerCallbackBaseSchema.extend({
		kind: z.literal("failed"),
		error: turnRunnerErrorSchema,
	});
export type TurnRunnerFailedCallback = z.infer<
	typeof turnRunnerFailedCallbackSchema
>;

export const turnRunnerCallbackPayloadSchema = z.discriminatedUnion("kind", [
	turnRunnerEventsCallbackSchema,
	turnRunnerCompletedCallbackSchema,
	turnRunnerFailedCallbackSchema,
]);
export type TurnRunnerCallbackPayload = z.infer<
	typeof turnRunnerCallbackPayloadSchema
>;
