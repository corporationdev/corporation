"use node";

import {
	buildSecretHint,
	validateSecretName,
	validateSecretValue,
} from "@corporation/shared/secrets";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type ActionCtx, internalAction } from "./_generated/server";
import { decrypt, deriveUserKey, encrypt } from "./lib/crypto";

function getMasterKey(): string {
	const masterKey = process.env.API_KEY_MASTER_KEY;
	if (!masterKey) {
		throw new Error("Missing API_KEY_MASTER_KEY env var");
	}
	return masterKey;
}

function normalizeSecretRecord(
	secrets: Record<string, string>
): Record<string, string> {
	const normalized: Record<string, string> = {};
	for (const [rawName, value] of Object.entries(secrets)) {
		const name = rawName.trim();
		if (!name) {
			continue;
		}
		const nameError = validateSecretName(name);
		if (nameError) {
			throw new Error(nameError);
		}
		const valueError = validateSecretValue(value);
		if (valueError) {
			throw new Error(valueError);
		}
		normalized[name] = value;
	}
	return normalized;
}

async function syncProjectSecrets(
	ctx: ActionCtx,
	projectId: Id<"projects">,
	secrets: Record<string, string>
): Promise<void> {
	const project = await ctx.runQuery(internal.projects.internalGet, {
		id: projectId,
	});
	const normalizedSecrets = normalizeSecretRecord(secrets);
	const existingSecrets = await ctx.runQuery(internal.secrets.listByProject, {
		projectId: project._id,
	});
	const nextNames = new Set(Object.keys(normalizedSecrets));
	const userKey =
		nextNames.size > 0
			? await deriveUserKey(getMasterKey(), project.userId)
			: null;

	for (const [name, value] of Object.entries(normalizedSecrets)) {
		if (!userKey) {
			throw new Error("Missing encryption key for project secrets");
		}
		const { ciphertext, iv } = await encrypt(userKey, value);
		await ctx.runMutation(internal.secrets.upsertInternal, {
			projectId: project._id,
			userId: project.userId,
			name,
			encryptedValue: ciphertext,
			iv,
			hint: buildSecretHint(value),
		});
	}

	for (const secret of existingSecrets) {
		if (!nextNames.has(secret.name)) {
			await ctx.runMutation(internal.secrets.removeByProjectAndNameInternal, {
				projectId: project._id,
				name: secret.name,
			});
		}
	}
}

export const syncProjectSecretsAndScheduleInitialSnapshot = internalAction({
	args: {
		projectId: v.id("projects"),
		secrets: v.record(v.string(), v.string()),
	},
	handler: async (ctx, args) => {
		await syncProjectSecrets(ctx, args.projectId, args.secrets);
		// await ctx.runMutation(internal.snapshot.scheduleInitialSnapshotInternal, {
		// 	projectId: args.projectId,
		// 	setAsDefault: true,
		// });
	},
});

export const syncProjectSecretsAndScheduleRebuild = internalAction({
	args: {
		projectId: v.id("projects"),
		upserts: v.record(v.string(), v.string()),
		removeNames: v.array(v.string()),
	},
	handler: async (ctx, args) => {
		const existingSecrets = await ctx.runAction(
			internal.secretActions.resolveProjectSecrets,
			{
				projectId: args.projectId,
			}
		);
		for (const name of args.removeNames) {
			delete existingSecrets[name];
		}
		await syncProjectSecrets(ctx, args.projectId, {
			...existingSecrets,
			...args.upserts,
		});
		// await ctx.runMutation(
		// 	internal.snapshot.scheduleRebuildWithSecretsInternal,
		// 	{
		// 		projectId: args.projectId,
		// 	}
		// );
	},
});

export const resolveProjectSecrets = internalAction({
	args: {
		projectId: v.id("projects"),
	},
	handler: async (ctx, args) => {
		const project = await ctx.runQuery(internal.projects.internalGet, {
			id: args.projectId,
		});
		const rows = await ctx.runQuery(internal.secrets.listByProject, {
			projectId: args.projectId,
		});
		const secretMap: Record<string, string> = {};
		if (rows.length === 0) {
			return secretMap;
		}
		const userKey = await deriveUserKey(getMasterKey(), project.userId);

		for (const row of rows) {
			secretMap[row.name] = await decrypt(userKey, row.encryptedValue, row.iv);
		}

		return secretMap;
	},
});
