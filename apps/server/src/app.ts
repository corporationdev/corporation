import { init as initTelemetry, wrapFetch } from "@corporation/telemetry";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { githubApp } from "./github";
import { integrationsApp } from "./integrations";
import { sandboxApp } from "./sandbox";

const apiApp = new Hono<{ Bindings: Env }>()
	.use(cors({ origin: "*" }))
	.use(async (c, next) => {
		if (c.env.AXIOM_API_TOKEN) {
			initTelemetry({
				serviceName: "corporation-worker",
				axiomApiToken: c.env.AXIOM_API_TOKEN,
				axiomDataset: c.env.AXIOM_DATASET ?? "traces",
			});
		}
		return wrapFetch(c.req.raw, {}, async () => {
			await next();
			return c.res;
		});
	})
	.get("/", (c) => c.text("OK"))
	.get("/health", (c) => c.text("OK"))
	.route("/integrations", integrationsApp)
	.route("/github", githubApp)
	.route("/sandbox", sandboxApp);

const app = new Hono<{ Bindings: Env }>().route("/api", apiApp);

export type AppType = typeof apiApp;
export { app };
