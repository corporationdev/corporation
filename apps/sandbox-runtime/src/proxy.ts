/* global Bun */

import { existsSync, mkdirSync } from "node:fs";
import net from "node:net";
import { log } from "./logging";

const SYSTEM_CA_CERT_PATH = "/etc/ssl/certs/ca-certificates.crt";
const SYSTEM_CA_CERT_DIR = "/etc/ssl/certs";
const LOCAL_PROXY_HOST = "127.0.0.1";
const LOCAL_PROXY_PORT = 8877;
const LOCAL_PROXY_STATE_DIR = "/tmp/corporation-mitmproxy";
const LOCAL_PROXY_CA_CERT_PATH = `${LOCAL_PROXY_STATE_DIR}/mitmproxy-ca-cert.pem`;
const LOCAL_PROXY_LOG_PATH = "/tmp/corporation-mitmproxy.log";
const LOCAL_PROXY_STDERR_PATH = "/tmp/corporation-mitmproxy.stderr.log";
const LOCAL_PROXY_START_TIMEOUT_MS = 10_000;

let proxyProc: ReturnType<typeof Bun.spawn> | null = null;
let proxyStartPromise: Promise<void> | null = null;

function shellEscape(value: string): string {
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

function buildMitmdumpCommand(): string {
	return [
		"exec mitmdump",
		`--listen-host ${shellEscape(LOCAL_PROXY_HOST)}`,
		`--listen-port ${String(LOCAL_PROXY_PORT)}`,
		`--set confdir=${shellEscape(LOCAL_PROXY_STATE_DIR)}`,
		`--set ssl_verify_upstream_trusted_ca=${shellEscape(SYSTEM_CA_CERT_PATH)}`,
		`--set ssl_verify_upstream_trusted_confdir=${shellEscape(SYSTEM_CA_CERT_DIR)}`,
		"--set flow_detail=0",
		"--set termlog_verbosity=error",
		`>> ${shellEscape(LOCAL_PROXY_LOG_PATH)}`,
		`2>> ${shellEscape(LOCAL_PROXY_STDERR_PATH)}`,
	].join(" ");
}

async function waitForProxyReady(): Promise<void> {
	const startedAt = Date.now();

	while (Date.now() - startedAt < LOCAL_PROXY_START_TIMEOUT_MS) {
		if (proxyProc?.exitCode !== null && proxyProc?.exitCode !== undefined) {
			throw new Error(
				`mitmdump exited early with code ${proxyProc.exitCode}. See ${LOCAL_PROXY_STDERR_PATH}`
			);
		}

		if (
			existsSync(LOCAL_PROXY_CA_CERT_PATH) &&
			(await canConnect(LOCAL_PROXY_HOST, LOCAL_PROXY_PORT))
		) {
			return;
		}

		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	throw new Error(
		`Timed out waiting for mitmdump on ${LOCAL_PROXY_HOST}:${LOCAL_PROXY_PORT}`
	);
}

async function startLocalProxy(): Promise<void> {
	if (proxyProc && proxyProc.exitCode === null) {
		return;
	}

	if (!Bun.which("mitmdump")) {
		throw new Error("mitmdump is not installed in the sandbox image");
	}

	mkdirSync(LOCAL_PROXY_STATE_DIR, { recursive: true });

	proxyProc = Bun.spawn(["bash", "-lc", buildMitmdumpCommand()], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});

	await waitForProxyReady();

	log("info", "Sandbox proxy is ready", {
		host: LOCAL_PROXY_HOST,
		port: LOCAL_PROXY_PORT,
		caCertPath: LOCAL_PROXY_CA_CERT_PATH,
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

export function buildLocalProxyEnv(): Record<string, string> {
	const proxyUrl = `http://${LOCAL_PROXY_HOST}:${String(LOCAL_PROXY_PORT)}`;
	const noProxy = "localhost,127.0.0.1,::1";

	return {
		HTTP_PROXY: proxyUrl,
		HTTPS_PROXY: proxyUrl,
		NO_PROXY: noProxy,
		http_proxy: proxyUrl,
		https_proxy: proxyUrl,
		no_proxy: noProxy,
		CURL_CA_BUNDLE: LOCAL_PROXY_CA_CERT_PATH,
		NODE_EXTRA_CA_CERTS: LOCAL_PROXY_CA_CERT_PATH,
		REQUESTS_CA_BUNDLE: LOCAL_PROXY_CA_CERT_PATH,
		SSL_CERT_FILE: LOCAL_PROXY_CA_CERT_PATH,
	};
}

export { LOCAL_PROXY_CA_CERT_PATH, LOCAL_PROXY_LOG_PATH, LOCAL_PROXY_STDERR_PATH };
