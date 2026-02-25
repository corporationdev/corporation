import { env } from "@corporation/env/web";
import type { AppType } from "@corporation/server/app";
import { hc } from "hono/client";
import { authClient } from "./auth-client";
import { toAbsoluteUrl } from "./url";

export const apiClient = hc<AppType>(toAbsoluteUrl(env.VITE_SERVER_URL), {
	fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
		const authHeaders = await getAuthHeaders();
		const merged = new Headers(init?.headers);
		for (const [key, value] of Object.entries(authHeaders)) {
			merged.set(key, value);
		}
		return fetch(input, {
			...init,
			headers: merged,
		});
	},
});

const CONVEX_TOKEN_URL = toAbsoluteUrl(
	`${env.VITE_CONVEX_SITE_URL}/api/auth/convex/token`
);
const TOKEN_REFRESH_BUFFER_MS = 30_000;

let cachedToken: string | null = null;
let cachedTokenExp: number | null = null;

async function getToken(): Promise<string> {
	if (cachedToken && cachedTokenExp && Date.now() < cachedTokenExp) {
		return cachedToken;
	}

	const { data } = await authClient.$fetch<{ token: string }>(CONVEX_TOKEN_URL);
	const token = data?.token ?? "";
	cachedToken = token;

	try {
		const payload = JSON.parse(atob(token.split(".")[1]));
		cachedTokenExp = payload.exp * 1000 - TOKEN_REFRESH_BUFFER_MS;
	} catch {
		cachedTokenExp = Date.now() + 60_000;
	}

	return token;
}

export function clearTokenCache() {
	cachedToken = null;
	cachedTokenExp = null;
}

async function getAuthHeaders() {
	const token = await getToken();
	return {
		Authorization: `Bearer ${token}`,
	};
}
