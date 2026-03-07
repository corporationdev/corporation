import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { log } from "./logging";
import type { PromptRequestBody } from "./schemas";
import { promptRequestBodySchema } from "./schemas";

export type AppRuntime = {
	cancelTurn(turnId: string): boolean;
	executeTurn(body: PromptRequestBody): Promise<void>;
	reserveTurn(body: PromptRequestBody): { error: string } | null;
};

export function createApp(runtime: AppRuntime) {
	return new Hono()
		.get("/v1/health", (c) => {
			return c.json({ status: "ok" as const });
		})
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
		.delete("/v1/prompt/:turnId", (c) => {
			const turnId = c.req.param("turnId");

			if (!runtime.cancelTurn(turnId)) {
				return c.json({ error: "Turn not found" as const }, 404);
			}

			return c.json({ cancelled: true as const });
		});
}

export type SandboxRuntimeApp = ReturnType<typeof createApp>;
