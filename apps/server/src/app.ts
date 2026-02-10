import { Hono } from "hono";
import { integrationsApp } from "./integrations";

const app = new Hono<{ Bindings: Env }>()
	.get("/", (c) => c.text("OK"))
	.get("/health", (c) => c.text("OK"))
	.route("/api/integrations", integrationsApp);

export type AppType = typeof app;
export { app };
