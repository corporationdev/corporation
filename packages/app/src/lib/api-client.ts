import type { workerHttpContract } from "@corporation/contracts/orpc/worker-http";
import { env } from "@corporation/env/web";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createRouterUtils } from "@orpc/tanstack-query";
import { authClient } from "./auth-client";

const rpcLink = new RPCLink({
	url: `${env.VITE_CORPORATION_SERVER_URL}/api/rpc`,
	headers: () => getAuthHeaders(),
});

export const apiClient: ContractRouterClient<typeof workerHttpContract> =
	createORPCClient(rpcLink);

export const apiUtils = createRouterUtils(apiClient);

const CONVEX_TOKEN_PATH = "/convex/token";
const TOKEN_REFRESH_BUFFER_MS = 30_000;

let cachedToken: string | null = null;
let cachedTokenExp: number | null = null;

export async function getAuthToken(): Promise<string> {
	if (cachedToken && cachedTokenExp && Date.now() < cachedTokenExp) {
		return cachedToken;
	}

	const { data } = await authClient.$fetch<{ token?: string }>(
		CONVEX_TOKEN_PATH
	);
	const token = data?.token;
	if (!token) {
		throw new Error("Failed to fetch Convex auth token");
	}
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
	const token = await getAuthToken();
	return {
		Authorization: `Bearer ${token}`,
	};
}
