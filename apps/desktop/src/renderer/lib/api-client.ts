import { env } from "@corporation/env/web";
import type { AppType } from "@corporation/server/app";
import { hc } from "hono/client";
import { authClient } from "./auth-client";

export const apiClient = hc<AppType>(env.VITE_SERVER_URL);

const CONVEX_TOKEN_URL = `${env.VITE_CONVEX_SITE_URL}/api/auth/convex/token`;
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

export async function getAuthHeaders() {
	const token = await getToken();
	return {
		Authorization: `Bearer ${token}`,
	};
}
