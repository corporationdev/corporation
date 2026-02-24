import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
	clientPrefix: "VITE_",
	client: {
		VITE_CONVEX_URL: z.string(),
		VITE_CONVEX_SITE_URL: z.string(),
		VITE_SERVER_URL: z.string(),
	},
	// biome-ignore lint/suspicious/noExplicitAny: import.meta.env types not available outside Vite app
	runtimeEnv: (import.meta as any).env,
	emptyStringAsUndefined: true,
});
