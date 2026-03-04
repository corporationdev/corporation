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

	await ctx.vars.db.transaction((tx) => {
		const existingPreview = tx
			.select({ id: previews.id, tabId: previews.tabId })
			.from(previews)
			.where(eq(previews.id, previewId))
			.limit(1)
			.all();
		const existingTab = tx
			.select({ id: tabs.id })
			.from(tabs)
			.where(eq(tabs.id, tabId))
			.limit(1)
			.all();

		if (existingTab.length === 0) {
			tx.insert(tabs)
				.values({
					id: tabId,
					type: "preview",
					title: `Preview :${port}`,
					active: true,
					createdAt: now,
					updatedAt: now,
					archivedAt: null,
				})
				.run();
		} else {
			tx.update(tabs)
				.set({
					title: `Preview :${port}`,
					active: true,
					archivedAt: null,
					updatedAt: now,
				})
				.where(eq(tabs.id, tabId))
				.run();
		}

		if (existingPreview.length === 0) {
			tx.insert(previews)
				.values({
					id: previewId,
					tabId,
					url,
					port,
					createdAt: now,
					updatedAt: now,
				})
				.run();
		} else {
			tx.update(previews)
				.set({ tabId, url, port, updatedAt: now })
				.where(eq(previews.id, previewId))
				.run();
		}
	});

	await ctx.broadcastTabsChanged();
}

async function listTabs(ctx: SpaceRuntimeContext): Promise<PreviewTab[]> {
	const rows = await ctx.vars.db
		.select({
			tabId: tabs.id,
			title: tabs.title,
			active: tabs.active,
			createdAt: tabs.createdAt,
			updatedAt: tabs.updatedAt,
			archivedAt: tabs.archivedAt,
			previewId: previews.id,
			url: previews.url,
			port: previews.port,
		})
		.from(tabs)
		.innerJoin(previews, eq(tabs.id, previews.tabId))
		.where(
			and(
				eq(tabs.type, "preview"),
				eq(tabs.active, true),
				isNull(tabs.archivedAt)
			)
		)
		.orderBy(desc(tabs.updatedAt), asc(tabs.createdAt));

	return rows.map((row) => ({
		id: row.tabId,
		type: "preview" as const,
		title: row.title,
		active: row.active,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		archivedAt: row.archivedAt,
		previewId: row.previewId,
		url: row.url,
		port: row.port,
	}));
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
	listTabs,
	publicActions: {
		ensurePreview,
	},
};
