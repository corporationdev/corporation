import { Hono } from "hono";
import { cors } from "hono/cors";
import { githubApp } from "./github";
import { integrationsApp } from "./integrations";

const app = new Hono<{ Bindings: Env }>()
	.use(cors({ origin: "*" }))
	.get("/", (c) => c.text("OK"))
	.get("/health", (c) => c.text("OK"))
	.route("/integrations", integrationsApp)
	.route("/github", githubApp);

export type AppType = typeof app;
export { app };
