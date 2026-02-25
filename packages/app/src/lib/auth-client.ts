import {
	convexClient,
	crossDomainClient,
} from "@convex-dev/better-auth/client/plugins";
import { env } from "@corporation/env/web";
import { createAuthClient } from "better-auth/react";
import { toAbsoluteUrl } from "./url";

export const authClient = createAuthClient({
	baseURL: toAbsoluteUrl(`${env.VITE_CONVEX_SITE_URL}/api/auth`),
	plugins: [convexClient(), crossDomainClient()],
});
