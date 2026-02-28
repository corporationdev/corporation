import { z } from "zod";

export const buildRequestSchema = z.object({
	type: z.enum(["build", "rebuild", "override"]),
	userId: z.string(),
	config: z.object({
		repository: z.object({
			owner: z.string(),
			name: z.string(),
			defaultBranch: z.string(),
		}),
		setupCommand: z.string(),
		envByPath: z.record(z.string(), z.record(z.string(), z.string())).nullish(),
	}),
	snapshotId: z.string().optional(),
	sandboxId: z.string().optional(),
	snapshotCommitSha: z.string().optional(),
});

export type BuildRequest = z.infer<typeof buildRequestSchema>;
