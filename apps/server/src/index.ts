import { createHandler } from "@rivetkit/cloudflare-workers";
import { Hono } from "hono";
import { registry } from "./registry";

const app = new Hono();

app.get("/", (c) => c.text("OK"));
app.get("/health", (c) => c.text("OK"));

const { handler, ActorHandler } = createHandler(registry, {
	fetch: app.fetch,
});

export { ActorHandler };
export default handler;
