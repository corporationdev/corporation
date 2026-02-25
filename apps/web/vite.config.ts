import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const appPackageSrc = path.resolve(__dirname, "../../packages/app/src");

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), "");
	const serverProxyTarget = env.DEV_SERVER_PROXY_TARGET;
	const convexProxyTarget = env.DEV_CONVEX_PROXY_TARGET;
	const convexSiteProxyTarget = env.DEV_CONVEX_SITE_PROXY_TARGET;

	for (const [name, value] of Object.entries({
		DEV_SERVER_PROXY_TARGET: serverProxyTarget,
		DEV_CONVEX_PROXY_TARGET: convexProxyTarget,
		DEV_CONVEX_SITE_PROXY_TARGET: convexSiteProxyTarget,
	})) {
		if (!value) {
			throw new Error(`Missing required env variable: ${name}`);
		}
	}

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
				},
				"/convex/api/auth": {
					target: convexSiteProxyTarget,
					changeOrigin: true,
					rewrite: (pathname: string) => pathname.replace("/convex", "") || "/",
				},
				"/convex": {
					target: convexProxyTarget,
					changeOrigin: true,
					ws: true,
					rewrite: (pathname: string) => pathname.replace("/convex", "") || "/",
				},
			},
		},
	};
});
