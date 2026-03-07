import { AGENT_METHODS, CLIENT_METHODS } from "@agentclientprotocol/sdk";
import {
	zAgentNotification,
	zAgentRequest,
	zAgentResponse,
	zAuthenticateRequest,
	zAuthenticateResponse,
	zCancelNotification,
	zClientNotification,
	zClientRequest,
	zClientResponse,
	zInitializeRequest,
	zInitializeResponse,
	zLoadSessionRequest,
	zLoadSessionResponse,
	zNewSessionRequest,
	zNewSessionResponse,
	zPromptRequest,
	zPromptResponse,
	zRequestPermissionRequest,
	zRequestPermissionResponse,
	zSessionNotification,
	zSetSessionModelRequest,
	zSetSessionModelResponse,
	zSetSessionModeRequest,
	zSetSessionModeResponse,
} from "@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import { z } from "zod";

const jsonRpcVersionSchema = z.literal("2.0");
const jsonRpcEnvelopeBaseSchema = z.object({
	jsonrpc: jsonRpcVersionSchema,
});

export const acpAgentRequestEnvelopeSchema =
	jsonRpcEnvelopeBaseSchema.and(zAgentRequest);
export type AcpAgentRequestEnvelope = z.infer<
	typeof acpAgentRequestEnvelopeSchema
>;

export const acpAgentResponseEnvelopeSchema =
	jsonRpcEnvelopeBaseSchema.and(zAgentResponse);
export type AcpAgentResponseEnvelope = z.infer<
	typeof acpAgentResponseEnvelopeSchema
>;

export const acpAgentNotificationEnvelopeSchema =
	jsonRpcEnvelopeBaseSchema.and(zAgentNotification);
export type AcpAgentNotificationEnvelope = z.infer<
	typeof acpAgentNotificationEnvelopeSchema
>;

export const acpClientRequestEnvelopeSchema =
	jsonRpcEnvelopeBaseSchema.and(zClientRequest);
export type AcpClientRequestEnvelope = z.infer<
	typeof acpClientRequestEnvelopeSchema
>;

export const acpClientResponseEnvelopeSchema =
	jsonRpcEnvelopeBaseSchema.and(zClientResponse);
export type AcpClientResponseEnvelope = z.infer<
	typeof acpClientResponseEnvelopeSchema
>;

export const acpClientNotificationEnvelopeSchema =
	jsonRpcEnvelopeBaseSchema.and(zClientNotification);
export type AcpClientNotificationEnvelope = z.infer<
	typeof acpClientNotificationEnvelopeSchema
>;

export const sessionCancelEnvelopeSchema =
	acpClientNotificationEnvelopeSchema.and(
		z.object({
			method: z.literal(AGENT_METHODS.session_cancel),
			params: zCancelNotification,
		})
	);
export type SessionCancelEnvelope = z.infer<typeof sessionCancelEnvelopeSchema>;

const jsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);

export const legacyRequestPermissionEnvelopeSchema = z.object({
	jsonrpc: jsonRpcVersionSchema,
	id: jsonRpcIdSchema,
	method: z.literal("requestPermission"),
	params: z.object({
		request: zRequestPermissionRequest,
	}),
});
export type LegacyRequestPermissionEnvelope = z.infer<
	typeof legacyRequestPermissionEnvelopeSchema
>;

export const acpEnvelopeSchema = z.union([
	acpAgentRequestEnvelopeSchema,
	acpAgentResponseEnvelopeSchema,
	acpAgentNotificationEnvelopeSchema,
	acpClientRequestEnvelopeSchema,
	acpClientResponseEnvelopeSchema,
	acpClientNotificationEnvelopeSchema,
	legacyRequestPermissionEnvelopeSchema,
]);
export type AcpEnvelope = z.infer<typeof acpEnvelopeSchema>;

const acpClientEnvelopeSchema = z.union([
	acpClientRequestEnvelopeSchema,
	acpClientResponseEnvelopeSchema,
	acpClientNotificationEnvelopeSchema,
]);

