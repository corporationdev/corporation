import { z } from "zod";
import {
	type AcpEnvelope as SharedAcpEnvelope,
	type SessionEvent as SharedSessionEvent,
	type SessionEventSender as SharedSessionEventSender,
	acpEnvelopeSchema as sharedAcpEnvelopeSchema,
	sessionEventSchema as sharedSessionEventSchema,
	sessionEventSenderSchema as sharedSessionEventSenderSchema,
} from "./session-events";

export type AcpEnvelope = SharedAcpEnvelope;
export const acpEnvelopeSchema = sharedAcpEnvelopeSchema;

export type SessionEvent = SharedSessionEvent;
export const sessionEventSchema = sharedSessionEventSchema;

export type SessionEventSender = SharedSessionEventSender;
export const sessionEventSenderSchema = sharedSessionEventSenderSchema;

export const promptPartSchema = z.object({
	type: z.literal("text"),
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

const turnRunnerErrorSchema = z.object({
	name: z.string().min(1),
	message: z.string().min(1),
	stack: z.string().nullable().optional(),
});
export type TurnRunnerError = z.infer<typeof turnRunnerErrorSchema>;

const turnRunnerCallbackBaseSchema = z.object({
	turnId: z.string().min(1),
	sessionId: z.string().min(1),
	token: z.string().min(1),
	sequence: z.number().int().gte(1),
	timestamp: z.number(),
});

const turnRunnerEventsCallbackSchema = turnRunnerCallbackBaseSchema.extend({
	kind: z.literal("events"),
	events: z.array(sessionEventSchema),
});
export type TurnRunnerEventsCallback = z.infer<
	typeof turnRunnerEventsCallbackSchema
>;

const turnRunnerCompletedCallbackSchema = turnRunnerCallbackBaseSchema.extend({
	kind: z.literal("completed"),
});
export type TurnRunnerCompletedCallback = z.infer<
	typeof turnRunnerCompletedCallbackSchema
>;

const turnRunnerFailedCallbackSchema = turnRunnerCallbackBaseSchema.extend({
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
