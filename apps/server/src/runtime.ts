import { runtimeAuthSessionRequestSchema } from "@corporation/contracts/runtime-auth";
import { Hono } from "hono";
import { createRuntimeAuthSession } from "./services/runtime-auth";

export const runtimeApp = new Hono<{ Bindings: Env }>().post(
	"/:spaceSlug/runtime/auth/session",
	async (c) => {
		const { spaceSlug } = c.req.param();
		const body = runtimeAuthSessionRequestSchema.safeParse(
			await c.req.json().catch(() => null)
		);
		if (!body.success) {
			return c.json({ error: body.error.message }, 400);
		}
		try {
			return c.json(
				await createRuntimeAuthSession(c.env, c.req.url, {
					spaceSlug,
					refreshToken: body.data.refreshToken,
				})
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Runtime auth failed";
			return c.json({ error: message }, message === "Unauthorized" ? 401 : 500);
		}
	}
);
