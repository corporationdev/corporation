/* global WebSocket */

import { parseArgs } from "node:util";
import { createSpawnedAcpConnectionFactory } from "./acp-connection";
import { createAcpDriver } from "./acp-driver";
import { RuntimeEngine } from "./index";
import type { WebSocketLike } from "./websocket-runtime-transport";
import { createWebSocketRuntimeTransport } from "./websocket-runtime-transport";

type AuthConfig = {
	method: "refresh";
	token: string;
	refreshUrl: string;
};

async function refreshAccessToken(config: AuthConfig): Promise<string> {
	const response = await fetch(config.refreshUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ refreshToken: config.token }),
	});
	if (!response.ok) {
		throw new Error(`Token refresh failed: ${response.status}`);
	}
	const body = (await response.json()) as { accessToken: string };
	return body.accessToken;
}

function createAuthenticatedSocket(
	url: string,
	accessToken: string
): WebSocketLike {
	return new WebSocket(url, {
		headers: { Authorization: `Bearer ${accessToken}` },
	} as never) as WebSocketLike;
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			url: { type: "string" },
			"auth-method": { type: "string", default: "refresh" },
			token: { type: "string" },
			"refresh-url": { type: "string" },
		},
		strict: true,
	});

	if (!values.url) {
		throw new Error("--url is required (WebSocket endpoint)");
	}

	let createSocket: ((url: string) => WebSocketLike) | undefined;

	if (values.token) {
		if (values["auth-method"] !== "refresh") {
			throw new Error(`Unsupported auth method: ${values["auth-method"]}`);
		}
		if (!values["refresh-url"]) {
			throw new Error("--refresh-url is required for refresh auth method");
		}

		const authConfig: AuthConfig = {
			method: "refresh",
			token: values.token,
			refreshUrl: values["refresh-url"],
		};
		const accessToken = await refreshAccessToken(authConfig);
		createSocket = (url) => createAuthenticatedSocket(url, accessToken);
	}

	const factory = createSpawnedAcpConnectionFactory();
	const driver = createAcpDriver(factory);
	const engine = new RuntimeEngine(driver);

	const transport = createWebSocketRuntimeTransport({
		url: values.url,
		runtime: engine,
		...(createSocket ? { createSocket } : {}),
	});

	await transport.start();
	console.log("Runtime connected");

	const shutdown = async () => {
		console.log("Shutting down...");
		await transport.close();
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
