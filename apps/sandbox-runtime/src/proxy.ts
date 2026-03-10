/* global Bun */

import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import net from "node:net";
import { resolve } from "node:path";
import { log } from "./logging";
import { LOCAL_PROXY_ADDON_SCRIPT } from "./proxy-addon";
import { buildLocalProxyEnv, getLocalProxyConfig } from "./proxy-config";

const SYSTEM_CA_CERT_PATH = "/etc/ssl/certs/ca-certificates.crt";
const SYSTEM_CA_CERT_DIR = "/etc/ssl/certs";
const LOCAL_PROXY_LOG_PATH = "/tmp/corporation-mitmproxy.log";
const LOCAL_PROXY_STDERR_PATH = "/tmp/corporation-mitmproxy.stderr.log";
const LOCAL_PROXY_START_TIMEOUT_MS = 10_000;
const LOCAL_PROXY_ADDON_FILENAME = "proxy-addon.py";

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
	const proxyConfig = getLocalProxyConfig(process.env);
	const addonPath = resolve(proxyConfig.stateDir, LOCAL_PROXY_ADDON_FILENAME);

	return [
		"exec mitmdump",
		`--listen-host ${shellEscape(proxyConfig.host)}`,
		`--listen-port ${String(proxyConfig.port)}`,
		`--set confdir=${shellEscape(proxyConfig.stateDir)}`,
		`--set ssl_verify_upstream_trusted_ca=${shellEscape(SYSTEM_CA_CERT_PATH)}`,
		`--set ssl_verify_upstream_trusted_confdir=${shellEscape(SYSTEM_CA_CERT_DIR)}`,
		"--set flow_detail=0",
		"--set termlog_verbosity=error",
		`-s ${shellEscape(addonPath)}`,
		`>> ${shellEscape(LOCAL_PROXY_LOG_PATH)}`,
		`2>> ${shellEscape(LOCAL_PROXY_STDERR_PATH)}`,
	].join(" ");
}

async function waitForProxyReady(): Promise<void> {
	const startedAt = Date.now();
	const proxyConfig = getLocalProxyConfig(process.env);

	while (Date.now() - startedAt < LOCAL_PROXY_START_TIMEOUT_MS) {
		if (proxyProc?.exitCode !== null && proxyProc?.exitCode !== undefined) {
			throw new Error(
				`mitmdump exited early with code ${proxyProc.exitCode}. See ${LOCAL_PROXY_STDERR_PATH}`
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

async function writeProxyAddon(): Promise<void> {
	const proxyConfig = getLocalProxyConfig(process.env);
	await writeFile(
		resolve(proxyConfig.stateDir, LOCAL_PROXY_ADDON_FILENAME),
		LOCAL_PROXY_ADDON_SCRIPT
	);
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
	await writeProxyAddon();

	proxyProc = Bun.spawn(["bash", "-lc", buildMitmdumpCommand()], {
		env: {
			...process.env,
			CORPORATION_PROXY_WORKER_URL: proxyConfig.workerUrl ?? "",
			CORPORATION_PROXY_WORKER_TOKEN: proxyConfig.workerToken ?? "",
			CORPORATION_PROXY_WORKER_FORWARD_HOSTS:
				proxyConfig.workerForwardHosts.join(","),
		},
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});

	await waitForProxyReady();

	log("info", "Sandbox proxy is ready", {
		host: proxyConfig.host,
		port: proxyConfig.port,
		caCertPath: proxyConfig.caCertPath,
		workerForwardHosts: proxyConfig.workerForwardHosts,
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

export { buildLocalProxyEnv, getLocalProxyConfig };
export { LOCAL_PROXY_LOG_PATH, LOCAL_PROXY_STDERR_PATH };
