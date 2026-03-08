"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { deriveUserKey, encrypt } from "./lib/crypto";

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

		const userKey = await deriveUserKey(masterKey, args.userId);
		const { ciphertext, iv } = await encrypt(userKey, args.apiKey);
		const hint =
			args.apiKey.length <= 4 ? "****" : `...${args.apiKey.slice(-4)}`;

		await ctx.runMutation(internal.apiKeys.upsertInternal, {
			userId: args.userId,
			name: args.name,
			encryptedKey: ciphertext,
			iv,
			hint,
		});
	},
});
