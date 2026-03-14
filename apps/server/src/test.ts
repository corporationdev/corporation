import type { CreateSessionInput } from "@corporation/contracts/browser-space";
import { Hono } from "hono";
import {
	type EnvironmentStubBinding,
	getEnvironmentStub,
} from "./environment-do/stub";
import type { SpaceDurableObject } from "./space-do/object";

type TestAppEnv = {
	Bindings: {
		CORPORATION_ENABLE_TEST_ROUTES?: string;
		ENVIRONMENT_DO: EnvironmentStubBinding;
		SPACE_DO: DurableObjectNamespace<SpaceDurableObject>;
	};
};

function getSpaceStub(
	spaceDo: DurableObjectNamespace<SpaceDurableObject>,
	spaceName: string
) {
	return spaceDo.getByName(spaceName);
}

export const testApp = new Hono<TestAppEnv>()
	.use("*", async (c, next) => {
		if (c.env.CORPORATION_ENABLE_TEST_ROUTES !== "1") {
			return c.notFound();
		}
		return await next();
	})
	.get("/environment-do/:environmentKey/runtime-connections", async (c) => {
		const environmentKey = c.req.param("environmentKey").trim();
		if (!environmentKey) {
			return c.json({ error: "Missing environmentKey" }, 400);
		}

		const snapshot = await getEnvironmentStub(
			c.env.ENVIRONMENT_DO,
			environmentKey
		).getRuntimeConnectionsSnapshot();
		if (!snapshot.ok) {
			return c.json({ error: snapshot.error.message }, 500);
		}

		return c.json(snapshot.value.snapshot);
	})
	.post("/space-do/:spaceName/sessions", async (c) => {
		const spaceName = c.req.param("spaceName").trim();
		if (!spaceName) {
			return c.json({ error: "Missing spaceName" }, 400);
		}

		const input = (await c.req.json()) as CreateSessionInput;
		const result = await getSpaceStub(c.env.SPACE_DO, spaceName).createSession(
			input
		);
		return c.json(result);
	})
	.post("/space-do/:spaceName/sessions/:sessionId/prompt", async (c) => {
		const spaceName = c.req.param("spaceName").trim();
		const sessionId = c.req.param("sessionId").trim();
		if (!(spaceName && sessionId)) {
			return c.json({ error: "Missing spaceName or sessionId" }, 400);
		}

		const input = (await c.req.json()) as Omit<
			Parameters<SpaceDurableObject["promptSession"]>[0],
			"sessionId"
		>;
		const result = await getSpaceStub(c.env.SPACE_DO, spaceName).promptSession({
			sessionId,
			...input,
		});
		return c.json(result);
	})
	.get("/space-do/:spaceName/sessions/:sessionId", async (c) => {
		const spaceName = c.req.param("spaceName").trim();
		const sessionId = c.req.param("sessionId").trim();
		if (!(spaceName && sessionId)) {
			return c.json({ error: "Missing spaceName or sessionId" }, 400);
		}

		const result = await getSpaceStub(c.env.SPACE_DO, spaceName).getSession({
			sessionId,
		});
		return c.json(result);
	})
	.get("/space-do/:spaceName/sessions/:sessionId/events", async (c) => {
		const spaceName = c.req.param("spaceName").trim();
		const sessionId = c.req.param("sessionId").trim();
		if (!(spaceName && sessionId)) {
			return c.json({ error: "Missing spaceName or sessionId" }, 400);
		}

		const result = await getSpaceStub(
			c.env.SPACE_DO,
			spaceName
		).getSessionEvents({
			sessionId,
		});
		return c.json(result);
	});
