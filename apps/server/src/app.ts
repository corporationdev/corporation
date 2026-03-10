import { Hono } from "hono";
import { cors } from "hono/cors";
import { githubApp } from "./github";
import { integrationsApp } from "./integrations";
import {
	createProxyApp,
	type ProxyAppOptions,
	type ProxyFetch,
} from "./proxy";
import { streamApp } from "./stream";

export function createApiApp(options?: ProxyAppOptions & {
	proxyFetch?: ProxyFetch;
}) {
	const apiApp = new Hono<{ Bindings: Env }>()
		.use(
			cors({
				origin: (origin) => origin ?? "*",
				credentials: true,
				allowHeaders: ["Authorization", "Content-Type"],
				allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
				exposeHeaders: [
					"Stream-Next-Offset",
					"Stream-Up-To-Date",
					"Stream-Closed",
				],
			})
		)
		.get("/", (c) => c.text("OK"))
		.get("/health", (c) => c.text("OK"))
		.route("/integrations", integrationsApp)
		.route("/github", githubApp)
		.route(
			"/proxy",
			createProxyApp({
				proxyFetch: options?.proxyFetch,
				resolveUserId: options?.resolveUserId,
				resolveNangoConnection: options?.resolveNangoConnection,
				proxyViaNango: options?.proxyViaNango,
			})
		)
		.route("/spaces", streamApp);

	return new Hono<{ Bindings: Env }>().route("/api", apiApp);
}

const app = createApiApp();

export type AppType = ReturnType<typeof createApiApp>;
export { app };
