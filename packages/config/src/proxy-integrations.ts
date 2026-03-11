export const PROXY_INTEGRATIONS = {
	github: ["api.github.com", "uploads.github.com"],
} as const;

export type ProxyIntegrationId = keyof typeof PROXY_INTEGRATIONS;

export type ProxyIntegration = {
	integrationId: ProxyIntegrationId;
	hosts: readonly string[];
};

export function getProxyForwardHosts(): string[] {
	const hosts = new Set<string>();

	for (const integration of Object.values(PROXY_INTEGRATIONS)) {
		for (const host of integration) {
			hosts.add(host);
		}
	}

	return Array.from(hosts);
}

export function resolveProxyIntegrationForHost(
	host: string
): ProxyIntegration | null {
	const normalizedHost = host.trim().toLowerCase();

	for (const [integrationId, integration] of Object.entries(
		PROXY_INTEGRATIONS
	)) {
		if (
			integration.some(
				(candidateHost) => candidateHost.toLowerCase() === normalizedHost
			)
		) {
			return {
				integrationId: integrationId as ProxyIntegrationId,
				hosts: integration,
			};
		}
	}

	return null;
}

export function resolveProxyIntegrationForUrl(
	value: string | URL
): ProxyIntegration | null {
	try {
		const url = value instanceof URL ? value : new URL(value);
		return resolveProxyIntegrationForHost(url.hostname);
	} catch {
		return null;
	}
}
