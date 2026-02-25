import { Sandbox } from "e2b";
import { Hono } from "hono";
import { authMiddleware } from "./auth";

export const sandboxApp = new Hono<{ Bindings: Env }>()
	.use(authMiddleware)
	.get("/preview", async (c) => {
		const sandboxId = c.req.query("sandboxId");
		const portStr = c.req.query("port");

		if (!(sandboxId && portStr)) {
			return c.json({ error: "sandboxId and port are required" }, 400);
		}

		const port = Number.parseInt(portStr, 10);
		if (Number.isNaN(port) || port < 1 || port > 65_535) {
			return c.json({ error: "Invalid port" }, 400);
		}

		const sandbox = await Sandbox.connect(sandboxId, {
			apiKey: c.env.E2B_API_KEY,
		});
		const url = `https://${sandbox.getHost(port)}`;

		return c.json({ url });
	});
