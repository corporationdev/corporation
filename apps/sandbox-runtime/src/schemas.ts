import { AGENT_METHODS, CLIENT_METHODS } from "@agentclientprotocol/sdk";
import {
	zAgentRequest,
	zAuthenticateRequest,
	zAuthenticateResponse,
	zCancelNotification,
	zClientNotification,
	zClientRequest,
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
	zSetSessionModelRequest,
	zSetSessionModelResponse,
	zSetSessionModeRequest,
	zSetSessionModeResponse,
} from "@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import { z } from "zod";

export type { AcpEnvelope } from "@corporation/contracts/sandbox-do";
export { acpEnvelopeSchema } from "@corporation/contracts/sandbox-do";

const jsonRpcVersionSchema = z.literal("2.0");
const jsonRpcEnvelopeBaseSchema = z.object({
	jsonrpc: jsonRpcVersionSchema,
});

const acpAgentRequestEnvelopeSchema =
	jsonRpcEnvelopeBaseSchema.and(zAgentRequest);

export const acpClientRequestEnvelopeSchema =
	jsonRpcEnvelopeBaseSchema.and(zClientRequest);
export type AcpClientRequestEnvelope = z.infer<
	typeof acpClientRequestEnvelopeSchema
>;

const acpClientNotificationEnvelopeSchema =
	jsonRpcEnvelopeBaseSchema.and(zClientNotification);

export const sessionCancelEnvelopeSchema =
	acpClientNotificationEnvelopeSchema.and(
		z.object({
			method: z.literal(AGENT_METHODS.session_cancel),
			params: zCancelNotification,
		})
	);
export type SessionCancelEnvelope = z.infer<typeof sessionCancelEnvelopeSchema>;

const jsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);

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
