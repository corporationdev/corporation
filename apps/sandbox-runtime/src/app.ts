import type {
	AgentProbeRequestBody,
	AgentProbeResponse,
	PromptRequestBody,
} from "@corporation/contracts/sandbox-do";
import {
	agentProbeRequestBodySchema,
	promptRequestBodySchema,
} from "@corporation/contracts/sandbox-do";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { runtimeAuthMiddleware } from "./auth";

export type AppRuntime = {
	cancelTurn(turnId: string): Promise<boolean>;
	startTurn(body: PromptRequestBody): Promise<{ error: string } | null>;
	probeAgents(body: AgentProbeRequestBody): Promise<AgentProbeResponse>;
};

export function createApp(runtime: AppRuntime) {
	const app = new Hono().get("/health", (c) => {
		return c.json({ status: "ok" as const });
	});

	app.use("/v1/*", runtimeAuthMiddleware);

	return app
		.post("/v1/prompt", zValidator("json", promptRequestBodySchema), async (c) => {
			const body = c.req.valid("json");

			const reserveError = await runtime.startTurn(body);
			if (reserveError) {
				return c.json(
					{ error: reserveError.error as "Turn already in progress" },
					409
				);
			}

			return c.json({ accepted: true as const }, 202);
		})
		.post(
			"/v1/agents/probe",
			zValidator("json", agentProbeRequestBodySchema),
			async (c) => {
				const body = c.req.valid("json");
				return c.json(await runtime.probeAgents(body));
			}
		)
		.delete("/v1/prompt/:turnId", async (c) => {
			const turnId = c.req.param("turnId");

			if (!(await runtime.cancelTurn(turnId))) {
				return c.json({ error: "Turn not found" as const }, 404);
			}

			return c.json({ cancelled: true as const });
		});
}

export type SandboxRuntimeApp = ReturnType<typeof createApp>;
