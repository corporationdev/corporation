import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const appPackageSrc = path.resolve(__dirname, "../../packages/app/src");

function isAbsoluteHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function normalizeProxyTarget(
	value: string | undefined,
	fallback: string
): string {
	if (value && isAbsoluteHttpUrl(value)) {
		const url = new URL(value);
		return `${url.protocol}//${url.host}`;
	}

	return fallback;
}

function stripPrefix(pathname: string, prefix: string): string {
	const next = pathname.replace(prefix, "");
	return next.length > 0 ? next : "/";
}

/**
 * Buffer a proxied response and re-send it with Content-Length instead of
 * chunked transfer encoding. Works around a Daytona proxy bug where chunked
 * responses get corrupted after connection pool reuse.
 */
function bufferProxyResponse(
	proxyRes: IncomingMessage,
	_req: IncomingMessage,
	res: ServerResponse
): void {
	const chunks: Buffer[] = [];
	proxyRes.on("data", (chunk: Buffer) => {
		chunks.push(chunk);
	});
	proxyRes.on("end", () => {
		const body = Buffer.concat(chunks);
		res.statusCode = proxyRes.statusCode ?? 200;
		for (const [key, value] of Object.entries(proxyRes.headers)) {
			if (key.toLowerCase() === "transfer-encoding") continue;
			if (value !== undefined) {
				res.setHeader(key, value);
			}
		}
		res.setHeader("content-length", body.length);
		res.end(body);
	});
}

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), "");
	const serverProxyTarget = normalizeProxyTarget(
		env.DEV_SERVER_PROXY_TARGET ?? env.VITE_SERVER_URL,
		"http://127.0.0.1:3000"
	);
	const convexProxyTarget = normalizeProxyTarget(
		env.DEV_CONVEX_PROXY_TARGET ?? env.VITE_CONVEX_URL,
		"http://127.0.0.1:3210"
	);
	const convexSiteProxyTarget = normalizeProxyTarget(
		env.DEV_CONVEX_SITE_PROXY_TARGET ?? env.VITE_CONVEX_SITE_URL,
		"http://127.0.0.1:3211"
	);

	return {
		plugins: [
			tailwindcss(),
			tanstackRouter({
				routesDirectory: path.resolve(appPackageSrc, "routes"),
				generatedRouteTree: path.resolve(appPackageSrc, "routeTree.gen.ts"),
			}),
			react(),
		],
		resolve: {
			alias: {
				"@": appPackageSrc,
			},
		},
		server: {
			host: "0.0.0.0",
			port: 3001,
			allowedHosts: true,
			proxy: {
				"/api": {
					target: serverProxyTarget,
					changeOrigin: true,
					ws: true,
					selfHandleResponse: true,
					configure: (proxy) => {
						proxy.on("proxyRes", bufferProxyResponse);
					},
				},
				"/convex/api/auth": {
					target: convexSiteProxyTarget,
					changeOrigin: true,
					rewrite: (pathname: string) => stripPrefix(pathname, "/convex"),
					selfHandleResponse: true,
					configure: (proxy) => {
						proxy.on("proxyRes", bufferProxyResponse);
					},
				},
				"/convex": {
					target: convexProxyTarget,
					changeOrigin: true,
					ws: true,
					rewrite: (pathname: string) => stripPrefix(pathname, "/convex"),
					selfHandleResponse: true,
					configure: (proxy) => {
						proxy.on("proxyRes", bufferProxyResponse);
					},
				},
			},
		},
	};
});
