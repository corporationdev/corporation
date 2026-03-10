import { Nango } from "@nangohq/node";

type ProviderRecord = {
	name?: string;
	proxy?: {
		base_url?: string;
	};
};

type ProvidersResponse = {
	data?: ProviderRecord[];
	providers?: ProviderRecord[];
};

type ProviderLoader = () => Promise<unknown>;

const DEFAULT_CACHE_TTL_MS = 15 * 60_000;

type ProviderCacheEntry = {
	expiresAt: number;
	hostToProvider: Map<string, string | null>;
};

let providerCache: ProviderCacheEntry | null = null;

function getProvidersArray(payload: unknown): ProviderRecord[] {
	if (Array.isArray(payload)) {
		return payload as ProviderRecord[];
	}

	if (!payload || typeof payload !== "object") {
		return [];
	}

	const response = payload as ProvidersResponse;
	if (Array.isArray(response.data)) {
		return response.data;
	}
	if (Array.isArray(response.providers)) {
		return response.providers;
	}

	return [];
}

function isConcreteBaseUrl(baseUrl: string): boolean {
	return !baseUrl.includes("${") && !baseUrl.includes("{{") && !baseUrl.includes("⫷");
}

function buildProviderHostMap(providers: ProviderRecord[]): Map<string, string | null> {
	const hostToProvider = new Map<string, string | null>();

	for (const provider of providers) {
		const providerName = provider.name?.trim().toLowerCase();
		const baseUrl = provider.proxy?.base_url?.trim();

		if (!providerName || !baseUrl || !isConcreteBaseUrl(baseUrl)) {
			continue;
		}

		let hostname: string;
		try {
			hostname = new URL(baseUrl).hostname.toLowerCase();
		} catch {
			continue;
		}

		const existing = hostToProvider.get(hostname);
		if (!existing) {
			hostToProvider.set(hostname, providerName);
			continue;
		}

		if (existing !== providerName) {
			hostToProvider.set(hostname, null);
		}
	}

	return hostToProvider;
}

async function loadProvidersFromNango(env: Env): Promise<unknown> {
	const nango = new Nango({ secretKey: env.NANGO_SECRET_KEY });
	return await nango.listProviders({});
}

export function clearNangoProviderCacheForTests(): void {
	providerCache = null;
}

export async function resolveNangoProviderForHostname(
	hostname: string,
	env: Env,
	options?: {
		cacheTtlMs?: number;
		now?: () => number;
		loadProviders?: ProviderLoader;
	}
): Promise<string | null> {
	const now = options?.now ?? Date.now;
	const cacheTtlMs = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
	const normalizedHostname = hostname.trim().toLowerCase();

	if (providerCache && providerCache.expiresAt > now()) {
		return providerCache.hostToProvider.get(normalizedHostname) ?? null;
	}

	const payload = await (options?.loadProviders ?? (() => loadProvidersFromNango(env)))();
	const hostToProvider = buildProviderHostMap(getProvidersArray(payload));

	providerCache = {
		expiresAt: now() + cacheTtlMs,
		hostToProvider,
	};

	return hostToProvider.get(normalizedHostname) ?? null;
}
