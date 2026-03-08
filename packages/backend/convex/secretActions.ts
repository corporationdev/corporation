"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import {
	buildClaudeCodeOauthHint,
	CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME,
	normalizeClaudeCodeOauthToken,
} from "./lib/claudeCodeAuth";
import {
	buildCodexAuthHint,
	CODEX_AUTH_SECRET_NAME,
	parseCodexAuthJson,
} from "./lib/codexAuth";
import { decrypt, deriveUserKey, encrypt } from "./lib/crypto";

export const encryptAndStore = internalAction({
	args: {
		userId: v.string(),
		name: v.string(),
		apiKey: v.string(),
	},
	handler: async (ctx, args) => {
		const masterKey = process.env.API_KEY_MASTER_KEY;
		if (!masterKey) {
			throw new Error("Missing API_KEY_MASTER_KEY env var");
		}

		const secretValue =
			args.name === CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME
				? normalizeClaudeCodeOauthToken(args.apiKey)
				: args.apiKey;
		const userKey = await deriveUserKey(masterKey, args.userId);
		const { ciphertext, iv } = await encrypt(userKey, secretValue);
		const hint =
			args.name === CODEX_AUTH_SECRET_NAME
				? (() => {
						const { email, accountId, planType } =
							parseCodexAuthJson(secretValue);
						return buildCodexAuthHint({ email, accountId, planType });
					})()
				: args.name === CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME
					? buildClaudeCodeOauthHint(secretValue)
					: secretValue.length <= 4
						? "****"
						: `...${secretValue.slice(-4)}`;

		await ctx.runMutation(internal.secrets.upsertInternal, {
			userId: args.userId,
			name: args.name,
			encryptedKey: ciphertext,
			iv,
			hint,
		});
	},
});

export const decryptSecretValues = internalAction({
	args: {
		userId: v.string(),
		secrets: v.array(
			v.object({
				name: v.optional(v.string()),
				encryptedKey: v.string(),
				iv: v.string(),
			})
		),
	},
	handler: async (_ctx, args) => {
		const masterKey = process.env.API_KEY_MASTER_KEY;
		if (!masterKey) {
			throw new Error("Missing API_KEY_MASTER_KEY env var");
		}

		const userKey = await deriveUserKey(masterKey, args.userId);
		return await Promise.all(
			args.secrets.map(async (secret) => ({
				name: secret.name ?? null,
				value: await decrypt(userKey, secret.encryptedKey, secret.iv),
			}))
		);
	},
});
