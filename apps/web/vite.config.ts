import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const appPackageSrc = path.resolve(__dirname, "../../packages/app/src");

export default defineConfig({
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
	},
});
