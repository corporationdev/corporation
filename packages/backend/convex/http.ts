import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";

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
	path: "/environments/connect",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		const apiKey = request.headers.get("authorization")?.replace("Bearer ", "");
		if (!apiKey) {
			return new Response("Unauthorized", { status: 401 });
		}

		const body = (await request.json().catch(() => null)) as Record<
			string,
			unknown
		> | null;
		if (!body) {
			return new Response("Invalid request body", { status: 400 });
		}

		try {
			const environmentId = await ctx.runAction(
				internal.environments.connectAction,
				{
					apiKey,
					userId: body.userId as string,
					clientId: body.clientId as string,
					name: body.name as string,
				}
			);
			return Response.json({ environmentId });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Internal error";
			if (message === "Unauthorized") {
				return new Response("Unauthorized", { status: 401 });
			}
			return new Response(message, { status: 500 });
		}
	}),
});

http.route({
	path: "/environments/disconnect",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		const apiKey = request.headers.get("authorization")?.replace("Bearer ", "");
		if (!apiKey) {
			return new Response("Unauthorized", { status: 401 });
		}

		const body = (await request.json().catch(() => null)) as Record<
			string,
			unknown
		> | null;
		if (!body) {
			return new Response("Invalid request body", { status: 400 });
		}

		try {
			await ctx.runAction(internal.environments.disconnectAction, {
				apiKey,
				userId: body.userId as string,
				clientId: body.clientId as string,
			});
			return new Response("OK", { status: 200 });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Internal error";
			if (message === "Unauthorized") {
				return new Response("Unauthorized", { status: 401 });
			}
			return new Response(message, { status: 500 });
		}
	}),
});

export default http;
