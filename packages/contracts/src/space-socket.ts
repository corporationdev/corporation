import { z } from "zod";

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
