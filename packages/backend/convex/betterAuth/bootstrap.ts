import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";

function slugifyOrganizationName(name: string, userId: string) {
	const base = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	const suffix = userId.slice(0, 6).toLowerCase();
	return `${base || "workspace"}-${suffix}`;
}

export const ensureUserOrganization = internalMutation({
	args: {
		userId: v.string(),
	},
	handler: async (ctx, args) => {
		const existingMember = await ctx.db
			.query("member")
			.withIndex("userId", (q) => q.eq("userId", args.userId))
			.first();
		if (existingMember) {
			const existingOrganization = await ctx.db.get(
				existingMember.organizationId as Id<"organization">
			);
			if (existingOrganization) {
				return existingOrganization._id;
			}
		}

		const user = await ctx.db.get(args.userId as Id<"user">);
		if (!user) {
			throw new ConvexError("User not found");
		}

		const organizationName = user.name?.trim()
			? `${user.name}'s Workspace`
			: "My Workspace";
		const organizationSlug = slugifyOrganizationName(
			organizationName,
			args.userId
		);

		let organization = await ctx.db
			.query("organization")
			.withIndex("slug", (q) => q.eq("slug", organizationSlug))
			.first();

		if (!organization) {
			const organizationId = await ctx.db.insert("organization", {
				name: organizationName,
				slug: organizationSlug,
				createdAt: Date.now(),
			});

			organization = await ctx.db.get(organizationId);
			if (!organization) {
				throw new ConvexError("Organization not found");
			}
		}

		const members = await ctx.db
			.query("member")
			.withIndex("userId", (q) => q.eq("userId", args.userId))
			.collect();
		const existingOrganizationMember = members.find(
			(member) => member.organizationId === organization._id
		);

		if (!existingOrganizationMember) {
			await ctx.db.insert("member", {
				organizationId: organization._id,
				userId: args.userId,
				role: "owner",
				createdAt: Date.now(),
			});
		}

		return organization._id;
	},
});
