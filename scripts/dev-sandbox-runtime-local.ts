#!/usr/bin/env bun

import { resolve } from "node:path";
import process from "node:process";
import { config } from "dotenv";

const repoRoot = resolve(import.meta.dirname, "..");
config({
	path: resolve(repoRoot, "apps/server/.env"),
	override: false,
	quiet: true,
});
config({
	path: resolve(repoRoot, "apps/web/.env"),
	override: false,
	quiet: true,
});

const encoder = new TextEncoder();

function base64url(input: string) {
	return btoa(input)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll(/=+$/g, "");
}

async function createDevRefreshToken(params: {
	spaceSlug: string;
	sandboxId: string;
}) {
	const secret = process.env.CORPORATION_RUNTIME_AUTH_SECRET?.trim();
	if (!secret) {
		throw new Error(
			"Missing CORPORATION_RUNTIME_AUTH_SECRET. Set it in apps/server/.env."
		);
	}

	const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const payload = base64url(
		JSON.stringify({
			sub: "dev",
			spaceSlug: params.spaceSlug,
			sandboxId: params.sandboxId,
			clientType: "sandbox_runtime",
			tokenType: "refresh",
			aud: "space-runtime-refresh",
			exp: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
			iat: Math.floor(Date.now() / 1000),
		})
	);
	const signingInput = `${header}.${payload}`;
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	const signature = new Uint8Array(
		await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput))
	);
	let signatureBinary = "";
	for (const byte of signature) {
		signatureBinary += String.fromCharCode(byte);
	}
	return `${signingInput}.${base64url(signatureBinary)}`;
}

function readFlag(name: string) {
	const index = process.argv.indexOf(name);
	if (index < 0) {
		return null;
	}
	return process.argv[index + 1]?.trim() ?? null;
}

const baseUrl =
	readFlag("--base-url") ?? process.env.CORPORATION_SERVER_URL?.trim() ?? null;
const spaceSlug =
	readFlag("--space-slug") ??
	process.env.CORPORATION_SPACE_SLUG?.trim() ??
	null;
const sandboxId =
	readFlag("--sandbox-id") ??
	process.env.CORPORATION_SANDBOX_ID?.trim() ??
	"sandbox-local";
const host = readFlag("--host") ?? "127.0.0.1";
const port = readFlag("--port") ?? "5799";

if (!(baseUrl && spaceSlug)) {
	console.error(
		[
			"Missing local runtime inputs.",
			"Provide --base-url and --space-slug, or set CORPORATION_SERVER_URL and CORPORATION_SPACE_SLUG.",
		].join("\n")
	);
	process.exit(1);
}

const refreshToken = await createDevRefreshToken({ spaceSlug, sandboxId });
const runtime = Bun.spawn(
	["bun", "--watch", "src/index.ts", "--host", host, "--port", port],
	{
		cwd: resolve(repoRoot, "apps/sandbox-runtime"),
		env: {
			...process.env,
			CORPORATION_SERVER_URL: baseUrl,
			CORPORATION_SPACE_SLUG: spaceSlug,
			CORPORATION_RUNTIME_REFRESH_TOKEN: refreshToken,
			CORPORATION_SANDBOX_ID: sandboxId,
		},
		stdout: "inherit",
		stderr: "inherit",
		stdin: "inherit",
	}
);

console.log(
	`[local] sandbox-runtime watching on http://${host}:${port}/health for space ${spaceSlug}`
);

const exitCode = await runtime.exited;
process.exit(exitCode);
