import {
	verifyRuntimeAccessToken,
} from "@corporation/contracts/runtime-auth";
import { runtimeAuthSessionRequestSchema } from "@corporation/contracts/runtime-auth";
import { Hono } from "hono";
import { createRuntimeAuthSession } from "./services/runtime-auth";
import {
	createRuntimeForwardHeaders,
	getUserStub,
	type UserStubBinding,
} from "./user-do/stub";

type RuntimeAppEnv = {
	Bindings: {
		CORPORATION_RUNTIME_AUTH_SECRET?: string;
		CORPORATION_SERVER_URL?: string;
		USER_DO: UserStubBinding;
	};
};

export const runtimeApp = new Hono<RuntimeAppEnv>()
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

		return await getUserStub(c.env.USER_DO, claims.sub).fetch(
			new Request("http://user/runtime/socket", {
				method: c.req.raw.method,
				headers,
			})
		);
	});
