import { buildRequestSchema } from "@corporation/shared/api/environments";
import { Hono } from "hono";
import z from "zod";
import type { BuildConfig } from "./environment/types";

export const environmentsInternalApp = new Hono<{ Bindings: Env }>().post(
	"/:id/build",
	async (c) => {
		const apiKey = c.req.header("Authorization")?.replace("Bearer ", "");
		if (!apiKey || apiKey !== c.env.INTERNAL_API_KEY) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		const environmentId = c.req.param("id");
		const body = await c.req.json();
		const parsed = buildRequestSchema.safeParse(body);

		if (!parsed.success) {
			return c.json(
				{
					error: "Invalid request body",
					details: z.flattenError(parsed.error),
				},
				400
			);
		}
		const buildConfig: BuildConfig = parsed.data;

		// RIVET client is injected at runtime by the RivetKit handler
		// biome-ignore lint/suspicious/noExplicitAny: not present in static Env type
		const rivet = (c.env as any).RIVET;
		const actor = rivet.environment.getOrCreate([environmentId]);
		await actor.startBuild(buildConfig);

		return c.json({ ok: true });
	}
);
