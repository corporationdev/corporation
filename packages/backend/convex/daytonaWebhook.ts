"use node";

import { v } from "convex/values";
import { Webhook } from "svix";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

export const handleWebhook = internalAction({
	args: {
		body: v.string(),
		svixId: v.string(),
		svixTimestamp: v.string(),
		svixSignature: v.string(),
	},
	handler: async (ctx, args) => {
		const secret = process.env.DAYTONA_WEBHOOK_SECRET;
		if (!secret) {
			throw new Error("Missing DAYTONA_WEBHOOK_SECRET env var");
		}

		const wh = new Webhook(secret);
		const payload = wh.verify(args.body, {
			"svix-id": args.svixId,
			"svix-timestamp": args.svixTimestamp,
			"svix-signature": args.svixSignature,
		}) as { event?: string; id?: string; state?: string };

		const { event, id, state } = payload;

		if (
			event === "sandbox.state.updated" &&
			id &&
			(state === "stopped" || state === "archived")
		) {
			const space = await ctx.runQuery(internal.spaces.getBySandboxId, {
				sandboxId: id,
			});

			if (space) {
				await ctx.runMutation(internal.spaces.internalUpdate, {
					id: space._id,
					status: "stopped",
				});
			}
		}
	},
});
