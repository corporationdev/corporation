import { Hono } from "hono";
import {
	getEnvironmentStub,
	type EnvironmentStubBinding,
} from "./environment-do/stub";

const TEST_DEBUG_HEADER = "x-corporation-test-debug";

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

		const response = await getEnvironmentStub(
			c.env.ENVIRONMENT_DO,
			environmentKey
		).fetch(
			new Request("http://environment/debug/runtime-connections", {
				headers: {
					[TEST_DEBUG_HEADER]: "1",
				},
			})
		);

		return response;
	});