const acpAgentEnvelopeSchema = z.union([
	acpAgentRequestEnvelopeSchema,
	acpAgentResponseEnvelopeSchema,
	acpAgentNotificationEnvelopeSchema,
	legacyRequestPermissionEnvelopeSchema,
]);

export const sessionPromptEnvelopeSchema = acpClientRequestEnvelopeSchema.and(
	z.object({
		method: z.literal(AGENT_METHODS.session_prompt),
		params: zPromptRequest,
	})
);
export type SessionPromptEnvelope = z.infer<typeof sessionPromptEnvelopeSchema>;

export const sessionUpdateEnvelopeSchema =
	acpAgentNotificationEnvelopeSchema.and(
		z.object({
			method: z.literal(CLIENT_METHODS.session_update),
			params: zSessionNotification,
		})
	);
export type SessionUpdateEnvelope = z.infer<typeof sessionUpdateEnvelopeSchema>;

export const sessionRequestPermissionEnvelopeSchema =
	acpAgentRequestEnvelopeSchema.and(
		z.object({
			method: z.literal(CLIENT_METHODS.session_request_permission),
			params: zRequestPermissionRequest,
		})
	);
export type SessionRequestPermissionEnvelope = z.infer<
	typeof sessionRequestPermissionEnvelopeSchema
>;

export const sessionRequestPermissionResponseEnvelopeSchema = z.object({
	jsonrpc: jsonRpcVersionSchema,
	id: jsonRpcIdSchema,
	result: zRequestPermissionResponse,
});
export type SessionRequestPermissionResponseEnvelope = z.infer<
	typeof sessionRequestPermissionResponseEnvelopeSchema
>;

export const acpAgentRequestMethodSchemaMap = {
	initialize: {
		params: zInitializeRequest,
		result: zInitializeResponse,
	},
	authenticate: {
		params: zAuthenticateRequest,
		result: zAuthenticateResponse,
	},
	"session/new": {
		params: zNewSessionRequest,
		result: zNewSessionResponse,
	},
	"session/load": {
		params: zLoadSessionRequest,
		result: zLoadSessionResponse,
	},
	"session/set_mode": {
		params: zSetSessionModeRequest,
		result: zSetSessionModeResponse,
	},
	"session/set_model": {
		params: zSetSessionModelRequest,
		result: zSetSessionModelResponse,
	},
	"session/prompt": {
		params: zPromptRequest,
		result: zPromptResponse,
	},
} as const;

export type AcpAgentRequestMethod = keyof typeof acpAgentRequestMethodSchemaMap;
export type AcpAgentRequestParams<M extends AcpAgentRequestMethod> = z.input<
	(typeof acpAgentRequestMethodSchemaMap)[M]["params"]
>;
export type AcpAgentRequestResult<M extends AcpAgentRequestMethod> = z.output<
	(typeof acpAgentRequestMethodSchemaMap)[M]["result"]
>;

export function getAcpAgentRequestMethodSchemas(
	method: string
): { params: z.ZodTypeAny; result: z.ZodTypeAny } | null {
	const schemas = (
		acpAgentRequestMethodSchemaMap as Record<
			string,
			{ params: z.ZodTypeAny; result: z.ZodTypeAny }
		>
	)[method];
	return schemas ?? null;
}

export const sessionEventSenderSchema = z.enum(["client", "agent"]);
export type SessionEventSender = z.infer<typeof sessionEventSenderSchema>;

export const sessionEventSchema = z
	.object({
		connectionId: z.string().min(1),
		createdAt: z.number(),
		eventIndex: z.number().int(),
		id: z.string().min(1),
		payload: acpEnvelopeSchema,
		sender: sessionEventSenderSchema,
		sessionId: z.string().min(1),
	})
	.superRefine((event, ctx) => {
		const payloadResult =
			event.sender === "client"
				? acpClientEnvelopeSchema.safeParse(event.payload)
				: acpAgentEnvelopeSchema.safeParse(event.payload);
		if (payloadResult.success) {
			return;
		}

		ctx.addIssue({
			code: "custom",
			message: `Invalid ${event.sender} ACP envelope`,
			path: ["payload"],
		});
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
