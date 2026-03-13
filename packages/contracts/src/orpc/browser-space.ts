import { eventIterator, oc, type Schema } from "@orpc/contract";
import { z } from "zod";
import { sessionRowSchema, terminalOutputPayloadSchema } from "../browser-do";
import {
	agentProbeRequestBodySchema,
	agentProbeResponseSchema,
} from "../sandbox-do";

function hibernatingEventIterator<
	TYieldIn,
	TYieldOut,
	TReturnIn = unknown,
	TReturnOut = unknown,
>(
	yields: Schema<TYieldIn, TYieldOut>,
	returns?: Schema<TReturnIn, TReturnOut>
) {
	const schema = eventIterator(yields, returns);

	return {
		...schema,
		"~standard": {
			...schema["~standard"],
			validate(iterator: unknown) {
				if (
					typeof iterator === "object" &&
					iterator !== null &&
					"hibernationCallback" in iterator &&
					typeof iterator.hibernationCallback === "function"
				) {
					return {
						value: iterator,
					};
				}

				return schema["~standard"].validate(iterator);
			},
		},
	} as typeof schema;
}

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

export const createSessionInputSchema = z.object({
	sessionId: z.string().min(1),
	environmentId: z.string().min(1),
	spaceName: z.string().min(1),
	title: z.string().optional(),
	agent: z.string().min(1),
	cwd: z.string().min(1),
	model: z.string().optional(),
	mode: z.string().optional(),
	configOptions: z.record(z.string(), z.string()).optional(),
});
export type CreateSessionInput = z.infer<typeof createSessionInputSchema>;

export const spaceSessionSyncStatusSchema = z.enum([
	"pending",
	"live",
	"error",
]);
export type SpaceSessionSyncStatus = z.infer<
	typeof spaceSessionSyncStatusSchema
>;

export const spaceSessionRowSchema = z.object({
	id: z.string().min(1),
	environmentId: z.string().min(1),
	streamKey: z.string().min(1),
	title: z.string().min(1),
	agent: z.string().min(1),
	cwd: z.string().min(1),
	model: z.string().nullable(),
	mode: z.string().nullable(),
	configOptions: z.record(z.string(), z.string()).nullable(),
	syncStatus: spaceSessionSyncStatusSchema,
	lastAppliedOffset: z.string().min(1),
	lastEventAt: z.number().int().nullable(),
	lastSyncError: z.string().nullable(),
	createdAt: z.number().int(),
	updatedAt: z.number().int(),
	archivedAt: z.number().int().nullable(),
});
export type SpaceSessionRow = z.infer<typeof spaceSessionRowSchema>;

export const createSessionResultSchema = z.union([
	z.object({
		ok: z.literal(true),
		value: z.object({
			session: spaceSessionRowSchema,
		}),
	}),
	z.object({
		ok: z.literal(false),
		error: z.object({
			message: z.string().min(1),
		}),
	}),
]);
export type CreateSessionResult = z.infer<typeof createSessionResultSchema>;

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
	probeAgents: oc
		.input(agentProbeRequestBodySchema)
		.output(agentProbeResponseSchema),
	runCommand: oc.input(runCommandInputSchema).output(z.null()),
	input: oc.input(inputTerminalInputSchema).output(z.null()),
	resize: oc.input(resizeTerminalInputSchema).output(z.null()),
	getTerminalSnapshot: oc.output(z.boolean()),
	getDesktopStreamUrl: oc.output(z.string()),
	onSessionsChanged: oc.output(
		hibernatingEventIterator(z.array(sessionRowSchema))
	),
	onTerminalOutput: oc.output(
		hibernatingEventIterator(terminalOutputPayloadSchema)
	),
};
