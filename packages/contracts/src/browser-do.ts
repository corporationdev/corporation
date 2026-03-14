import { z } from "zod";
import { sessionEventSchema } from "./session-event";

export type { SessionEvent } from "./session-event";
// biome-ignore lint/performance/noBarrelFile: browser-do.ts is a public contract surface, re-exports are intentional
export { sessionEventSchema } from "./session-event";

export const sessionEventSenderSchema = z.enum(["client", "agent"]);
export type SessionEventSender = z.infer<typeof sessionEventSenderSchema>;

export const sessionStatusSchema = z.enum(["idle", "running", "error"]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const sessionStreamEventFrameSchema = z.object({
	kind: z.literal("event"),
	offset: z.number().int().gte(0),
	eventId: z.string().min(1),
	createdAt: z.number(),
	event: sessionEventSchema,
});
export type SessionStreamEventFrame = z.infer<
	typeof sessionStreamEventFrameSchema
>;

export const sessionStreamStatusFrameSchema = z.object({
	kind: z.literal("status_changed"),
	offset: z.number().int().gte(0),
	status: sessionStatusSchema,
	error: z.string().nullable().optional(),
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

export const sessionStreamFrameDataSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("event"),
		eventId: z.string().min(1),
		createdAt: z.number(),
		event: sessionEventSchema,
	}),
	z.object({
		kind: z.literal("status_changed"),
		status: sessionStatusSchema,
		error: z.string().nullable().optional(),
		reason: z.string().min(1).optional(),
	}),
]);
export type SessionStreamFrameData = z.infer<
	typeof sessionStreamFrameDataSchema
>;

export const sessionStreamStateSchema = z.object({
	sessionId: z.string().min(1),
	status: sessionStatusSchema,
	error: z.string().nullable().optional(),
	agent: z.string().nullable(),
	modelId: z.string().nullable(),
	lastOffset: z.number().int().gte(0),
});
export type SessionStreamState = z.infer<typeof sessionStreamStateSchema>;

export const sessionRowSchema = z.object({
	id: z.string().min(1),
	title: z.string(),
	agent: z.string(),
	agentSessionId: z.string(),
	lastConnectionId: z.string(),
	createdAt: z.number().int(),
	updatedAt: z.number().int(),
	destroyedAt: z.number().int().nullable(),
	sessionInit: z.unknown().nullable().optional(),
	modelId: z.string().nullable(),
	runId: z.string().nullable(),
	pid: z.number().int().nullable(),
	status: sessionStatusSchema,
	lastStreamOffset: z.number().int(),
	callbackToken: z.string().nullable(),
	error: z.string().nullable().optional(),
});
export type SessionRow = z.infer<typeof sessionRowSchema>;

export const terminalOutputPayloadSchema = z.object({
	terminalId: z.string().min(1),
	data: z.array(z.number().int().gte(0).lte(255)),
	snapshot: z.boolean().optional(),
});
export type TerminalOutputPayload = z.infer<typeof terminalOutputPayloadSchema>;

export const spaceSocketEventNameSchema = z.enum([
	"sessions.changed",
	"terminal.output",
]);
export type SpaceSocketEventName = z.infer<typeof spaceSocketEventNameSchema>;

export const spaceSocketRpcRequestSchema = z.object({
	type: z.literal("rpc"),
	id: z.string().min(1),
	method: z.string().min(1),
	args: z.array(z.unknown()),
});
export type SpaceSocketRpcRequest = z.infer<typeof spaceSocketRpcRequestSchema>;

export const spaceSocketRpcResultSuccessSchema = z.object({
	type: z.literal("rpc_result"),
	id: z.string().min(1),
	ok: z.literal(true),
	result: z.unknown(),
});
export type SpaceSocketRpcResultSuccess = z.infer<
	typeof spaceSocketRpcResultSuccessSchema
>;

export const spaceSocketRpcResultErrorSchema = z.object({
	type: z.literal("rpc_result"),
	id: z.string().min(1),
	ok: z.literal(false),
	error: z.object({
		code: z.string().min(1),
		message: z.string().min(1),
	}),
});
export type SpaceSocketRpcResultError = z.infer<
	typeof spaceSocketRpcResultErrorSchema
>;

export const spaceSocketEventMessageSchema = z.object({
	type: z.literal("event"),
	event: spaceSocketEventNameSchema,
	payload: z.unknown(),
});
export type SpaceSocketEventMessage = z.infer<
	typeof spaceSocketEventMessageSchema
>;

export const spaceSocketServerMessageSchema = z.discriminatedUnion("type", [
	spaceSocketRpcResultSuccessSchema,
	spaceSocketRpcResultErrorSchema,
	spaceSocketEventMessageSchema,
]);
export type SpaceSocketServerMessage = z.infer<
	typeof spaceSocketServerMessageSchema
>;

export const spaceSocketClientMessageSchema = z.discriminatedUnion("type", [
	spaceSocketRpcRequestSchema,
]);
export type SpaceSocketClientMessage = z.infer<
	typeof spaceSocketClientMessageSchema
>;
