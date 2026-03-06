import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { type TabRow, tabs } from "../db/schema";
import type { SpaceRuntimeContext } from "./types";

export function listSpaceTabs(ctx: SpaceRuntimeContext): Promise<TabRow[]> {
	return ctx.vars.db
		.select({
			id: tabs.id,
			type: tabs.type,
			title: tabs.title,
			sessionId: tabs.sessionId,
			active: tabs.active,
			createdAt: tabs.createdAt,
			updatedAt: tabs.updatedAt,
			archivedAt: tabs.archivedAt,
		})
		.from(tabs)
		.where(and(eq(tabs.active, true), isNull(tabs.archivedAt)))
		.orderBy(desc(tabs.updatedAt), asc(tabs.createdAt));
}

export async function broadcastTabsChanged(
	ctx: SpaceRuntimeContext
): Promise<void> {
	ctx.broadcast("tabs.changed", await listSpaceTabs(ctx));
}
