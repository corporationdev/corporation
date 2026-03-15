import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import {
	getStageEmailFrom,
	getStageWebUrl,
	resolveRuntimeContext,
} from "@tendril/config/runtime";
import { betterAuth } from "better-auth";
import {
	bearer,
	deviceAuthorization,
	getOrgAdapter,
	organization,
} from "better-auth/plugins";
import { Resend } from "resend";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { query } from "./_generated/server";
import authConfig from "./auth.config";
import authSchema from "./betterAuth/customSchema";

function slugifyOrganizationName(name: string, userId: string) {
	const base = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	const suffix = userId.slice(0, 6).toLowerCase();
	return `${base || "workspace"}-${suffix}`;
}

const sandboxTrustedOriginPatterns = ["*.e2b.app"];

function getAuthRuntimeConfig() {
	const stage = process.env.STAGE?.trim() || "dev";
	const runtime = resolveRuntimeContext(stage, {
		allowMissingPreviewConvex: true,
	});

	return {
		authBaseUrl: `${runtime.serverBindings.CONVEX_SITE_URL}/api/auth`,
		emailFrom: getStageEmailFrom(stage),
		webUrl: getStageWebUrl(stage),
	};
}

function getRequiredInviteEmailConfig() {
	const resendApiKey = process.env.RESEND_API_KEY;
	const { emailFrom, webUrl } = getAuthRuntimeConfig();

	if (!(resendApiKey && emailFrom && webUrl)) {
		throw new Error(
			"Organization invitations require RESEND_API_KEY, EMAIL_FROM, and WEB_URL"
		);
	}

	return { resendApiKey, emailFrom, webUrl };
}

function getResendClient() {
	const { resendApiKey } = getRequiredInviteEmailConfig();
	return new Resend(resendApiKey);
}

async function sendOrganizationInvitationEmail(data: {
	id: string;
	email: string;
	role: string;
	organization: {
		name: string;
	};
	inviter: {
		user: {
			email: string;
			name?: string | null;
		};
	};
}) {
	const { emailFrom, webUrl } = getRequiredInviteEmailConfig();
	const invitationUrl = new URL("/accept-invitation", webUrl);
	invitationUrl.searchParams.set("id", data.id);
	const inviterName = data.inviter.user.name?.trim() || data.inviter.user.email;
	const subject = `${inviterName} invited you to join ${data.organization.name}`;
	const text = [
		`${inviterName} invited you to join ${data.organization.name} on tendril.`,
		"",
		`Role: ${data.role}`,
		`Accept invitation: ${invitationUrl.toString()}`,
	].join("\n");
	const html = `
		<div style="font-family: sans-serif; line-height: 1.6; color: #111827;">
			<p><strong>${inviterName}</strong> invited you to join <strong>${data.organization.name}</strong> on tendril.</p>
			<p>Role: <strong>${data.role}</strong></p>
			<p>
				<a href="${invitationUrl.toString()}" style="display: inline-block; padding: 10px 14px; background: #111827; color: #ffffff; text-decoration: none;">
					Accept invitation
				</a>
			</p>
			<p>If the button does not work, use this link:</p>
			<p><a href="${invitationUrl.toString()}">${invitationUrl.toString()}</a></p>
		</div>
	`;

	const resend = getResendClient();
	const response = await resend.emails.send({
		from: emailFrom,
		to: [data.email],
		subject,
		text,
		html,
	});

	if (response.error) {
		throw new Error(
			`Failed to send organization invitation email: ${response.error.message}`
		);
	}
}

const organizationOptions = {
	allowUserToCreateOrganization: true,
	sendInvitationEmail: sendOrganizationInvitationEmail,
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

export const authComponent = createClient<DataModel, typeof authSchema>(
	components.betterAuth,
	{
		local: {
			schema: authSchema,
		},
	}
);

export function createAuthOptions(ctx: GenericCtx<DataModel>) {
	const { authBaseUrl, webUrl } = getAuthRuntimeConfig();
	const trustedOrigins = [webUrl, ...sandboxTrustedOriginPatterns].filter(
		Boolean
	);

	return {
		baseURL: authBaseUrl,
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

						let ensuredOrganizationId: string | null = null;
						if (existingOrganizations.length === 0) {
							const user = await ctx.runQuery(
								components.betterAuth.adapter.findOne,
								{
									model: "user",
									where: [{ field: "_id", value: session.userId }],
								}
							);
							const userName = (user as { name?: string } | null)?.name?.trim();
							const organizationName = userName
								? `${userName}'s Workspace`
								: "My Workspace";
							const slug = slugifyOrganizationName(
								organizationName,
								session.userId
							);
							const existingBySlug =
								await orgAdapter.findOrganizationBySlug(slug);
							if (existingBySlug) {
								ensuredOrganizationId = existingBySlug.id;
							} else {
								const created = await orgAdapter.createOrganization({
									organization: {
										name: organizationName,
										slug,
										createdAt: new Date(),
									},
								});
								ensuredOrganizationId = created.id;
							}
							const isMember = await orgAdapter.findMemberByOrgId({
								userId: session.userId,
								organizationId: ensuredOrganizationId,
							});
							if (!isMember) {
								await orgAdapter.createMember({
									organizationId: ensuredOrganizationId,
									userId: session.userId,
									role: "owner",
									createdAt: new Date(),
								});
							}
						}

						const hasValidActiveOrganization = existingOrganizations.some(
							(organization) => organization.id === session.activeOrganizationId
						);
						const validatedActiveOrganizationId = hasValidActiveOrganization
							? session.activeOrganizationId
							: null;

						const activeOrganizationId =
							validatedActiveOrganizationId ??
							ensuredOrganizationId ??
							existingOrganizations[0]?.id ??
							null;

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
			bearer(),
			deviceAuthorization({
				verificationUri: `${webUrl}/device`,
			}),
			apiKey({
				defaultPrefix: "tendril_",
				enableSessionForAPIKeys: true,
				requireName: true,
				keyExpiration: {
					defaultExpiresIn: null,
					minExpiresIn: 1,
					maxExpiresIn: 365,
				},
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
