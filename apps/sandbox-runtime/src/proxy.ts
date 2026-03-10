/* global Bun */

import { existsSync, mkdirSync } from "node:fs";
import net from "node:net";
import { buildLocalProxyEnv, getLocalProxyConfig } from "./proxy-config";
import { log } from "./logging";

const LOCAL_PROXY_LOG_PATH = "/tmp/corporation-mitmproxy.log";
const LOCAL_PROXY_ERROR_LOG_PATH = "/tmp/corporation-mitmproxy.stderr.log";
const LOCAL_PROXY_START_TIMEOUT_MS = 10_000;

let proxyProc: ReturnType<typeof Bun.spawn> | null = null;
let proxyStartPromise: Promise<void> | null = null;

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function canConnect(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect({ host, port });
		const finish = (connected: boolean) => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(connected);
		};

		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

async function waitForProxyReady(): Promise<void> {
	const startedAt = Date.now();
	const proxyConfig = getLocalProxyConfig(process.env);

	while (Date.now() - startedAt < LOCAL_PROXY_START_TIMEOUT_MS) {
		if (proxyProc?.exitCode !== null && proxyProc?.exitCode !== undefined) {
			throw new Error(
				`mitmdump exited early with code ${proxyProc.exitCode}. See ${LOCAL_PROXY_ERROR_LOG_PATH}`
			);
		}

		if (
			existsSync(proxyConfig.caCertPath) &&
			(await canConnect(proxyConfig.host, proxyConfig.port))
		) {
			return;
		}

		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	throw new Error(
		`Timed out waiting for mitmdump on ${proxyConfig.host}:${proxyConfig.port}`
	);
}

function buildMitmCommand(): string {
	const proxyConfig = getLocalProxyConfig(process.env);

	return [
		`export SSL_CERT_FILE=${shellQuote("/etc/ssl/certs/ca-certificates.crt")};`,
		`export REQUESTS_CA_BUNDLE=${shellQuote("/etc/ssl/certs/ca-certificates.crt")};`,
		"exec mitmdump",
		`--listen-host ${proxyConfig.host}`,
		`--listen-port ${proxyConfig.port}`,
		"--ssl-insecure",
		`--set confdir=${shellQuote(proxyConfig.stateDir)}`,
		"--set block_global=false",
		"--set flow_detail=0",
		"--set termlog_verbosity=error",
		`>> ${shellQuote(LOCAL_PROXY_LOG_PATH)}`,
		`2>> ${shellQuote(LOCAL_PROXY_ERROR_LOG_PATH)}`,
	].join(" ");
}

async function startLocalProxy(): Promise<void> {
	if (proxyProc && proxyProc.exitCode === null) {
		return;
	}

	if (!Bun.which("mitmdump")) {
		throw new Error("mitmdump is not installed in the sandbox image");
	}

	const proxyConfig = getLocalProxyConfig(process.env);
	mkdirSync(proxyConfig.stateDir, { recursive: true });

	proxyProc = Bun.spawn(["bash", "-lc", buildMitmCommand()], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});

	await waitForProxyReady();

	log("info", "Local mitmproxy is ready", {
		host: proxyConfig.host,
		port: proxyConfig.port,
		caCertPath: proxyConfig.caCertPath,
	});
}

export async function ensureLocalProxyStarted(): Promise<void> {
	if (!proxyStartPromise) {
		proxyStartPromise = startLocalProxy().catch((error) => {
			proxyStartPromise = null;
			throw error;
		});
	}

	await proxyStartPromise;
}

export function installLocalProxyEnv(
	env: Record<string, string | undefined> = process.env
): void {
	const proxyEnv = buildLocalProxyEnv(env);
	for (const [key, value] of Object.entries(proxyEnv)) {
		env[key] = value;
	}
}
