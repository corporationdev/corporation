import { Hono } from "hono";
import { cors } from "hono/cors";
import { githubApp } from "./github";
import { integrationsApp } from "./integrations";
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
				"Stream-Cursor",
			],
		})
	)
	.get("/", (c) => c.text("OK"))
	.get("/health", (c) => c.text("OK"))
	.route("/integrations", integrationsApp)
	.route("/github", githubApp)
	.route("/spaces", streamApp);

const app = new Hono<{ Bindings: Env }>().route("/api", apiApp);

export type AppType = typeof apiApp;
export { app };
