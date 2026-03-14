import {
	createSessionInputSchema,
	respondToPermissionInputSchema,
} from "@corporation/contracts/browser-space";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, authMiddleware } from "./auth";
import { getSpaceStub } from "./space-do/stub";

const sendMessageSchema = z.object({
	content: z.string().min(1),
	modelId: z.string().optional(),
	mode: z.string().optional(),
	configOptions: z.record(z.string(), z.string()).optional(),
});

const respondToPermissionBodySchema = respondToPermissionInputSchema.pick({
	outcome: true,
});

export const spacesApp = new Hono<{
	Bindings: Env;
	Variables: AuthVariables;
}>()
	.use(authMiddleware)
	.get("/:spaceSlug/sessions", async (c) => {
		const sessions = await getSpaceStub(
			c.env,
			c.req.param("spaceSlug")
		).listSessions();
		return c.json(sessions);
	})
	.get("/:spaceSlug/sessions/:sessionId", async (c) => {
		const session = await getSpaceStub(
			c.env,
			c.req.param("spaceSlug")
		).getSession({
			sessionId: c.req.param("sessionId"),
		});
		if (!session) {
			return c.json({ error: "Session not found" }, 404);
		}
		return c.json(session);
	})
	.post("/:spaceSlug/sessions", async (c) => {
		const body = createSessionInputSchema.safeParse(await c.req.json());
		if (!body.success) {
			return c.json({ error: body.error.message }, 400);
		}
		const result = await getSpaceStub(
			c.env,
			c.req.param("spaceSlug")
		).createSession(body.data);
		if (!result.ok) {
			return c.json(result, 400);
		}
		return c.json(result);
	})
	.post("/:spaceSlug/sessions/:sessionId/messages", async (c) => {
		const body = sendMessageSchema.safeParse(await c.req.json());
		if (!body.success) {
			return c.json({ error: body.error.message }, 400);
		}
		await getSpaceStub(c.env, c.req.param("spaceSlug")).promptSession({
			sessionId: c.req.param("sessionId"),
			prompt: [{ type: "text", text: body.data.content }],
			model: body.data.modelId,
			mode: body.data.mode,
			configOptions: body.data.configOptions,
		});
		return c.json(null);
	})
	.post("/:spaceSlug/sessions/:sessionId/cancel", async (c) => {
		const aborted = await getSpaceStub(
			c.env,
			c.req.param("spaceSlug")
		).abortSession({
			sessionId: c.req.param("sessionId"),
		});
		return c.json({ aborted });
	})
	.post("/:spaceSlug/sessions/:sessionId/permissions/:requestId", async (c) => {
		const body = respondToPermissionBodySchema.safeParse(await c.req.json());
		if (!body.success) {
			return c.json({ error: body.error.message }, 400);
		}
		const handled = await getSpaceStub(
			c.env,
			c.req.param("spaceSlug")
		).respondToPermission({
			sessionId: c.req.param("sessionId"),
			requestId: c.req.param("requestId"),
			outcome: body.data.outcome,
		});
		return c.json({ handled });
	});
