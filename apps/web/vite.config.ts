import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const appPackageSrc = path.resolve(__dirname, "../../packages/app/src");

const conductorPort = process.env.CONDUCTOR_PORT
	? Number(process.env.CONDUCTOR_PORT)
	: undefined;
const webPort = conductorPort ?? 3001;

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
		port: webPort,
	},
});
