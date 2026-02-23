import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";

const http = httpRouter();

authComponent.registerRoutes(http, createAuth, { cors: true });

http.route({
	path: "/webhooks/daytona",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		const svixId = request.headers.get("svix-id");
		const svixTimestamp = request.headers.get("svix-timestamp");
		const svixSignature = request.headers.get("svix-signature");

		if (!(svixId && svixTimestamp && svixSignature)) {
			return new Response("Missing svix headers", { status: 400 });
		}

		const body = await request.text();

		try {
			const result = await ctx.runAction(
				internal.daytonaWebhook.handleWebhook,
				{
					body,
					svixId,
					svixTimestamp,
					svixSignature,
				}
			);

			if (result.status === "invalid") {
				return new Response("Webhook verification failed", { status: 400 });
			}

			return new Response("OK", { status: 200 });
		} catch {
			return new Response("Internal webhook processing error", { status: 500 });
		}
	}),
});

export default http;
