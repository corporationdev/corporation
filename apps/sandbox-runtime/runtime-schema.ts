import { z } from "zod";
import type {
	CreateSessionInput,
	RespondToPermissionRequestInput,
	StartTurnInput,
} from "./index";

export const promptPartSchema = z.object({
	type: z.literal("text"),
	text: z.string(),
});

export const sessionStaticConfigSchema = z.object({
	agent: z.string().min(1),
	cwd: z.string().min(1),
});

export const sessionDynamicConfigSchema = z.object({
	modelId: z.string().optional(),
	modeId: z.string().optional(),
	configOptions: z.record(z.string(), z.string()).optional(),
});

export const createSessionInputSchema = z.object({
	sessionId: z.string().min(1),
	staticConfig: sessionStaticConfigSchema,
	dynamicConfig: sessionDynamicConfigSchema,
}) satisfies z.ZodType<CreateSessionInput>;

export const startTurnInputSchema = z.object({
	sessionId: z.string().min(1),
	prompt: z.array(promptPartSchema),
	dynamicConfig: sessionDynamicConfigSchema.optional(),
}) satisfies z.ZodType<StartTurnInput>;

export const cancelTurnInputSchema = z.object({
	turnId: z.string().min(1),
});
export type CancelTurnInput = z.infer<typeof cancelTurnInputSchema>;

export const respondToPermissionRequestInputSchema = z.object({
	requestId: z.string().min(1),
	outcome: z.union([
		z.object({
			outcome: z.literal("selected"),
			optionId: z.string().min(1),
		}),
		z.object({
			outcome: z.literal("cancelled"),
		}),
	]),
}) satisfies z.ZodType<RespondToPermissionRequestInput>;

export const getSessionInputSchema = z.object({
	sessionId: z.string().min(1),
});
export type GetSessionInput = z.infer<typeof getSessionInputSchema>;

export const getTurnInputSchema = z.object({
	turnId: z.string().min(1),
});
export type GetTurnInput = z.infer<typeof getTurnInputSchema>;
