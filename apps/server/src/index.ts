import { routeAgentRequest } from "agents";
import { Hono } from "hono";

export { SandboxAgent } from "./sandbox-agent";

type Env = {
	SandboxAgent: DurableObjectNamespace;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("OK"));
app.get("/health", (c) => c.text("OK"));

app.all("/agents/*", async (c) => {
	const response = await routeAgentRequest(c.req.raw, c.env);
	return response ?? c.text("Agent not found", 404);
});

export default app;
