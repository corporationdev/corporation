import {
	runtimeAccessTokenExchangeRequestSchema,
	runtimeApiKeyExchangeRequestSchema,
	runtimeAuthSessionRequestSchema,
	runtimeRefreshTokenResponseSchema,
} from "@tendril/contracts/runtime-auth";
import { Hono } from "hono";
import {
	createRuntimeAuthSession,
	createRuntimeRefreshToken,
} from "./services/runtime-auth";

type RuntimeAuthAppEnv = {
	Bindings: {
		CONVEX_SITE_URL: string;
		RUNTIME_AUTH_SECRET?: string;
		SERVER_URL?: string;
	};
};

type BetterAuthSessionResponse = {
	user: {
		id: string;
	};
} | null;

function buildBetterAuthUrl(convexSiteUrl: string, pathname: string): string {
	return new URL(`/api/auth${pathname}`, convexSiteUrl).toString();
}

async function fetchBetterAuthSession(input: {
	accessToken: string;
	convexSiteUrl: string;
}): Promise<BetterAuthSessionResponse> {
	const response = await fetch(
		buildBetterAuthUrl(input.convexSiteUrl, "/get-session"),
		{
			method: "GET",
			headers: {
				Authorization: `Bearer ${input.accessToken}`,
			},
		}
	);
	if (!response.ok) {
		return null;
	}
	return (await response.json().catch(() => null)) as BetterAuthSessionResponse;
}

async function fetchBetterAuthSessionFromApiKey(input: {
	apiKey: string;
	convexSiteUrl: string;
}): Promise<BetterAuthSessionResponse> {
	const response = await fetch(
		buildBetterAuthUrl(input.convexSiteUrl, "/get-session"),
		{
			method: "GET",
			headers: {
				"x-api-key": input.apiKey,
			},
		}
	);
	if (!response.ok) {
		return null;
	}
	return (await response.json().catch(() => null)) as BetterAuthSessionResponse;
}

export const runtimeAuthApp = new Hono<RuntimeAuthAppEnv>()
	.post("/access-token", async (c) => {
		const body = runtimeAccessTokenExchangeRequestSchema.safeParse(
			await c.req.json().catch(() => null)
		);
		if (!body.success) {
			return c.json({ error: body.error.message }, 400);
		}

		try {
			const session = await fetchBetterAuthSession({
				accessToken: body.data.accessToken,
				convexSiteUrl: c.env.CONVEX_SITE_URL,
			});
			const userId = session?.user?.id;
			if (!userId) {
				return c.json({ error: "Unauthorized" }, 401);
			}

			return c.json(
				runtimeRefreshTokenResponseSchema.parse(
					await createRuntimeRefreshToken(c.env, {
						clientId: body.data.clientId,
						userId,
					})
				)
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Runtime auth failed";
			return c.json({ error: message }, 500);
		}
	})
	.post("/api-key", async (c) => {
		const body = runtimeApiKeyExchangeRequestSchema.safeParse(
			await c.req.json().catch(() => null)
		);
		if (!body.success) {
			return c.json({ error: body.error.message }, 400);
		}

		try {
			const session = await fetchBetterAuthSessionFromApiKey({
				apiKey: body.data.apiKey,
				convexSiteUrl: c.env.CONVEX_SITE_URL,
			});
			const userId = session?.user?.id;
			if (!userId) {
				return c.json({ error: "Unauthorized" }, 401);
			}
			return c.json(
				runtimeRefreshTokenResponseSchema.parse(
					await createRuntimeRefreshToken(c.env, {
						clientId: body.data.clientId,
						userId,
					})
				)
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Runtime auth failed";
			return c.json({ error: message }, 500);
		}
	})
	.post("/session", async (c) => {
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
	});
