"use node";

import { v } from "convex/values";
import { z } from "zod";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const e2bWebhookPayloadSchema = z
	.object({
		type: z.string().optional(),
		event: z.string().optional(),
		state: z.string().optional(),
		sandboxId: z.string().optional(),
		sandboxID: z.string().optional(),
		id: z.string().optional(),
		data: z
			.object({
				type: z.string().optional(),
				state: z.string().optional(),
				sandboxId: z.string().optional(),
				sandboxID: z.string().optional(),
				id: z.string().optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();

function resolveEvent(payload: z.infer<typeof e2bWebhookPayloadSchema>): {
	eventType: string;
	state: string;
	sandboxId: string | undefined;
} {
	const data = payload.data;
	const eventType = (
		data?.type ??
		payload.type ??
		payload.event ??
		""
	).toLowerCase();
	const state = (data?.state ?? payload.state ?? "").toLowerCase();
	const sandboxId =
		data?.sandboxId ??
		data?.sandboxID ??
		data?.id ??
		payload.sandboxId ??
		payload.sandboxID ??
		payload.id;

	return { eventType, state, sandboxId };
}

function mapSpaceStatus(
	eventType: string,
	state: string
): "started" | "stopped" | null {
	const becameStopped =
		eventType.includes("paused") ||
		eventType.includes("killed") ||
		eventType.includes("expired") ||
		state === "paused";
	if (becameStopped) {
		return "stopped";
	}

	const becameStarted =
		eventType.includes("spawn") ||
		eventType.includes("resume") ||
		eventType.includes("running") ||
		state === "running";
	if (becameStarted) {
		return "started";
	}

	return null;
}

export const handleWebhook = internalAction({
	args: {
		body: v.string(),
	},
	handler: async (ctx, args) => {
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

		const { eventType, state, sandboxId } = resolveEvent(parsed.data);
		if (!sandboxId) {
			return { status: "ignored" as const };
		}

		const nextStatus = mapSpaceStatus(eventType, state);
		if (!nextStatus) {
			return { status: "ignored" as const };
		}

		const space = await ctx.runQuery(internal.spaces.getBySandboxId, {
			sandboxId,
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
