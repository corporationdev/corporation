import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import { sessionRowSchema, terminalOutputPayloadSchema } from "../browser-do";
import { agentProbeResponseSchema } from "../sandbox-do";

export const sandboxBindingSchema = z
	.object({
		sandboxId: z.string().min(1),
	})
	.nullable();
export type SandboxBinding = z.infer<typeof sandboxBindingSchema>;

export const syncSandboxBindingInputSchema = z.object({
	binding: sandboxBindingSchema,
});

export const sendMessageInputSchema = z.object({
	sessionId: z.string().min(1),
	content: z.string().min(1),
	agent: z.string().min(1),
	modelId: z.string().min(1),
});

export const cancelSessionInputSchema = z.object({
	sessionId: z.string().min(1),
});

export const runCommandInputSchema = z.object({
	command: z.string().min(1),
	background: z.boolean().optional(),
});

export const inputTerminalInputSchema = z.object({
	data: z.array(z.number().int().gte(0).lte(255)),
});

export const resizeTerminalInputSchema = z.object({
	cols: z.number().int().positive(),
	rows: z.number().int().positive(),
});

export const browserSpaceContract = {
	syncSandboxBinding: oc
		.input(syncSandboxBindingInputSchema)
		.output(z.boolean()),
	listSessions: oc.output(z.array(sessionRowSchema)),
	sendMessage: oc.input(sendMessageInputSchema).output(z.null()),
	cancelSession: oc.input(cancelSessionInputSchema).output(z.null()),
	getAgentProbeState: oc.output(agentProbeResponseSchema),
	runCommand: oc.input(runCommandInputSchema).output(z.null()),
	input: oc.input(inputTerminalInputSchema).output(z.null()),
	resize: oc.input(resizeTerminalInputSchema).output(z.null()),
	getTerminalSnapshot: oc.output(z.boolean()),
	getDesktopStreamUrl: oc.output(z.string()),
	onSessionsChanged: oc.output(eventIterator(z.array(sessionRowSchema))),
	onTerminalOutput: oc.output(eventIterator(terminalOutputPayloadSchema)),
};
