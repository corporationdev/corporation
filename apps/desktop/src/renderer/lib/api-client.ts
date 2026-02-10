import { env } from "@corporation/env/web";
import type { AppType } from "@corporation/server/app";
import { hc } from "hono/client";

export const apiClient = hc<AppType>(env.VITE_SERVER_URL);
