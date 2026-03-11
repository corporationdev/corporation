import { oc } from "@orpc/contract";
import { z } from "zod";
import {
	runtimeClientTypeSchema,
	runtimeCommandRejectedMessageSchema,
	runtimeProbeResultMessageSchema,
	runtimeSessionEventBatchMessageSchema,
	runtimeSocketCapabilitiesSchema,
	runtimeTurnCompletedMessageSchema,
	runtimeTurnFailedMessageSchema,
} from "../sandbox-do";

export const runtimeRegisterInputSchema = z.object({
	spaceSlug: z.string().min(1),
	sandboxId: z.string().min(1),
	clientType: runtimeClientTypeSchema,
	protocolVersion: z.number().int().positive(),
	capabilities: runtimeSocketCapabilitiesSchema.optional(),
});
export type RuntimeRegisterInput = z.infer<typeof runtimeRegisterInputSchema>;

export const runtimeRegisterOutputSchema = z.object({
	connectionId: z.string().min(1),
	connectedAt: z.number().int().positive(),
});
export type RuntimeRegisterOutput = z.infer<typeof runtimeRegisterOutputSchema>;

export const runtimeIngressContract = {
	register: oc
		.input(runtimeRegisterInputSchema)
		.output(runtimeRegisterOutputSchema),
	pushSessionEventBatch: oc
		.input(runtimeSessionEventBatchMessageSchema)
		.output(z.null()),
	completeTurn: oc.input(runtimeTurnCompletedMessageSchema).output(z.null()),
	failTurn: oc.input(runtimeTurnFailedMessageSchema).output(z.null()),
	commandRejected: oc
		.input(runtimeCommandRejectedMessageSchema)
		.output(z.null()),
	probeResult: oc.input(runtimeProbeResultMessageSchema).output(z.null()),
};
