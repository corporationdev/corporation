import { Hono } from "hono";
import {
	type EnvironmentStubBinding,
	getEnvironmentStub,
} from "./environment-do/stub";

type TestAppEnv = {
	Bindings: {
		CORPORATION_ENABLE_TEST_ROUTES?: string;
		ENVIRONMENT_DO: EnvironmentStubBinding;
	};
};

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

		return c.json(snapshot);
	});
