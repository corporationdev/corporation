const DEFAULT_LOCAL_PROXY_HOST = "127.0.0.1";
const DEFAULT_LOCAL_PROXY_PORT = 8877;
const DEFAULT_LOCAL_PROXY_STATE_DIR = "/tmp/corporation-mitmproxy";
const DEFAULT_LOCAL_PROXY_WORKER_TOKEN_FILENAME = "worker-token.txt";
const DEFAULT_NO_PROXY_ENTRIES = ["localhost", "127.0.0.1", "::1"];
const TRAILING_SLASH_RE = /\/$/;
const DEFAULT_ENABLED_INTEGRATIONS = ["github"];

const WORKER_FORWARD_HOSTS_BY_INTEGRATION: Record<string, string[]> = {
	github: ["api.github.com", "uploads.github.com"],
};

type ProxyEnvSource = Record<string, string | undefined>;

function splitCsv(value: string | undefined): string[] {
	if (!value) {
		return [];
	}
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function buildNoProxyValue(baseEnv: ProxyEnvSource): string {
	const entries = new Set([
		...splitCsv(baseEnv.NO_PROXY),
		...splitCsv(baseEnv.no_proxy),
		...DEFAULT_NO_PROXY_ENTRIES,
	]);
	return Array.from(entries).join(",");
}

function getLocalProxyHost(baseEnv: ProxyEnvSource): string {
	return baseEnv.CORPORATION_PROXY_HOST || DEFAULT_LOCAL_PROXY_HOST;
}

function getLocalProxyPort(baseEnv: ProxyEnvSource): number {
	const rawPort = baseEnv.CORPORATION_PROXY_PORT;
	if (!rawPort) {
		return DEFAULT_LOCAL_PROXY_PORT;
	}
	const parsed = Number.parseInt(rawPort, 10);
	return Number.isFinite(parsed) && parsed > 0
		? parsed
		: DEFAULT_LOCAL_PROXY_PORT;
}

function getLocalProxyStateDir(baseEnv: ProxyEnvSource): string {
	return baseEnv.CORPORATION_PROXY_STATE_DIR || DEFAULT_LOCAL_PROXY_STATE_DIR;
}

function getWorkerTokenPath(stateDir: string): string {
	return `${stateDir}/${DEFAULT_LOCAL_PROXY_WORKER_TOKEN_FILENAME}`;
}

function getEnabledIntegrations(baseEnv: ProxyEnvSource): string[] {
	const configured = splitCsv(
		baseEnv.CORPORATION_PROXY_ENABLED_INTEGRATIONS
	).map((value) => value.toLowerCase());
	return configured.length > 0 ? configured : DEFAULT_ENABLED_INTEGRATIONS;
}

function getWorkerForwardHosts(baseEnv: ProxyEnvSource): string[] {
	const hosts = new Set<string>();

	for (const integration of getEnabledIntegrations(baseEnv)) {
		for (const host of WORKER_FORWARD_HOSTS_BY_INTEGRATION[integration] ?? []) {
			hosts.add(host);
		}
	}

	return Array.from(hosts);
}

function buildWorkerUrlFromServerUrl(serverUrl: string): string | null {
	try {
		const url = new URL(serverUrl);
		const normalizedPath = url.pathname.replace(TRAILING_SLASH_RE, "");
		url.pathname = normalizedPath.endsWith("/api")
			? `${normalizedPath}/proxy`
			: `${normalizedPath}/api/proxy`;
		url.search = "";
		url.hash = "";
		return url.toString();
	} catch {
		return null;
	}
}

function getWorkerUrl(baseEnv: ProxyEnvSource): string | null {
	const explicitValue = baseEnv.CORPORATION_PROXY_WORKER_URL?.trim();
	if (explicitValue) {
		return explicitValue;
	}

	const serverUrl =
		baseEnv.SERVER_URL?.trim() || baseEnv.CORPORATION_SERVER_URL?.trim();
	return serverUrl ? buildWorkerUrlFromServerUrl(serverUrl) : null;
}

export function getLocalProxyConfig(baseEnv: ProxyEnvSource = process.env): {
	host: string;
	port: number;
	stateDir: string;
	caCertPath: string;
	url: string;
	workerUrl: string | null;
	workerTokenPath: string;
	workerForwardHosts: string[];
} {
	const host = getLocalProxyHost(baseEnv);
	const port = getLocalProxyPort(baseEnv);
	const stateDir = getLocalProxyStateDir(baseEnv);

	return {
		host,
		port,
		stateDir,
		caCertPath: `${stateDir}/mitmproxy-ca-cert.pem`,
		url: `http://${host}:${port}`,
		workerUrl: getWorkerUrl(baseEnv),
		workerTokenPath: getWorkerTokenPath(stateDir),
		workerForwardHosts: getWorkerForwardHosts(baseEnv),
	};
}

export function buildLocalProxyEnv(
	baseEnv: ProxyEnvSource = process.env
): Record<string, string> {
	const config = getLocalProxyConfig(baseEnv);
	const noProxy = buildNoProxyValue(baseEnv);

	return {
		HTTP_PROXY: config.url,
		HTTPS_PROXY: config.url,
		NO_PROXY: noProxy,
		http_proxy: config.url,
		https_proxy: config.url,
		no_proxy: noProxy,
		CURL_CA_BUNDLE: config.caCertPath,
		NODE_EXTRA_CA_CERTS: config.caCertPath,
		REQUESTS_CA_BUNDLE: config.caCertPath,
		SSL_CERT_FILE: config.caCertPath,
	};
}

export {
	DEFAULT_ENABLED_INTEGRATIONS,
	DEFAULT_LOCAL_PROXY_STATE_DIR,
	DEFAULT_LOCAL_PROXY_WORKER_TOKEN_FILENAME,
};
