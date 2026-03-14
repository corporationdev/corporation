import { z } from "zod";
import {
	environmentPromptPartSchema,
	environmentRespondToPermissionInputSchema,
} from "./environment-runtime";

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

export const getSessionInputSchema = z.object({
	sessionId: z.string().min(1),
});
export type GetSessionInput = z.infer<typeof getSessionInputSchema>;

export const promptSessionInputSchema = z.object({
	sessionId: z.string().min(1),
	prompt: z.array(environmentPromptPartSchema),
	model: z.string().optional(),
	mode: z.string().optional(),
	configOptions: z.record(z.string(), z.string()).optional(),
});
export type PromptSessionInput = z.infer<typeof promptSessionInputSchema>;

export const abortSessionInputSchema = z.object({
	sessionId: z.string().min(1),
});
export type AbortSessionInput = z.infer<typeof abortSessionInputSchema>;

export const respondToPermissionInputSchema = z.object({
	sessionId: z.string().min(1),
	requestId: environmentRespondToPermissionInputSchema.shape.requestId,
	outcome: environmentRespondToPermissionInputSchema.shape.outcome,
});
export type RespondToPermissionInput = z.infer<
	typeof respondToPermissionInputSchema
>;
