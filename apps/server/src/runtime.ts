import {
	runtimeAuthSessionRequestSchema,
	runtimeRefreshTokenRequestSchema,
	verifyRuntimeAccessToken,
} from "@corporation/contracts/runtime-auth";
import { Hono } from "hono";
import { verifyAuthToken } from "./auth";
import {
	createRuntimeForwardHeaders,
	type EnvironmentStubBinding,
	getEnvironmentStub,
} from "./environment-do/stub";
import {
	createRuntimeAuthSession,
	createRuntimeRefreshToken,
} from "./services/runtime-auth";

type RuntimeAppEnv = {
	Bindings: {
		CORPORATION_CONVEX_SITE_URL: string;
		CORPORATION_RUNTIME_AUTH_SECRET?: string;
		CORPORATION_SERVER_URL?: string;
		CORPORATION_WEB_URL?: string;
		ENVIRONMENT_DO: EnvironmentStubBinding;
	};
};

function isLoopbackCallbackUrl(value: string): boolean {
	try {
		const url = new URL(value);
		if (url.protocol !== "http:") {
			return false;
		}
		return (
			url.hostname === "127.0.0.1" ||
			url.hostname === "localhost" ||
			url.hostname === "[::1]" ||
			url.hostname === "::1"
		);
	} catch {
		return false;
	}
}

export const runtimeApp = new Hono<RuntimeAppEnv>()
	.get("/login", async (c) => {
		const callbackUrl = c.req.query("callbackUrl")?.trim();
		const clientId = c.req.query("clientId")?.trim();
		const state = c.req.query("state")?.trim();
		if (!(callbackUrl && clientId && state)) {
			return c.text("Missing login parameters", 400);
		}
		if (!isLoopbackCallbackUrl(callbackUrl)) {
			return c.text("Invalid callback URL", 400);
		}

		const webUrl = c.env.CORPORATION_WEB_URL?.trim();
		if (!webUrl) {
			return c.text("Runtime login is not configured", 500);
		}

		const redirectUrl = new URL("/runtime-login", webUrl);
		redirectUrl.search = new URLSearchParams({
			callbackUrl,
			clientId,
			state,
		}).toString();
		return c.redirect(redirectUrl.toString(), 302);
	})
	.post("/auth/refresh-token", async (c) => {
		const authHeader = c.req.header("authorization");
		if (!authHeader?.startsWith("Bearer ")) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		const token = authHeader.slice("Bearer ".length).trim();
		const jwtPayload = await verifyAuthToken(
			token,
			c.env.CORPORATION_CONVEX_SITE_URL
		);
		if (!jwtPayload) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		const body = runtimeRefreshTokenRequestSchema.safeParse(
			await c.req.json().catch(() => null)
		);
		if (!body.success) {
			return c.json({ error: body.error.message }, 400);
		}

		try {
			return c.json(
				await createRuntimeRefreshToken(c.env, {
					clientId: body.data.clientId,
					userId: jwtPayload.sub,
				})
			);
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: "Failed to create refresh token";
			return c.json({ error: message }, 500);
		}
	})
	.post("/auth/session", async (c) => {
		const body = runtimeAuthSessionRequestSchema.safeParse(
			await c.req.json().catch(() => null)
		);
		if (!body.success) {
			return c.json({ error: body.error.message }, 400);
		}
		try {
			return c.json(
				await createRuntimeAuthSession(c.env, c.req.url, {
					refreshToken: body.data.refreshToken,
				})
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Runtime auth failed";
			return c.json({ error: message }, message === "Unauthorized" ? 401 : 500);
		}
	})
	.get("/socket", async (c) => {
		const token = c.req.query("token")?.trim();
		const secret = c.env.CORPORATION_RUNTIME_AUTH_SECRET?.trim();
		if (!(token && secret)) {
			return c.text("Unauthorized", 401);
		}

		const claims = await verifyRuntimeAccessToken(token, secret);
		if (!claims) {
			return c.text("Unauthorized", 401);
		}

		const headers = createRuntimeForwardHeaders({
			authToken: token,
			claims,
			headers: c.req.raw.headers,
		});

		return await getEnvironmentStub(c.env.ENVIRONMENT_DO, claims.sub).fetch(
			new Request("http://environment/runtime/socket", {
				method: c.req.raw.method,
				headers,
			})
		);
	});
