import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

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
				routesDirectory: path.resolve(__dirname, "./src/renderer/routes"),
				generatedRouteTree: path.resolve(
					__dirname,
					"./src/renderer/routeTree.gen.ts"
				),
			}),
			react(),
		],
		resolve: {
			alias: {
				"@": path.resolve(__dirname, "./src/renderer"),
			},
		},
	},
});
