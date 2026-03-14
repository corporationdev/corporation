"use node";

import { ConvexError, v } from "convex/values";
import { Sandbox } from "e2b";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import { authComponent, safeGetAuthSession } from "./auth";
import {
	collectAgentCredentialBundle,
	credentialEnabledAgentIds,
	getCredentialEnabledAgent,
} from "./lib/agentCredentialBundles";
import { deriveUserKey, encrypt } from "./lib/crypto";

function getMasterKey(): string {
	const masterKey = process.env.CORPORATION_API_KEY_MASTER_KEY;
	if (!masterKey) {
		throw new Error("Missing CORPORATION_API_KEY_MASTER_KEY env var");
	}
	return masterKey;
}

export const save = action({
	args: {
		agents: v.array(
			v.object({
				id: v.string(),
				configOptions: v.array(v.any()),
			})
		),
	},
	handler: async (ctx, args) => {
		const authUser = await authComponent.safeGetAuthUser(ctx);
		if (!authUser) {
			throw new ConvexError("Unauthenticated");
		}

		const authSession = await safeGetAuthSession(ctx);
		if (!authSession?.activeOrganizationId) {
			throw new ConvexError("No active organization");
		}

		const project = await ctx.runQuery(
			internal.projects.internalGetOrgBaseProject,
			{
				organizationId: authSession.activeOrganizationId,
			}
		);
		if (!project) {
			throw new ConvexError("Organization base project not found");
		}

		const space = await ctx.runQuery(
			internal.spaces.internalGetByUserAndProject,
			{
				userId: authUser._id,
				projectId: project._id,
			}
		);
		if (!space) {
			throw new ConvexError("Personal workspace not found");
		}
		// TODO: migrate to use environments table
		const sandboxId = (space as Record<string, unknown>).sandboxId as
			| string
			| undefined;
		if (!sandboxId) {
			throw new ConvexError("Sandbox is not running");
		}

		const supportedAgents = Array.from(
			new Map(
				args.agents
					.filter((agent) => credentialEnabledAgentIds.has(agent.id))
					.map((agent) => [agent.id, agent])
			).values()
		);

		await ctx.runMutation(internal.agentConfig.internalSaveProbeResults, {
			userId: authUser._id,
			spaceId: space._id,
			agents: supportedAgents,
		});

		const userKey = await deriveUserKey(getMasterKey(), authUser._id);
		const sandbox = await Sandbox.connect(sandboxId);
		const syncedAt = Date.now();

		for (const agent of supportedAgents) {
			const manifestAgent = getCredentialEnabledAgent(agent.id);
			if (!manifestAgent?.credentialBundle) {
				continue;
			}

			const bundle = await collectAgentCredentialBundle(sandbox, manifestAgent);
			const { ciphertext, iv } = await encrypt(userKey, JSON.stringify(bundle));

			await ctx.runMutation(internal.agentCredentials.upsertInternal, {
				userId: authUser._id,
				agentId: agent.id,
				encryptedBundle: ciphertext,
				iv,
				schemaVersion: bundle.schemaVersion,
				lastSyncedAt: syncedAt,
			});
		}

		for (const agentId of credentialEnabledAgentIds) {
			if (supportedAgents.some((agent) => agent.id === agentId)) {
				continue;
			}

			await ctx.runMutation(
				internal.agentCredentials.removeByUserAndAgentInternal,
				{
					userId: authUser._id,
					agentId,
				}
			);
		}

		return {
			savedAgentIds: supportedAgents.map((agent) => agent.id),
			syncedAt,
		};
	},
});
