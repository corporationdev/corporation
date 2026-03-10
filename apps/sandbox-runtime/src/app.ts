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
import { log } from "./logging";

export type AppRuntime = {
	cancelTurn(turnId: string): boolean;
	executeTurn(body: PromptRequestBody): Promise<void>;
	probeAgents(body: AgentProbeRequestBody): Promise<AgentProbeResponse>;
	reserveTurn(body: PromptRequestBody): { error: string } | null;
};

export function createApp(runtime: AppRuntime) {
	const app = new Hono().get("/v1/health", (c) => {
		return c.json({ status: "ok" as const });
	});

	app.use("/v1/*", runtimeAuthMiddleware);

	return app
		.post("/v1/prompt", zValidator("json", promptRequestBodySchema), (c) => {
			const body = c.req.valid("json");

			const reserveError = runtime.reserveTurn(body);
			if (reserveError) {
				return c.json(
					{ error: reserveError.error as "Turn already in progress" },
					409
				);
			}

			runtime.executeTurn(body).catch((error) => {
				log("error", "Unhandled turn error", {
					turnId: body.turnId,
					error: error instanceof Error ? error.message : String(error),
				});
			});

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
		.delete("/v1/prompt/:turnId", (c) => {
			const turnId = c.req.param("turnId");

			if (!runtime.cancelTurn(turnId)) {
				return c.json({ error: "Turn not found" as const }, 404);
			}

			return c.json({ cancelled: true as const });
		});
}

export type SandboxRuntimeApp = ReturnType<typeof createApp>;
