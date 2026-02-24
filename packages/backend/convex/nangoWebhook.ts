"use node";

import { createHmac } from "node:crypto";
import { v } from "convex/values";
import { z } from "zod";
import { internalAction } from "./_generated/server";

const forwardedWebhookSchema = z.object({
	from: z.string(),
	type: z.literal("forward"),
	connectionId: z.string(),
	providerConfigKey: z.string(),
	payload: z.unknown(),
});

const nangoWebhookSchema = z.discriminatedUnion("type", [
	forwardedWebhookSchema,
	z.object({ type: z.literal("sync"), from: z.string() }).passthrough(),
	z.object({ type: z.literal("auth"), from: z.string() }).passthrough(),
]);

function verifySignature(
	body: string,
	signature: string,
	secretKey: string
): boolean {
	const expected = createHmac("sha256", secretKey).update(body).digest("hex");
	return expected === signature;
}

// GitHub webhook handling removed — snapshots now rebuild on a schedule.
// Retained for future provider integrations via Nango forwarded webhooks.
function handleForwardedWebhook(
	_webhook: z.infer<typeof forwardedWebhookSchema>
) {
	// no-op
}

export const handleWebhook = internalAction({
	args: {
		body: v.string(),
		signature: v.string(),
	},
	handler: (_ctx, args) => {
		const nangoSecretKey = process.env.NANGO_SECRET_KEY;
		if (!nangoSecretKey) {
			throw new Error("Missing NANGO_SECRET_KEY env var");
		}

		if (!verifySignature(args.body, args.signature, nangoSecretKey)) {
			return { status: "invalid" as const };
		}

		const parsed = nangoWebhookSchema.safeParse(JSON.parse(args.body));
		if (!parsed.success) {
			return { status: "ok" as const };
		}

		const webhook = parsed.data;

		if (webhook.type === "forward") {
			handleForwardedWebhook(webhook);
		}

		return { status: "ok" as const };
	},
});
