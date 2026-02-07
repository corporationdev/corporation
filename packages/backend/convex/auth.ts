import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { query } from "./_generated/server";
import authConfig from "./auth.config";

const DEFAULT_DEV_ORIGINS = [
	"http://localhost:3000",
	"http://localhost:3001",
	"http://localhost:5173",
	"http://127.0.0.1:3000",
	"http://127.0.0.1:3001",
	"http://127.0.0.1:5173",
	"http://localhost:1420",
	"http://127.0.0.1:1420",
] as const;

function getSiteUrl(): string {
	const url = process.env.SITE_URL;
	if (!url) {
		throw new Error("SITE_URL environment variable is not set");
	}
	return url;
}

const siteUrl = getSiteUrl();

function parseOrigins(value: string | undefined): string[] {
	if (!value) {
		return [];
	}
	return value
		.split(",")
		.map((origin) => origin.trim())
		.filter((origin) => origin.length > 0);
}

const trustedOrigins = Array.from(
	new Set([
		siteUrl,
		...DEFAULT_DEV_ORIGINS,
		...parseOrigins(process.env.TRUSTED_ORIGINS),
		...parseOrigins(process.env.CORS_ORIGIN),
	])
);

export const authComponent = createClient<DataModel>(components.betterAuth);

function createAuth(ctx: GenericCtx<DataModel>) {
	return betterAuth({
		trustedOrigins,
		database: authComponent.adapter(ctx),
		emailAndPassword: {
			enabled: true,
			requireEmailVerification: false,
		},
		plugins: [
			crossDomain({ siteUrl }),
			convex({
				authConfig,
				jwksRotateOnTokenGenerationError: true,
			}),
		],
	});
}

export { createAuth };

export const getCurrentUser = query({
	args: {},
	handler: async (ctx) => {
		return await authComponent.safeGetAuthUser(ctx);
	},
});
