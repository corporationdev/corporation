import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { authedMutation } from "./functions";
import {
	warmSandboxStatusValidator,
	warmSandboxTriggerReasonValidator,
} from "./schema";

// Keep in sync with SANDBOX_TIMEOUT_MS in sandboxActions.ts
const WARM_SANDBOX_TIMEOUT_MS = 900_000;
const EXPIRE_SCAN_LIMIT = 100;

type DbCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

async function getReadySnapshotForEnvironment(
	ctx: DbCtx,
	environmentId: Id<"environments">
): Promise<Doc<"snapshots"> | null> {
	return await ctx.db
		.query("snapshots")
		.withIndex("by_environment_status_startedAt", (q) =>
			q.eq("environmentId", environmentId).eq("status", "ready")
		)
		.order("desc")
		.first();
}

async function requireOwnedEnvironment(
	ctx: MutationCtx & { userId: string },
	environmentId: Id<"environments">
): Promise<Doc<"environments">> {
	const environment = await ctx.db.get(environmentId);
	if (!environment || environment.userId !== ctx.userId) {
		throw new ConvexError("Environment not found");
	}
	return environment;
}

function isReusableWarmSandbox(
	warmSandbox: Doc<"warmSandboxes">,
	now: number
): boolean {
	return (
		(warmSandbox.status === "warming" || warmSandbox.status === "ready") &&
		!warmSandbox.claimedBySpaceId &&
		warmSandbox.expiresAt > now
	);
}

async function findReusableWarmSandbox(
	ctx: DbCtx,
	environmentId: Id<"environments">,
	snapshotId: Id<"snapshots">,
	now: number
): Promise<Doc<"warmSandboxes"> | null> {
	const [ready, warming] = await Promise.all([
		ctx.db
			.query("warmSandboxes")
			.withIndex("by_environment_snapshot_status", (q) =>
				q
					.eq("environmentId", environmentId)
					.eq("snapshotId", snapshotId)
					.eq("status", "ready")
			)
			.collect(),
		ctx.db
			.query("warmSandboxes")
			.withIndex("by_environment_snapshot_status", (q) =>
				q
					.eq("environmentId", environmentId)
					.eq("snapshotId", snapshotId)
					.eq("status", "warming")
			)
			.collect(),
	]);

	const candidates = [...ready, ...warming]
		.filter((warmSandbox) => isReusableWarmSandbox(warmSandbox, now))
		.sort((left, right) => left.createdAt - right.createdAt);

	return candidates[0] ?? null;
}

async function expireStaleWarmSandboxes(
	ctx: Pick<MutationCtx, "db" | "scheduler">,
	now: number
): Promise<void> {
	const warmSandboxes = await ctx.db
		.query("warmSandboxes")
		.withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
		.take(EXPIRE_SCAN_LIMIT);

	for (const warmSandbox of warmSandboxes) {
		if (warmSandbox.status !== "warming" && warmSandbox.status !== "ready") {
			continue;
		}

		await ctx.db.patch(warmSandbox._id, {
			status: "expired",
			updatedAt: now,
		});

		if (warmSandbox.sandboxId) {
			await ctx.scheduler.runAfter(0, internal.sandboxActions.deleteSandbox, {
				sandboxId: warmSandbox.sandboxId,
			});
		}
	}
}

export async function claimWarmSandboxForSpace(
	ctx: Pick<MutationCtx, "db">,
	spaceId: Id<"spaces">
): Promise<boolean> {
	const space = await ctx.db.get(spaceId);
	if (!space || space.sandboxId) {
		return false;
	}

	const snapshot = await getReadySnapshotForEnvironment(
		ctx,
		space.environmentId
	);
	if (!snapshot?.externalSnapshotId) {
		return false;
	}

	const now = Date.now();
	const readyWarmSandboxes = await ctx.db
		.query("warmSandboxes")
		.withIndex("by_environment_snapshot_status", (q) =>
			q
				.eq("environmentId", space.environmentId)
				.eq("snapshotId", snapshot._id)
				.eq("status", "ready")
		)
		.collect();

	const candidate = readyWarmSandboxes
		.filter(
			(warmSandbox) =>
				warmSandbox.expiresAt > now &&
				!warmSandbox.claimedBySpaceId &&
				!!warmSandbox.sandboxId
		)
		.sort((left, right) => left.createdAt - right.createdAt)[0];

	if (!candidate?.sandboxId) {
		return false;
	}

	await ctx.db.patch(candidate._id, {
		status: "claimed",
		claimedBySpaceId: space._id,
		updatedAt: now,
	});

	await ctx.db.patch(space._id, {
		sandboxId: candidate.sandboxId,
		sandboxExpiresAt: candidate.expiresAt,
		status: "creating",
		error: "",
		updatedAt: now,
	});

	return true;
}

