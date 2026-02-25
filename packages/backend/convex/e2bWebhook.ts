"use node";

import { createHash } from "node:crypto";
import { v } from "convex/values";
import { z } from "zod";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const e2bEventType = z.enum([
	"sandbox.lifecycle.created",
	"sandbox.lifecycle.killed",
	"sandbox.lifecycle.paused",
	"sandbox.lifecycle.resumed",
]);

type E2BEventType = z.infer<typeof e2bEventType>;

const e2bWebhookPayloadSchema = z.object({
	version: z.string(),
	id: z.string(),
	type: e2bEventType,
	eventData: z.object({
		sandbox_metadata: z.record(z.string(), z.string()).optional(),
	}),
	sandboxBuildId: z.string(),
	sandboxExecutionId: z.string(),
	sandboxId: z.string(),
	sandboxTeamId: z.string(),
	sandboxTemplateId: z.string(),
	timestamp: z.string(),
});

const TRAILING_EQUALS = /=+$/;

function verifySignature(
	secret: string,
	payload: string,
	signature: string
): boolean {
	const expectedRaw = createHash("sha256")
		.update(secret + payload)
		.digest("base64");
	const expected = expectedRaw.replace(TRAILING_EQUALS, "");
	return expected === signature;
}

const eventToStatus: Record<
	E2BEventType,
	"creating" | "running" | "paused" | "killed" | null
> = {
	"sandbox.lifecycle.created": "running",
	"sandbox.lifecycle.resumed": "running",
	"sandbox.lifecycle.paused": "paused",
	"sandbox.lifecycle.killed": "killed",
};

export const handleWebhook = internalAction({
	args: {
		body: v.string(),
		signature: v.string(),
	},
	handler: async (ctx, args) => {
		const e2bWebhookSecret = process.env.E2B_WEBHOOK_SECRET;
		if (!e2bWebhookSecret) {
			throw new Error("Missing E2B_WEBHOOK_SECRET env var");
		}

		if (!verifySignature(e2bWebhookSecret, args.body, args.signature)) {
			return { status: "invalid" as const };
		}

		let payload: unknown;
		try {
			payload = JSON.parse(args.body);
		} catch {
			return { status: "invalid" as const };
		}

		const parsed = e2bWebhookPayloadSchema.safeParse(payload);
		if (!parsed.success) {
			return { status: "invalid" as const };
		}

		const nextStatus = eventToStatus[parsed.data.type];
		if (!nextStatus) {
			return { status: "ignored" as const };
		}

		const space = await ctx.runQuery(internal.spaces.getBySandboxId, {
			sandboxId: parsed.data.sandboxId,
		});

		if (!space) {
			return { status: "ignored" as const };
		}

		await ctx.runMutation(internal.spaces.internalUpdate, {
			id: space._id,
			status: nextStatus,
		});

		return { status: "ok" as const };
	},
});
