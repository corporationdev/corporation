import {
	zAvailableCommandsUpdate,
	zConfigOptionUpdate,
	zContentChunk,
	zCurrentModeUpdate,
	zError,
	zPlan,
	zPromptRequest,
	zSessionInfoUpdate,
	zToolCall,
	zToolCallUpdate,
	zUsageUpdate,
} from "@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import { z } from "zod";

const jsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);
export type JsonRpcId = z.infer<typeof jsonRpcIdSchema>;

export const sessionEventSenderSchema = z.enum(["client", "agent"]);
export type SessionEventSender = z.infer<typeof sessionEventSenderSchema>;

const sessionEventBaseSchema = z.object({
	id: z.string().min(1),
	createdAt: z.number(),
	sender: sessionEventSenderSchema,
	sessionId: z.string().min(1),
});

const contentChunkTextSchema = z.string().nullable();

const userPromptSessionEventSchema = sessionEventBaseSchema.extend({
	kind: z.literal("user_prompt"),
	request: zPromptRequest,
	requestId: jsonRpcIdSchema,
	text: z.string().nullable(),
});

const userMessageChunkUpdateSchema = zContentChunk.and(
	z.object({
		sessionUpdate: z.literal("user_message_chunk"),
	})
);

const userMessageChunkSessionEventSchema = sessionEventBaseSchema.extend({
	kind: z.literal("user_message_chunk"),
	text: contentChunkTextSchema,
	update: userMessageChunkUpdateSchema,
});

const agentMessageChunkUpdateSchema = zContentChunk.and(
	z.object({
		sessionUpdate: z.literal("agent_message_chunk"),
	})
);

const agentMessageChunkSessionEventSchema = sessionEventBaseSchema.extend({
	kind: z.literal("agent_message_chunk"),
	text: contentChunkTextSchema,
	update: agentMessageChunkUpdateSchema,
});

const agentThoughtChunkUpdateSchema = zContentChunk.and(
	z.object({
		sessionUpdate: z.literal("agent_thought_chunk"),
	})
);

const agentThoughtChunkSessionEventSchema = sessionEventBaseSchema.extend({
	kind: z.literal("agent_thought_chunk"),
	text: contentChunkTextSchema,
	update: agentThoughtChunkUpdateSchema,
});

const toolCallUpdateSchema = zToolCall.and(
	z.object({
		sessionUpdate: z.literal("tool_call"),
	})
);

const toolCallSessionEventSchema = sessionEventBaseSchema.extend({
	kind: z.literal("tool_call"),
	toolCallId: z.string().min(1),
	title: z.string(),
	status: z.enum(["pending", "in_progress", "completed", "failed"]).nullable(),
	rawInput: z.unknown().optional(),
	rawOutput: z.unknown().optional(),
	update: toolCallUpdateSchema,
});

const toolCallProgressUpdateSchema = zToolCallUpdate.and(
	z.object({
		sessionUpdate: z.literal("tool_call_update"),
	})
);

const toolCallUpdateSessionEventSchema = sessionEventBaseSchema.extend({
	kind: z.literal("tool_call_update"),
	toolCallId: z.string().min(1),
	title: z.string().nullable().optional(),
	status: z
		.enum(["pending", "in_progress", "completed", "failed"])
		.nullable()
		.optional(),
	rawInput: z.unknown().optional(),
	rawOutput: z.unknown().optional(),
	update: toolCallProgressUpdateSchema,
});

const planUpdateSchema = zPlan.and(
	z.object({
		sessionUpdate: z.literal("plan"),
	})
);

const planSessionEventSchema = sessionEventBaseSchema.extend({
	kind: z.literal("plan"),
	update: planUpdateSchema,
});

const availableCommandsUpdateSchema = zAvailableCommandsUpdate.and(
	z.object({
		sessionUpdate: z.literal("available_commands_update"),
	})
);

const availableCommandsSessionEventSchema = sessionEventBaseSchema.extend({
	kind: z.literal("available_commands_update"),
	update: availableCommandsUpdateSchema,
});

const currentModeUpdateSchema = zCurrentModeUpdate.and(
	z.object({
		sessionUpdate: z.literal("current_mode_update"),
	})
);

const currentModeSessionEventSchema = sessionEventBaseSchema.extend({
	kind: z.literal("current_mode_update"),
	update: currentModeUpdateSchema,
});

const configOptionUpdateSchema = zConfigOptionUpdate.and(
	z.object({
		sessionUpdate: z.literal("config_option_update"),
	})
);

const configOptionSessionEventSchema = sessionEventBaseSchema.extend({
	kind: z.literal("config_option_update"),
	update: configOptionUpdateSchema,
});

const sessionInfoUpdateSchema = zSessionInfoUpdate.and(
	z.object({
		sessionUpdate: z.literal("session_info_update"),
	})
);

const sessionInfoSessionEventSchema = sessionEventBaseSchema.extend({
	kind: z.literal("session_info_update"),
	update: sessionInfoUpdateSchema,
});

const usageUpdateSchema = zUsageUpdate.and(
	z.object({
		sessionUpdate: z.literal("usage_update"),
	})
);

const usageSessionEventSchema = sessionEventBaseSchema.extend({
	kind: z.literal("usage_update"),
	update: usageUpdateSchema,
});

const acpRequestSessionEventSchema = sessionEventBaseSchema.extend({
	kind: z.literal("acp_request"),
	method: z.string().min(1),
	params: z.unknown().optional(),
	requestId: jsonRpcIdSchema,
});

const acpNotificationSessionEventSchema = sessionEventBaseSchema.extend({
	kind: z.literal("acp_notification"),
	method: z.string().min(1),
	params: z.unknown().optional(),
});

const acpResponseSessionEventSchema = sessionEventBaseSchema.extend({
	kind: z.literal("acp_response"),
	requestId: jsonRpcIdSchema,
	result: z.unknown(),
});

const acpErrorSessionEventSchema = sessionEventBaseSchema.extend({
	kind: z.literal("acp_error"),
	error: zError,
	requestId: jsonRpcIdSchema,
});

export const sessionEventSchema = z.discriminatedUnion("kind", [
	userPromptSessionEventSchema,
	userMessageChunkSessionEventSchema,
	agentMessageChunkSessionEventSchema,
	agentThoughtChunkSessionEventSchema,
	toolCallSessionEventSchema,
	toolCallUpdateSessionEventSchema,
	planSessionEventSchema,
	availableCommandsSessionEventSchema,
	currentModeSessionEventSchema,
	configOptionSessionEventSchema,
	sessionInfoSessionEventSchema,
	usageSessionEventSchema,
	acpRequestSessionEventSchema,
	acpNotificationSessionEventSchema,
	acpResponseSessionEventSchema,
	acpErrorSessionEventSchema,
]);
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
