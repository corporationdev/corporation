import { verifyRuntimeAccessToken } from "@tendril/contracts/runtime-auth";
import { Hono } from "hono";
import {
	createRuntimeForwardHeaders,
	type EnvironmentStubBinding,
	getEnvironmentStub,
} from "./environment-do/stub";

type EnvironmentAppEnv = {
	Bindings: {
		RUNTIME_AUTH_SECRET?: string;
		ENVIRONMENT_DO: EnvironmentStubBinding;
	};
};

export const environmentApp = new Hono<EnvironmentAppEnv>().get(
	"/socket",
	async (c) => {
		const token = c.req.query("token")?.trim();
		const secret = c.env.RUNTIME_AUTH_SECRET?.trim();
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

		return await getEnvironmentStub(
			c.env.ENVIRONMENT_DO,
			claims.clientId
		).fetch(
			new Request("http://environment/runtime/socket", {
				method: c.req.raw.method,
				headers,
			})
		);
	}
);
