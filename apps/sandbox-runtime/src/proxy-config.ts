const DEFAULT_LOCAL_PROXY_HOST = "127.0.0.1";
const DEFAULT_LOCAL_PROXY_PORT = 8877;
const DEFAULT_LOCAL_PROXY_STATE_DIR = "/tmp/corporation-mitmproxy";

const DEFAULT_NO_PROXY_ENTRIES = ["localhost", "127.0.0.1", "::1"];

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

function splitNoProxy(value: string | undefined): string[] {
	return splitCsv(value);
}

function buildNoProxyValue(baseEnv: ProxyEnvSource): string {
	const entries = new Set([
		...splitNoProxy(baseEnv.NO_PROXY),
		...splitNoProxy(baseEnv.no_proxy),
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

function getLocalProxyWorkerUrl(baseEnv: ProxyEnvSource): string | null {
	const value = baseEnv.CORPORATION_PROXY_WORKER_URL?.trim();
	return value ? value : null;
}

function getLocalProxyMatchHosts(baseEnv: ProxyEnvSource): string[] {
	return splitCsv(baseEnv.CORPORATION_PROXY_MATCH_HOSTS).map((host) =>
		host.toLowerCase()
	);
}

function getLocalProxyWorkerToken(baseEnv: ProxyEnvSource): string | null {
	const value = baseEnv.CORPORATION_PROXY_WORKER_TOKEN?.trim();
	return value ? value : null;
}

export function getLocalProxyConfig(
	baseEnv: ProxyEnvSource = process.env
): {
	host: string;
	port: number;
	stateDir: string;
	caCertPath: string;
	url: string;
	workerUrl: string | null;
	matchHosts: string[];
	workerToken: string | null;
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
		workerUrl: getLocalProxyWorkerUrl(baseEnv),
		matchHosts: getLocalProxyMatchHosts(baseEnv),
		workerToken: getLocalProxyWorkerToken(baseEnv),
	};
}

export function buildLocalProxyEnv(
	baseEnv: ProxyEnvSource = {}
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
		SSL_CERT_FILE: config.caCertPath,
		NODE_EXTRA_CA_CERTS: config.caCertPath,
		REQUESTS_CA_BUNDLE: config.caCertPath,
		CURL_CA_BUNDLE: config.caCertPath,
	};
}

export { DEFAULT_LOCAL_PROXY_HOST, DEFAULT_LOCAL_PROXY_PORT, DEFAULT_LOCAL_PROXY_STATE_DIR };
