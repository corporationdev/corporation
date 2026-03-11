import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { requireRunMutationCtx } from "@convex-dev/better-auth/utils";
import { betterAuth } from "better-auth";
import { getOrgAdapter, organization } from "better-auth/plugins/organization";
import { Resend } from "resend";
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

function getRequiredInviteEmailConfig() {
	const resendApiKey = process.env.RESEND_API_KEY;
	const emailFrom = process.env.CORPORATION_EMAIL_FROM;

	if (!(resendApiKey && emailFrom && webUrl)) {
		throw new Error(
			"Organization invitations require RESEND_API_KEY, CORPORATION_EMAIL_FROM, and CORPORATION_WEB_URL"
		);
	}

	return { resendApiKey, emailFrom };
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
	const { emailFrom } = getRequiredInviteEmailConfig();
	const invitationUrl = new URL("/accept-invitation", webUrl);
	invitationUrl.searchParams.set("id", data.id);
	const inviterName = data.inviter.user.name?.trim() || data.inviter.user.email;
	const subject = `${inviterName} invited you to join ${data.organization.name}`;
	const text = [
		`${inviterName} invited you to join ${data.organization.name} on corporation.`,
		"",
		`Role: ${data.role}`,
		`Accept invitation: ${invitationUrl.toString()}`,
	].join("\n");
	const html = `
		<div style="font-family: sans-serif; line-height: 1.6; color: #111827;">
			<p><strong>${inviterName}</strong> invited you to join <strong>${data.organization.name}</strong> on corporation.</p>
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
						const ensuredOrganizationId = await requireRunMutationCtx(
							ctx
						).runMutation(
							components.betterAuth.bootstrap.ensureUserOrganization,
							{
								userId: session.userId,
							}
						);
						const existingOrganizations = await orgAdapter.listOrganizations(
							session.userId
						);
						const hasValidActiveOrganization = existingOrganizations.some(
							(organization) => organization.id === session.activeOrganizationId
						);
						const validatedActiveOrganizationId = hasValidActiveOrganization
							? session.activeOrganizationId
							: null;

						const activeOrganizationId =
							validatedActiveOrganizationId ?? ensuredOrganizationId;

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
