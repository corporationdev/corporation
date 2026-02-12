import { Hono } from "hono";
import { cors } from "hono/cors";
import { integrationsApp } from "./integrations";
import { repositoriesApp } from "./repositories";
import { sandboxesApp } from "./sandboxes";

const app = new Hono<{ Bindings: Env }>()
	.use(cors({ origin: "*" }))
	.get("/", (c) => c.text("OK"))
	.get("/health", (c) => c.text("OK"))
	.route("/integrations", integrationsApp)
	.route("/repositories", repositoriesApp)
	.route("/sandboxes", sandboxesApp);

export type AppType = typeof app;
export { app };
