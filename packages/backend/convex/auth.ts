import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { requireRunMutationCtx } from "@convex-dev/better-auth/utils";
import { betterAuth } from "better-auth";
import { getOrgAdapter, organization } from "better-auth/plugins/organization";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { query } from "./_generated/server";
import authConfig from "./auth.config";
import authSchema from "./betterAuth/schema";

const webUrl = process.env.CORPORATION_WEB_URL ?? "";
const sandboxTrustedOriginPatterns = ["*.e2b.app"];
const trustedOrigins = [webUrl, ...sandboxTrustedOriginPatterns].filter(
	Boolean
);
const organizationOptions = {
	allowUserToCreateOrganization: true,
} as const;
type BetterAuthSession = {
	userId?: string;
	token: string;
	activeOrganizationId?: string | null;
};
type BetterAuthSessionRow = BetterAuthSession & {
	_id: string;
	expiresAt: number;
	createdAt: number;
	updatedAt: number;
	ipAddress?: string | null;
	userAgent?: string | null;
};
type BetterAuthHookContext = {
	context?: Parameters<typeof getOrgAdapter>[0];
} | null;

function slugifyOrganizationName(name: string, userId: string) {
	const base = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	const suffix = userId.slice(0, 6).toLowerCase();
	return `${base || "workspace"}-${suffix}`;
}

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
		databaseHooks: {
			session: {
				create: {
					after: async (
						session: BetterAuthSession,
						hookContext: BetterAuthHookContext
					) => {
						if (!(session?.userId && hookContext?.context)) {
							return;
						}

						const authContext = hookContext.context;
						const orgAdapter = getOrgAdapter(authContext, organizationOptions);
						const existingOrganizations = await orgAdapter.listOrganizations(
							session.userId
						);

						let activeOrganizationId = session.activeOrganizationId ?? null;

						if (existingOrganizations.length === 0) {
							const user = await authContext.internalAdapter.findUserById(
								session.userId
							);
							const organizationName = user?.name?.trim()
								? `${user.name}'s Workspace`
								: "My Workspace";
							const organization = await orgAdapter.createOrganization({
								organization: {
									name: organizationName,
									slug: slugifyOrganizationName(
										organizationName,
										session.userId
									),
									createdAt: new Date(),
								},
							});

							await orgAdapter.createMember({
								organizationId: organization.id,
								userId: session.userId,
								role: "owner",
								createdAt: new Date(),
							});

							activeOrganizationId = organization.id;
						} else if (!activeOrganizationId) {
							activeOrganizationId = existingOrganizations[0]?.id ?? null;
						}

						if (activeOrganizationId) {
							await requireRunMutationCtx(ctx).runMutation(
								internal.organizations.ensureOrgBaseProject,
								{
									organizationId: activeOrganizationId,
									userId: session.userId,
								}
							);
						}

						if (
							activeOrganizationId &&
							activeOrganizationId !== session.activeOrganizationId
						) {
							await orgAdapter.setActiveOrganization(
								session.token,
								activeOrganizationId,
								hookContext as Parameters<
									typeof orgAdapter.setActiveOrganization
								>[2]
							);
						}
					},
				},
			},
		},
		emailAndPassword: {
			enabled: true,
			requireEmailVerification: false,
		},
		plugins: [
			crossDomain({ siteUrl: webUrl }),
			organization(organizationOptions),
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

export async function safeGetAuthSession(
	ctx: GenericCtx<DataModel>
): Promise<BetterAuthSessionRow | null> {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) {
		return null;
	}

	return (await ctx.runQuery(components.betterAuth.adapter.findOne, {
		model: "session",
		where: [
			{
				field: "_id",
				value: identity.sessionId as string,
			},
			{
				field: "expiresAt",
				operator: "gt",
				value: Date.now(),
			},
		],
	})) as BetterAuthSessionRow | null;
}

export const getCurrentUser = query({
	args: {},
	handler: async (ctx) => {
		return await authComponent.safeGetAuthUser(ctx);
	},
});
