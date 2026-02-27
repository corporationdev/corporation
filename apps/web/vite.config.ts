import path from "node:path";
import { resolveRuntimeContext } from "@corporation/config/runtime";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const appPackageSrc = path.resolve(__dirname, "../../packages/app/src");

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), "");
	const stage = env.STAGE?.trim();
	if (!stage) {
		throw new Error(
			"Missing STAGE in apps/web/.env. Run `bun secrets:inject`."
		);
	}
	const runtime = resolveRuntimeContext(stage);
	const { webClientEnv, webDevProxyEnv } = runtime;

	Object.assign(process.env, webClientEnv);

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
			proxy: webDevProxyEnv
				? {
						"/api": {
							target: webDevProxyEnv.DEV_SERVER_PROXY_TARGET,
							changeOrigin: true,
							ws: true,
						},
						"/convex/api/auth": {
							target: webDevProxyEnv.DEV_CONVEX_SITE_PROXY_TARGET,
							changeOrigin: true,
							rewrite: (pathname: string) =>
								pathname.replace("/convex", "") || "/",
						},
						"/convex": {
							target: webDevProxyEnv.DEV_CONVEX_PROXY_TARGET,
							changeOrigin: true,
							ws: true,
							rewrite: (pathname: string) =>
								pathname.replace("/convex", "") || "/",
						},
					}
				: undefined,
		},
	};
});
