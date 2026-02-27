import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const appPackageSrc = path.resolve(
	import.meta.dirname,
	"../../packages/app/src"
);

export default defineConfig({
	main: {
		build: {
			outDir: "out/main",
			rollupOptions: {
				external: ["better-sqlite3"],
			},
		},
	},
	preload: {
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
});
