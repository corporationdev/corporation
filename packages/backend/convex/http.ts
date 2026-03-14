import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";

const http = httpRouter();

authComponent.registerRoutes(http, createAuth, { cors: true });

function verifyInternalApiKey(request: Request): boolean {
	const key = request.headers.get("authorization")?.replace("Bearer ", "");
	const expected = process.env.INTERNAL_API_KEY;
	if (!expected) {
		throw new Error("INTERNAL_API_KEY not configured");
	}
	return key === expected;
}

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
	path: "/environments/connect",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		if (!verifyInternalApiKey(request)) {
			return new Response("Unauthorized", { status: 401 });
		}

		const body = (await request.json().catch(() => null)) as Record<
			string,
			unknown
		> | null;
		if (!body) {
			return new Response("Invalid request body", { status: 400 });
		}

		const { userId, connectionId, name, metadata } = body;
		if (
			typeof userId !== "string" ||
			typeof connectionId !== "string" ||
			typeof name !== "string"
		) {
			return new Response("Missing required fields", { status: 400 });
		}

		try {
			const environmentId = await ctx.runMutation(
				internal.environments.connect,
				{
					userId,
					connectionId,
					name,
					metadata:
						metadata && typeof metadata === "object"
							? (metadata as Record<string, unknown>)
							: undefined,
				}
			);
			return Response.json({ environmentId });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Internal error";
			return new Response(message, { status: 500 });
		}
	}),
});

http.route({
	path: "/environments/disconnect",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		if (!verifyInternalApiKey(request)) {
			return new Response("Unauthorized", { status: 401 });
		}

		const body = (await request.json().catch(() => null)) as Record<
			string,
			unknown
		> | null;
		if (!body) {
			return new Response("Invalid request body", { status: 400 });
		}

		const { userId, connectionId } = body;
		if (typeof userId !== "string" || typeof connectionId !== "string") {
			return new Response("Missing required fields", { status: 400 });
		}

		try {
			await ctx.runMutation(internal.environments.disconnect, {
				connectionId,
				userId,
			});
			return new Response("OK", { status: 200 });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Internal error";
			return new Response(message, { status: 500 });
		}
	}),
});

export default http;
