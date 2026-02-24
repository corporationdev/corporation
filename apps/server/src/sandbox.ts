import { Daytona } from "@daytonaio/sdk";
import { Hono } from "hono";
import { authMiddleware } from "./auth";

const PREVIEW_URL_EXPIRY_SECONDS = 86_400;

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

		const daytona = new Daytona({ apiKey: c.env.DAYTONA_API_KEY });
		const sandbox = await daytona.get(sandboxId);
		const result = await sandbox.getSignedPreviewUrl(
			port,
			PREVIEW_URL_EXPIRY_SECONDS
		);

		return c.json({ url: result.url });
	});
