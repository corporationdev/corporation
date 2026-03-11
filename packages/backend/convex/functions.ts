import { ConvexError } from "convex/values";
import {
	customCtx,
	customMutation,
	customQuery,
} from "convex-helpers/server/customFunctions";

import { mutation, query } from "./_generated/server";
import { authComponent, safeGetAuthSession } from "./auth";

export const authedQuery = customQuery(
	query,
	customCtx(async (ctx) => {
		const authUser = await authComponent.safeGetAuthUser(ctx);
		if (!authUser) {
			throw new ConvexError("Unauthenticated");
		}
		const authSession = await safeGetAuthSession(ctx);
		return {
			userId: authUser._id,
			activeOrganizationId: authSession?.activeOrganizationId ?? null,
		};
	})
);

export const authedMutation = customMutation(
	mutation,
	customCtx(async (ctx) => {
		const authUser = await authComponent.safeGetAuthUser(ctx);
		if (!authUser) {
			throw new ConvexError("Unauthenticated");
		}
		const authSession = await safeGetAuthSession(ctx);
		return {
			userId: authUser._id,
			activeOrganizationId: authSession?.activeOrganizationId ?? null,
		};
	})
);
