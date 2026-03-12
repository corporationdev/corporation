import { z } from "zod";
import {
	type RuntimeClientType as SharedRuntimeClientType,
	runtimeClientTypeSchema as sharedRuntimeClientTypeSchema,
} from "./runtime-auth";
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

export type RuntimeClientType = SharedRuntimeClientType;
export const runtimeClientTypeSchema = sharedRuntimeClientTypeSchema;

export const promptPartSchema = z.object({
	type: z.literal("text"),
	text: z.string(),
});
export type PromptPart = z.infer<typeof promptPartSchema>;

export const promptRequestBodySchema = z.object({
	agent: z.string().min(1),
	cwd: z.string().min(1),
	modelId: z.string().optional(),
	prompt: z.array(promptPartSchema),
	sessionId: z.string().min(1),
	turnId: z.string().min(1),
});
export type PromptRequestBody = z.infer<typeof promptRequestBodySchema>;

export const agentProbeRequestBodySchema = z.object({
	cwd: z.string().min(1).optional(),
	ids: z.array(z.string().min(1)).min(1),
});
export type AgentProbeRequestBody = z.infer<typeof agentProbeRequestBodySchema>;

export const agentProbeStatusSchema = z.enum([
	"verified",
	"requires_auth",
	"not_installed",
	"error",
]);
export type AgentProbeStatus = z.infer<typeof agentProbeStatusSchema>;

export const agentProbeAgentSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	status: agentProbeStatusSchema,
	configOptions: z.array(z.any()).nullable().optional(),
	verifiedAt: z.number().nullable().optional(),
	authCheckedAt: z.number().nullable().optional(),
	error: z.string().nullable().optional(),
});
export type AgentProbeAgent = z.infer<typeof agentProbeAgentSchema>;

export const agentProbeResponseSchema = z.object({
	probedAt: z.number(),
	agents: z.array(agentProbeAgentSchema),
});
export type AgentProbeResponse = z.infer<typeof agentProbeResponseSchema>;

const turnRunnerErrorSchema = z.object({
	name: z.string().min(1),
	message: z.string().min(1),
	stack: z.string().nullable().optional(),
});
export type TurnRunnerError = z.infer<typeof turnRunnerErrorSchema>;

export const runtimeSocketCapabilitiesSchema = z.object({
	sessionEventBatching: z.boolean().optional(),
	turnCancellation: z.boolean().optional(),
	agentProbing: z.boolean().optional(),
});
export type RuntimeSocketCapabilities = z.infer<
	typeof runtimeSocketCapabilitiesSchema
>;

export const runtimeHelloMessageSchema = z.object({
	type: z.literal("hello"),
	spaceSlug: z.string().min(1),
	sandboxId: z.string().min(1),
	clientType: runtimeClientTypeSchema,
	protocolVersion: z.number().int().positive(),
	capabilities: runtimeSocketCapabilitiesSchema.optional(),
});
export type RuntimeHelloMessage = z.infer<typeof runtimeHelloMessageSchema>;

export const runtimeHelloAckMessageSchema = z.object({
	type: z.literal("hello_ack"),
	connectionId: z.string().min(1),
	connectedAt: z.number().int().positive(),
});
export type RuntimeHelloAckMessage = z.infer<
	typeof runtimeHelloAckMessageSchema
>;

const runtimeCommandBaseSchema = z.object({
	commandId: z.string().min(1),
});

export const runtimeStartTurnMessageSchema = runtimeCommandBaseSchema.extend({
	type: z.literal("start_turn"),
	turnId: z.string().min(1),
	sessionId: z.string().min(1),
	agent: z.string().min(1),
	modelId: z.string().optional(),
	cwd: z.string().min(1),
	prompt: z.array(promptPartSchema),
});
export type RuntimeStartTurnMessage = z.infer<
	typeof runtimeStartTurnMessageSchema
>;

export const runtimeCancelTurnMessageSchema = runtimeCommandBaseSchema.extend({
	type: z.literal("cancel_turn"),
	turnId: z.string().min(1),
});
export type RuntimeCancelTurnMessage = z.infer<
	typeof runtimeCancelTurnMessageSchema
>;

export const runtimeProbeAgentsMessageSchema = runtimeCommandBaseSchema.extend({
	type: z.literal("probe_agents"),
	ids: z.array(z.string().min(1)).min(1),
	cwd: z.string().min(1).optional(),
});
export type RuntimeProbeAgentsMessage = z.infer<
	typeof runtimeProbeAgentsMessageSchema
>;

export const runtimeCommandRejectedMessageSchema =
	runtimeCommandBaseSchema.extend({
		type: z.literal("command_rejected"),
		reason: z.string().min(1),
	});
export type RuntimeCommandRejectedMessage = z.infer<
	typeof runtimeCommandRejectedMessageSchema
>;

export const runtimeSessionEventBatchMessageSchema = z.object({
	type: z.literal("session_event_batch"),
	turnId: z.string().min(1),
	sessionId: z.string().min(1),
	events: z.array(sessionEventSchema),
});
export type RuntimeSessionEventBatchMessage = z.infer<
	typeof runtimeSessionEventBatchMessageSchema
>;

export const runtimeTurnCompletedMessageSchema = z.object({
	type: z.literal("turn_completed"),
	turnId: z.string().min(1),
	sessionId: z.string().min(1),
});
export type RuntimeTurnCompletedMessage = z.infer<
	typeof runtimeTurnCompletedMessageSchema
>;

export const runtimeTurnFailedMessageSchema = z.object({
	type: z.literal("turn_failed"),
	turnId: z.string().min(1),
	sessionId: z.string().min(1),
	error: turnRunnerErrorSchema,
});
export type RuntimeTurnFailedMessage = z.infer<
	typeof runtimeTurnFailedMessageSchema
>;

export const runtimeProbeResultMessageSchema = agentProbeResponseSchema.extend({
	type: z.literal("probe_result"),
	commandId: z.string().min(1),
});
export type RuntimeProbeResultMessage = z.infer<
	typeof runtimeProbeResultMessageSchema
>;

export const runtimeHeartbeatMessageSchema = z.object({
	type: z.literal("heartbeat"),
	timestamp: z.number().int().positive().optional(),
});
export type RuntimeHeartbeatMessage = z.infer<
	typeof runtimeHeartbeatMessageSchema
>;

export const runtimeServerMessageSchema = z.discriminatedUnion("type", [
	runtimeHelloAckMessageSchema,
	runtimeStartTurnMessageSchema,
	runtimeCancelTurnMessageSchema,
	runtimeProbeAgentsMessageSchema,
]);
export type RuntimeServerMessage = z.infer<typeof runtimeServerMessageSchema>;

export const runtimeClientMessageSchema = z.discriminatedUnion("type", [
	runtimeHelloMessageSchema,
	runtimeSessionEventBatchMessageSchema,
	runtimeTurnCompletedMessageSchema,
	runtimeTurnFailedMessageSchema,
	runtimeProbeResultMessageSchema,
	runtimeCommandRejectedMessageSchema,
	runtimeHeartbeatMessageSchema,
]);
export type RuntimeClientMessage = z.infer<typeof runtimeClientMessageSchema>;
