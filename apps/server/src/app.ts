import { Hono } from "hono";
import { cors } from "hono/cors";
import { githubApp } from "./github";
import { integrationsApp } from "./integrations";
import { handleORPCRequest } from "./orpc";
import { proxyApp } from "./proxy";
import { runtimeApp } from "./runtime";
import { streamApp } from "./stream";

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
	.all("/rpc", async (c) => {
		const response = await handleORPCRequest(c.req.raw, c.env);
		return response ?? c.notFound();
	})
	.all("/rpc/*", async (c) => {
		const response = await handleORPCRequest(c.req.raw, c.env);
		return response ?? c.notFound();
	})
	.route("/integrations", integrationsApp)
	.route("/github", githubApp)
	.route("/proxy", proxyApp)
	.route("/spaces", runtimeApp)
	.route("/spaces", streamApp);

const app = new Hono<{ Bindings: Env }>().route("/api", apiApp);

export type AppType = typeof apiApp;
export { app };
