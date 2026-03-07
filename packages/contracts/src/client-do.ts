import { z } from "zod";
import { sessionEventSchema } from "./sandbox-do";

export type {
	AcpEnvelope,
	SessionEvent,
	SessionEventSender,
} from "./sandbox-do";
export { sessionEventSchema, sessionEventSenderSchema } from "./sandbox-do";

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

export const sessionStreamFrameDataSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("event"),
		event: sessionEventSchema,
	}),
	z.object({
		kind: z.literal("status_changed"),
		status: sessionStatusSchema,
		reason: z.string().min(1).optional(),
	}),
]);
export type SessionStreamFrameData = z.infer<
	typeof sessionStreamFrameDataSchema
>;

export const sessionStreamStateSchema = z.object({
	sessionId: z.string().min(1),
	status: sessionStatusSchema,
	agent: z.string().nullable(),
	modelId: z.string().nullable(),
	lastOffset: z.number().int().gte(0),
});
export type SessionStreamState = z.infer<typeof sessionStreamStateSchema>;
