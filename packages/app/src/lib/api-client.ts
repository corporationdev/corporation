import type { SessionStreamState } from "@corporation/contracts/browser-do";
import type {
	CreateSessionInput,
	CreateSessionResult,
	SpaceSessionRow,
} from "@corporation/contracts/browser-space";
import { env } from "@corporation/env/web";
import type { AppType } from "@corporation/server/app";
import { hc } from "hono/client";
import { authClient } from "./auth-client";
import { toAbsoluteUrl } from "./url";

function buildServerApiUrl(): string {
	const baseUrl = new URL(toAbsoluteUrl(env.VITE_CORPORATION_SERVER_URL));
	baseUrl.pathname = "/api";
	baseUrl.search = "";
	baseUrl.hash = "";
	return baseUrl.toString();
}

export const apiClient = hc<AppType>(buildServerApiUrl(), {
	fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
		const authHeaders = await getAuthHeaders();
		const headers = new Headers(init?.headers);
		for (const [key, value] of Object.entries(authHeaders)) {
			headers.set(key, value);
		}
		return await fetch(input, {
			...init,
			headers,
		});
	},
});

const githubClient = apiClient.github;
const integrationsClient = apiClient.integrations;
const spacesClient = apiClient.spaces[":spaceSlug"];
const sessionClient = spacesClient.sessions[":sessionId"];

type GitHubListReposResponse = {
	repositories: GitHubRepository[];
};

type IntegrationConnection = {
	connection_id: string;
	provider: string;
	created: string;
	end_user: {
		email: string | null;
		display_name: string | null;
	} | null;
};

type ListIntegrationsResponse = {
	integrations: Integration[];
};

type ConnectIntegrationResponse = {
	token: string;
	connect_link?: string;
	expires_at: string;
};

type JsonResponseLike<T = unknown> = {
	ok: boolean;
	status: number;
	json: () => Promise<T>;
};

export type GitHubRepository = {
	id: number;
	name: string;
	fullName: string;
	owner: string;
	defaultBranch: string;
	private: boolean;
	url: string;
};

export type Integration = {
	unique_key: string;
	provider: string;
	logo?: string;
	connection: IntegrationConnection | null;
};

export type SpaceSession = SpaceSessionRow;

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

async function readErrorMessage(
	response: JsonResponseLike<{
		error?: string | { message?: string };
	}>
): Promise<string> {
	try {
		const data = (await response.json()) as {
			error?: string | { message?: string };
		};
		if (typeof data.error === "string" && data.error.length > 0) {
			return data.error;
		}
		if (
			data.error &&
			typeof data.error === "object" &&
			typeof data.error.message === "string" &&
			data.error.message.length > 0
		) {
			return data.error.message;
		}
	} catch {
		// Ignore invalid error payloads.
	}

	return `Request failed (${response.status})`;
}

async function getJsonOrThrow<T>(
	response: JsonResponseLike<T | { error?: string }>
): Promise<T> {
	if (!response.ok) {
		throw new Error(
			await readErrorMessage(
				response as JsonResponseLike<{
					error?: string | { message?: string };
				}>
			)
		);
	}
	return (await response.json()) as T;
}

export async function listGitHubRepos(): Promise<GitHubRepository[]> {
	const response = await githubClient.$get();
	const data = await getJsonOrThrow<GitHubListReposResponse>(response);
	return data.repositories;
}

export async function listIntegrations(): Promise<Integration[]> {
	const response = await integrationsClient.$get();
	const data = await getJsonOrThrow<ListIntegrationsResponse>(response);
	return data.integrations;
}

export async function connectIntegration(
	allowedIntegrations?: string[]
): Promise<ConnectIntegrationResponse> {
	const response = await integrationsClient.connect.$post({
		json: {
			allowed_integrations: allowedIntegrations,
		},
	});
	return await getJsonOrThrow<ConnectIntegrationResponse>(response);
}

export async function disconnectIntegration(input: {
	connectionId: string;
	providerConfigKey: string;
}) {
	const response = await integrationsClient.connections[
		":connectionId"
	].$delete({
		param: { connectionId: input.connectionId },
		query: { provider_config_key: input.providerConfigKey },
	});
	return await getJsonOrThrow<{ success: boolean }>(response);
}

export async function listSpaceSessions(
	spaceSlug: string
): Promise<SpaceSession[]> {
	const response = await spacesClient.sessions.$get({
		param: { spaceSlug },
	});
	if (!response.ok) {
		throw new Error(
			await readErrorMessage(
				response as JsonResponseLike<{
					error?: string | { message?: string };
				}>
			)
		);
	}
	return (await response.json()) as unknown as SpaceSession[];
}

export async function createSpaceSession(
	spaceSlug: string,
	input: CreateSessionInput
): Promise<Extract<CreateSessionResult, { ok: true }>> {
	const response = await spacesClient.sessions.$post({
		param: { spaceSlug },
		json: input,
	} as never);
	const data = await getJsonOrThrow<CreateSessionResult>(response);
	if (!data.ok) {
		throw new Error(data.error.message);
	}
	return data;
}

export async function sendSpaceMessage(input: {
	spaceSlug: string;
	sessionId: string;
	content: string;
	modelId?: string;
	mode?: string;
	configOptions?: Record<string, string>;
}) {
	const response = await sessionClient.messages.$post({
		param: {
			spaceSlug: input.spaceSlug,
			sessionId: input.sessionId,
		},
		json: {
			content: input.content,
			modelId: input.modelId,
			mode: input.mode,
			configOptions: input.configOptions,
		},
	} as never);
	return await getJsonOrThrow<null>(response);
}

export async function cancelSpaceSession(input: {
	spaceSlug: string;
	sessionId: string;
}) {
	const response = await sessionClient.cancel.$post({
		param: {
			spaceSlug: input.spaceSlug,
			sessionId: input.sessionId,
		},
	});
	return await getJsonOrThrow<{ aborted: boolean }>(response);
}

export async function getSessionStreamState(
	spaceSlug: string,
	sessionId: string
): Promise<SessionStreamState> {
	const response = await sessionClient.state.$get({
		param: {
			spaceSlug,
			sessionId,
		},
	});
	return await getJsonOrThrow<SessionStreamState>(response);
}
