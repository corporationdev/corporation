import { httpRouter } from "convex/server";
import { z } from "zod";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";

const sandboxTimeoutSchema = z.object({
	sandboxId: z.string().min(1),
	expiresAt: z.number(),
});

const http = httpRouter();

authComponent.registerRoutes(http, createAuth, { cors: true });

http.route({
	path: "/webhooks/e2b",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		const signature = request.headers.get("e2b-signature");

		if (!signature) {
			return new Response("Missing signature header", { status: 400 });
		}

		const body = await request.text();

		try {
			const result = await ctx.runAction(internal.e2bWebhook.handleWebhook, {
				body,
				signature,
			});

			if (result.status === "invalid") {
				return new Response("Webhook verification failed", { status: 400 });
			}

			return new Response("OK", { status: 200 });
		} catch {
			return new Response("Internal webhook processing error", { status: 500 });
		}
	}),
});

http.route({
	path: "/webhooks/nango",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		const signature = request.headers.get("x-nango-hmac-sha256");

		if (!signature) {
			return new Response("Missing signature header", { status: 400 });
		}

		const body = await request.text();

		try {
			const result = await ctx.runAction(internal.nangoWebhook.handleWebhook, {
				body,
				signature,
			});

			if (result.status === "invalid") {
				return new Response("Webhook verification failed", { status: 400 });
			}

			return new Response("OK", { status: 200 });
		} catch {
			return new Response("Internal webhook processing error", { status: 500 });
		}
	}),
});

http.route({
	path: "/internal/sandbox-timeout",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		const internalApiKey = process.env.INTERNAL_API_KEY;
		if (!internalApiKey) {
			return new Response("Server misconfiguration", { status: 500 });
		}

		const authorization = request.headers.get("authorization");
		if (authorization !== `Bearer ${internalApiKey}`) {
			return new Response("Unauthorized", { status: 401 });
		}

		const parsed = sandboxTimeoutSchema.safeParse(await request.json());
		if (!parsed.success) {
			return new Response("Invalid body", { status: 400 });
		}

		const { sandboxId, expiresAt } = parsed.data;

		const space = await ctx.runQuery(internal.spaces.getBySandboxId, {
			sandboxId,
		});

		if (!space) {
			return new Response("Space not found", { status: 404 });
		}

		await ctx.runMutation(internal.spaces.internalUpdate, {
			id: space._id,
			sandboxExpiresAt: expiresAt,
		});

		return new Response("OK", { status: 200 });
	}),
});

export default http;
