import { api } from "@corporation/backend/convex/_generated/api";
import { env } from "@corporation/env/server";
import type { DriverContext } from "@rivetkit/cloudflare-workers";
import { ConvexHttpClient } from "convex/browser";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { nanoid } from "nanoid";
import { actor } from "rivetkit";
import { executeBuild } from "./build-runner";
import bundledMigrations from "./db/migrations/migrations.js";
import { builds } from "./db/schema";
import type { BuildConfig, BuildReporter, EnvironmentVars } from "./types";

export const environment = actor({
	createVars: async (
		_c,
		driverCtx: DriverContext
	): Promise<EnvironmentVars> => {
		const db = drizzle(driverCtx.state.storage, {
			schema: { builds },
		});

		await migrate(db, bundledMigrations);

		return { db };
	},

	actions: {
		getBuildHistory: async (c, limit?: number) => {
			const rows = await c.vars.db
				.select({
					id: builds.id,
					type: builds.type,
					status: builds.status,
					step: builds.step,
					error: builds.error,
					snapshotId: builds.snapshotId,
					startedAt: builds.startedAt,
					completedAt: builds.completedAt,
				})
				.from(builds)
				.orderBy(builds.startedAt)
				.limit(limit ?? 20);

			// Return newest first
			return rows.reverse();
		},

		getBuild: async (c, buildId: string) => {
			const [row] = await c.vars.db
				.select()
				.from(builds)
				.where(eq(builds.id, buildId))
				.limit(1);

			return row;
		},

		startBuild: async (c, buildConfig: BuildConfig) => {
			const buildId = nanoid();
			const now = Date.now();

			await c.vars.db.insert(builds).values({
				id: buildId,
				type: buildConfig.type,
				status: "running",
				startedAt: now,
			});

			c.broadcast("build.started", { buildId, type: buildConfig.type });

			// Schedule the build via alarm so the DO stays alive for the full duration
			c.schedule.after(0, "runBuild", buildId, buildConfig);
		},

		runBuild: async (c, buildId: string, buildConfig: BuildConfig) => {
			const environmentId = c.key[0];

			const reporter: BuildReporter = {
				setStep: (step) => {
					c.vars.db
						.update(builds)
						.set({ step })
						.where(eq(builds.id, buildId))
						.then(() => {
							c.broadcast("build.step", { buildId, step });
						});
				},
				appendLog: (chunk: string) => {
					c.vars.db
						.update(builds)
						.set({ logs: sql`${builds.logs} || ${chunk}` })
						.where(eq(builds.id, buildId))
						.then(() => {
							c.broadcast("build.log", { buildId, chunk });
						});
				},
			};

			try {
				const result = await executeBuild({
					buildConfig,
					envVars: {
						nangoSecretKey: env.NANGO_SECRET_KEY,
						anthropicApiKey: env.ANTHROPIC_API_KEY,
						e2bApiKey: env.E2B_API_KEY,
					},
					reporter,
				});

				const now = Date.now();
				await c.vars.db
					.update(builds)
					.set({
						status: "success",
						step: null,
						snapshotId: result.snapshotId,
						completedAt: now,
					})
					.where(eq(builds.id, buildId));

				c.broadcast("build.complete", {
					buildId,
					status: "success",
					snapshotId: result.snapshotId,
				});

				const convex = new ConvexHttpClient(env.CONVEX_URL);
				await convex.mutation(api.environments.completeBuildFromServer, {
					internalKey: env.INTERNAL_API_KEY,
					id: environmentId as never,
					status: "success",
					snapshotId: result.snapshotId,
					snapshotCommitSha: result.snapshotCommitSha,
				});
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				const now = Date.now();
				await c.vars.db
					.update(builds)
					.set({
						status: "error",
						step: null,
						error: errorMessage,
						completedAt: now,
					})
					.where(eq(builds.id, buildId));

				c.broadcast("build.complete", {
					buildId,
					status: "error",
					error: errorMessage,
				});

				const convex = new ConvexHttpClient(env.CONVEX_URL);
				await convex.mutation(api.environments.completeBuildFromServer, {
					internalKey: env.INTERNAL_API_KEY,
					id: environmentId as never,
					status: "error",
				});
			}
		},
	},
});
