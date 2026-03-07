import {
	zAgentNotification,
	zAgentRequest,
	zAgentResponse,
	zClientNotification,
	zClientRequest,
	zClientResponse,
} from "@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import { z } from "zod";

const jsonRpcVersionSchema = z.literal("2.0");
const jsonRpcEnvelopeBaseSchema = z.object({
	jsonrpc: jsonRpcVersionSchema,
});

const acpAgentRequestEnvelopeSchema =
	jsonRpcEnvelopeBaseSchema.and(zAgentRequest);

const acpAgentResponseEnvelopeSchema =
	jsonRpcEnvelopeBaseSchema.and(zAgentResponse);

const acpAgentNotificationEnvelopeSchema =
	jsonRpcEnvelopeBaseSchema.and(zAgentNotification);

const acpClientRequestEnvelopeSchema =
	jsonRpcEnvelopeBaseSchema.and(zClientRequest);

const acpClientResponseEnvelopeSchema =
	jsonRpcEnvelopeBaseSchema.and(zClientResponse);

const acpClientNotificationEnvelopeSchema =
	jsonRpcEnvelopeBaseSchema.and(zClientNotification);

export const acpEnvelopeSchema = z.union([
	acpAgentRequestEnvelopeSchema,
	acpAgentResponseEnvelopeSchema,
	acpAgentNotificationEnvelopeSchema,
	acpClientRequestEnvelopeSchema,
	acpClientResponseEnvelopeSchema,
	acpClientNotificationEnvelopeSchema,
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
]);

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
