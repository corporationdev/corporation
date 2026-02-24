import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { type PreviewTab, previews, tabs } from "../db/schema";
import { createTabId } from "./channels";
import type { TabDriverLifecycle } from "./driver-types";
import type { SpaceRuntimeContext } from "./types";

async function ensurePreview(
	ctx: SpaceRuntimeContext,
	previewId: string,
	url: string,
	port: number
): Promise<void> {
	const now = Date.now();
	const tabId = createTabId("preview", previewId);

	await ctx.vars.db.transaction(async (tx) => {
		const existing = await tx
			.select({ id: previews.id })
			.from(previews)
			.where(eq(previews.id, previewId))
			.limit(1);

		if (existing.length === 0) {
			await tx.insert(tabs).values({
				id: tabId,
				type: "preview",
				title: `Preview :${port}`,
				createdAt: now,
				updatedAt: now,
				archivedAt: null,
			});

			await tx.insert(previews).values({
				id: previewId,
				tabId,
				url,
				port,
				createdAt: now,
				updatedAt: now,
			});
			return;
		}

		await tx
			.update(previews)
			.set({ url, updatedAt: now })
			.where(eq(previews.id, previewId));

		await tx.update(tabs).set({ updatedAt: now }).where(eq(tabs.id, tabId));
	});

	await ctx.broadcastTabsChanged();
}

async function listTabs(ctx: SpaceRuntimeContext): Promise<PreviewTab[]> {
	const rows = await ctx.vars.db
		.select({
			tabId: tabs.id,
			title: tabs.title,
			createdAt: tabs.createdAt,
			updatedAt: tabs.updatedAt,
			archivedAt: tabs.archivedAt,
			previewId: previews.id,
			url: previews.url,
			port: previews.port,
		})
		.from(tabs)
		.innerJoin(previews, eq(tabs.id, previews.tabId))
		.where(and(eq(tabs.type, "preview"), isNull(tabs.archivedAt)))
		.orderBy(desc(tabs.updatedAt), asc(tabs.createdAt));

	return rows.map((row) => ({
		id: row.tabId,
		type: "preview" as const,
		title: row.title,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		archivedAt: row.archivedAt,
		previewId: row.previewId,
		url: row.url,
		port: row.port,
	}));
}

async function onSleep(): Promise<void> {
	// No persistent connections to clean up for preview tabs
}

type PreviewPublicActions = {
	ensurePreview: (
		ctx: SpaceRuntimeContext,
		previewId: string,
		url: string,
		port: number
	) => Promise<void>;
};

type PreviewDriver = TabDriverLifecycle<PreviewPublicActions> & {
	publicActions: PreviewPublicActions;
};

export const previewDriver: PreviewDriver = {
	kind: "preview",
	onSleep,
	listTabs,
	publicActions: {
		ensurePreview,
	},
};
