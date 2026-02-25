import { Hono } from "hono";
import { cors } from "hono/cors";
import { githubApp } from "./github";
import { integrationsApp } from "./integrations";
import { sandboxApp } from "./sandbox";

const apiApp = new Hono<{ Bindings: Env }>()
	.use(cors({ origin: "*" }))
	.get("/", (c) => c.text("OK"))
	.get("/health", (c) => c.text("OK"))
	.route("/integrations", integrationsApp)
	.route("/github", githubApp)
	.route("/sandbox", sandboxApp);

const app = new Hono<{ Bindings: Env }>().route("/api", apiApp);

export type AppType = typeof apiApp;
export { app };
