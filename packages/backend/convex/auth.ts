import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins/organization";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { query } from "./_generated/server";
import authConfig from "./auth.config";
import authSchema from "./betterAuth/schema";

const webUrl = process.env.WEB_URL ?? "";
const sandboxTrustedOriginPatterns = ["*.e2b.app"];
const trustedOrigins = [webUrl, ...sandboxTrustedOriginPatterns].filter(
	Boolean
);

export const authComponent = createClient<DataModel, typeof authSchema>(
	components.betterAuth,
	{
		local: {
			schema: authSchema,
		},
	}
);

export function createAuthOptions(ctx: GenericCtx<DataModel>) {
	return {
		trustedOrigins,
		database: authComponent.adapter(ctx),
		emailAndPassword: {
			enabled: true,
			requireEmailVerification: false,
		},
		plugins: [
			crossDomain({ siteUrl: webUrl }),
			organization({
				allowUserToCreateOrganization: true,
			}),
			convex({
				authConfig,
				jwksRotateOnTokenGenerationError: true,
			}),
		],
	};
}

function createAuth(ctx: GenericCtx<DataModel>) {
	return betterAuth(createAuthOptions(ctx));
}

export { createAuth };

export const getCurrentUser = query({
	args: {},
	handler: async (ctx) => {
		return await authComponent.safeGetAuthUser(ctx);
	},
});
