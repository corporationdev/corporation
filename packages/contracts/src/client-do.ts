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
