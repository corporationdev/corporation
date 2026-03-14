import { z } from "zod";
import type {
	CreateSessionInput,
	PromptInput,
	RespondToPermissionRequestInput,
} from "./index";

export const promptPartSchema = z.object({
	type: z.literal("text"),
	text: z.string(),
});

export const createSessionInputSchema = z.object({
	sessionId: z.string().min(1),
	agent: z.string().min(1),
	cwd: z.string().min(1),
	model: z.string().optional(),
	mode: z.string().optional(),
	configOptions: z.record(z.string(), z.string()).optional(),
}) satisfies z.ZodType<CreateSessionInput>;

export const promptInputSchema = z.object({
	sessionId: z.string().min(1),
	prompt: z.array(promptPartSchema),
	model: z.string().optional(),
	mode: z.string().optional(),
	configOptions: z.record(z.string(), z.string()).optional(),
}) satisfies z.ZodType<PromptInput>;

export const abortInputSchema = z.object({
	sessionId: z.string().min(1),
});
export type AbortInput = z.infer<typeof abortInputSchema>;

export const respondToPermissionInputSchema = z.object({
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
