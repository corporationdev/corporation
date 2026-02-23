"use node";

import { v } from "convex/values";
import { Webhook } from "svix";
import { z } from "zod";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const daytonaWebhookPayloadSchema = z
	.object({
		event: z.string(),
		id: z.string(),
		newState: z.string(),
	})
	.passthrough();

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
		let verifiedPayload: unknown;
		try {
			verifiedPayload = wh.verify(args.body, {
				"svix-id": args.svixId,
				"svix-timestamp": args.svixTimestamp,
				"svix-signature": args.svixSignature,
			});
		} catch {
			return { status: "invalid" as const };
		}

		const parsedPayload =
			daytonaWebhookPayloadSchema.safeParse(verifiedPayload);
		if (!parsedPayload.success) {
			return { status: "invalid" as const };
		}

		const { event, id, newState } = parsedPayload.data;

		if (
			event === "sandbox.state.updated" &&
			(newState === "stopped" || newState === "archived")
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

		return { status: "ok" as const };
	},
});
