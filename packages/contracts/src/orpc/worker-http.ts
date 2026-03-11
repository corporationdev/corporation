import { oc } from "@orpc/contract";
import { z } from "zod";
import { sessionStreamStateSchema } from "../browser-do";
import {
	runtimeAuthSessionRequestSchema,
	runtimeAuthSessionResponseSchema,
} from "../runtime-auth";

export const githubRepositorySchema = z.object({
	id: z.number().int(),
	name: z.string(),
	fullName: z.string(),
	owner: z.string(),
	defaultBranch: z.string(),
	private: z.boolean(),
	url: z.string(),
});
export type GitHubRepository = z.infer<typeof githubRepositorySchema>;

export const githubListReposOutputSchema = z.object({
	repositories: z.array(githubRepositorySchema),
});
export type GitHubListReposOutput = z.infer<typeof githubListReposOutputSchema>;

export const integrationConnectionSchema = z.object({
	connection_id: z.string(),
	provider: z.string(),
	created: z.string(),
	end_user: z
		.object({
			email: z.string().nullable(),
			display_name: z.string().nullable(),
		})
		.nullable(),
});
export type IntegrationConnection = z.infer<typeof integrationConnectionSchema>;

export const integrationSchema = z.object({
	unique_key: z.string(),
	provider: z.string(),
	logo: z.string().optional(),
	connection: integrationConnectionSchema.nullable(),
});
export type Integration = z.infer<typeof integrationSchema>;

export const listIntegrationsOutputSchema = z.object({
	integrations: z.array(integrationSchema),
});
export type ListIntegrationsOutput = z.infer<
	typeof listIntegrationsOutputSchema
>;

export const getIntegrationConnectionInputSchema = z.object({
	uniqueKey: z.string().min(1),
});
export type GetIntegrationConnectionInput = z.infer<
	typeof getIntegrationConnectionInputSchema
>;

export const getIntegrationConnectionOutputSchema = z.object({
	connection: integrationConnectionSchema.nullable(),
});
export type GetIntegrationConnectionOutput = z.infer<
	typeof getIntegrationConnectionOutputSchema
>;

export const createIntegrationConnectSessionInputSchema = z.object({
	allowedIntegrations: z.array(z.string().min(1)).optional(),
});
export type CreateIntegrationConnectSessionInput = z.infer<
	typeof createIntegrationConnectSessionInputSchema
>;

export const createIntegrationConnectSessionOutputSchema = z.object({
	token: z.string(),
	connect_link: z.string().optional(),
	expires_at: z.string(),
});
export type CreateIntegrationConnectSessionOutput = z.infer<
	typeof createIntegrationConnectSessionOutputSchema
>;

export const disconnectIntegrationInputSchema = z.object({
	connectionId: z.string().min(1),
	providerConfigKey: z.string().min(1),
});
export type DisconnectIntegrationInput = z.infer<
	typeof disconnectIntegrationInputSchema
>;

export const disconnectIntegrationOutputSchema = z.object({
	success: z.boolean(),
});
export type DisconnectIntegrationOutput = z.infer<
	typeof disconnectIntegrationOutputSchema
>;

export const getSessionStreamStateInputSchema = z.object({
	spaceSlug: z.string().min(1),
	sessionId: z.string().min(1),
});
export type GetSessionStreamStateInput = z.infer<
	typeof getSessionStreamStateInputSchema
>;

export const createRuntimeAuthSessionInputSchema =
	runtimeAuthSessionRequestSchema.extend({
		spaceSlug: z.string().min(1),
	});
export type CreateRuntimeAuthSessionInput = z.infer<
	typeof createRuntimeAuthSessionInputSchema
>;

export const workerHttpContract = {
	github: {
		listRepos: oc.output(githubListReposOutputSchema),
	},
	integrations: {
		list: oc.output(listIntegrationsOutputSchema),
		getConnection: oc
			.input(getIntegrationConnectionInputSchema)
			.output(getIntegrationConnectionOutputSchema),
		connect: oc
			.input(createIntegrationConnectSessionInputSchema)
			.output(createIntegrationConnectSessionOutputSchema),
		disconnect: oc
			.input(disconnectIntegrationInputSchema)
			.output(disconnectIntegrationOutputSchema),
	},
	spaces: {
		getSessionStreamState: oc
			.input(getSessionStreamStateInputSchema)
			.output(sessionStreamStateSchema),
	},
	runtimeAuth: {
		createSession: oc
			.input(createRuntimeAuthSessionInputSchema)
			.output(runtimeAuthSessionResponseSchema),
	},
};