export const request = authedMutation({
	args: {
		environmentId: v.id("environments"),
		reason: warmSandboxTriggerReasonValidator,
	},
	handler: async (ctx, args) => {
		const now = Date.now();

		await requireOwnedEnvironment(ctx, args.environmentId);
		await expireStaleWarmSandboxes(ctx, now);

		const snapshot = await getReadySnapshotForEnvironment(
			ctx,
			args.environmentId
		);
		if (!snapshot?.externalSnapshotId) {
			return null;
		}

		const existing = await findReusableWarmSandbox(
			ctx,
			args.environmentId,
			snapshot._id,
			now
		);
		if (existing) {
			await ctx.db.patch(existing._id, {
				triggerReason: args.reason,
				updatedAt: now,
			});
			return existing._id;
		}

		const warmSandboxId = await ctx.db.insert("warmSandboxes", {
			environmentId: args.environmentId,
			snapshotId: snapshot._id,
			status: "warming",
			triggerReason: args.reason,
			expiresAt: now + WARM_SANDBOX_TIMEOUT_MS,
			createdAt: now,
			updatedAt: now,
		});

		await ctx.scheduler.runAfter(0, internal.sandboxActions.ensureWarmSandbox, {
			warmSandboxId,
		});

		return warmSandboxId;
	},
});

export const internalGet = internalQuery({
	args: {
		id: v.id("warmSandboxes"),
	},
	handler: async (ctx, args) => {
		const warmSandbox = await ctx.db.get(args.id);
		if (!warmSandbox) {
			throw new ConvexError("Warm sandbox not found");
		}

		const environment = await ctx.db.get(warmSandbox.environmentId);
		if (!environment) {
			throw new ConvexError("Environment not found");
		}

		const repository = await ctx.db.get(environment.repositoryId);
		if (!repository) {
			throw new ConvexError("Repository not found");
		}

		const snapshot = await ctx.db.get(warmSandbox.snapshotId);
		if (!snapshot) {
			throw new ConvexError("Snapshot not found");
		}

		return {
			...warmSandbox,
			environment: {
				...environment,
				repository,
			},
			snapshot,
		};
	},
});

export const getBySandboxId = internalQuery({
	args: {
		sandboxId: v.string(),
	},
	handler: async (ctx, args) => {
		return await ctx.db
			.query("warmSandboxes")
			.withIndex("by_sandboxId", (q) => q.eq("sandboxId", args.sandboxId))
			.first();
	},
});

export const internalUpdate = internalMutation({
	args: {
		id: v.id("warmSandboxes"),
		status: v.optional(warmSandboxStatusValidator),
		sandboxId: v.optional(v.string()),
		agentUrl: v.optional(v.string()),
		editorUrl: v.optional(v.string()),
		claimedBySpaceId: v.optional(v.id("spaces")),
		expiresAt: v.optional(v.number()),
		error: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const { id, ...fields } = args;
		const patch = Object.fromEntries(
			Object.entries({
				...fields,
				updatedAt: Date.now(),
			}).filter(([, value]) => value !== undefined)
		);

		await ctx.db.patch(id, patch);
	},
});

export const claimForSpace = internalMutation({
	args: {
		spaceId: v.id("spaces"),
	},
	handler: async (ctx, args) => {
		return await claimWarmSandboxForSpace(ctx, args.spaceId);
	},
});

export const expireStale = internalMutation({
	args: {},
	handler: async (ctx) => {
		await expireStaleWarmSandboxes(ctx, Date.now());
	},
});

export const applyLifecycleStatus = internalMutation({
	args: {
		id: v.id("warmSandboxes"),
		lifecycleStatus: v.union(
			v.literal("creating"),
			v.literal("running"),
			v.literal("paused"),
			v.literal("killed")
		),
	},
	handler: async (ctx, args) => {
		const warmSandbox = await ctx.db.get(args.id);
		if (!warmSandbox) {
			return;
		}

		if (warmSandbox.status === "claimed") {
			return;
		}

		if (
			args.lifecycleStatus === "paused" ||
			args.lifecycleStatus === "killed"
		) {
			await ctx.db.patch(args.id, {
				status: "expired",
				updatedAt: Date.now(),
			});
		}
	},
});
