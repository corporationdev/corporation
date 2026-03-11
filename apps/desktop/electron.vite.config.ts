import path from "node:path";
import { resolveRuntimeContext } from "@corporation/config/runtime";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { loadEnv } from "vite";

const appPackageSrc = path.resolve(
	import.meta.dirname,
	"../../packages/app/src"
);

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), "");
	const stage = env.STAGE?.trim();
	if (!stage) {
		throw new Error(
			"Missing STAGE in apps/web/.env. Run `bun secrets:inject`."
		);
	}
	const runtime = resolveRuntimeContext(stage);

	Object.assign(process.env, runtime.webClientEnv);

	return {
		main: {
			plugins: [externalizeDepsPlugin()],
			build: {
				outDir: "out/main",
			},
		},
		preload: {
			plugins: [externalizeDepsPlugin()],
			build: {
				outDir: "out/preload",
				rollupOptions: {
					output: {
						format: "cjs",
						entryFileNames: "[name].cjs",
					},
				},
			},
		},
		renderer: {
			root: "src/renderer",
			build: {
				outDir: "out/renderer",
			},
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
		},
	};
});
