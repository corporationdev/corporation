import { ConvexError } from "convex/values";
import {
	customAction,
	customCtx,
	customMutation,
	customQuery,
} from "convex-helpers/server/customFunctions";

import { action, mutation, query } from "./_generated/server";
import { authComponent } from "./auth";

export const authedQuery = customQuery(
	query,
	customCtx(async (ctx) => {
		const authUser = await authComponent.safeGetAuthUser(ctx);
		if (!authUser) {
			throw new ConvexError("Unauthenticated");
		}
		return { userId: authUser._id };
	})
);

export const authedMutation = customMutation(
	mutation,
	customCtx(async (ctx) => {
		const authUser = await authComponent.safeGetAuthUser(ctx);
		if (!authUser) {
			throw new ConvexError("Unauthenticated");
		}
		return { userId: authUser._id };
	})
);

export const authedAction = customAction(
	action,
	customCtx(async (ctx) => {
		const authUser = await authComponent.safeGetAuthUser(ctx);
		if (!authUser) {
			throw new ConvexError("Unauthenticated");
		}
		return { userId: authUser._id };
	})
);
