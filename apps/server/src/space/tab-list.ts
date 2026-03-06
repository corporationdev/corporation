import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import {
	type SessionTab,
	type SpaceTab,
	type TerminalTab,
	tabs,
	terminals,
} from "../db/schema";
import type { SpaceRuntimeContext } from "./types";

export async function listSpaceTabs(
	ctx: SpaceRuntimeContext
): Promise<SpaceTab[]> {
	const [sessionTabRows, terminalRows] = await Promise.all([
		ctx.vars.db
			.select({
				tabId: tabs.id,
				title: tabs.title,
				active: tabs.active,
				sessionId: tabs.sessionId,
				createdAt: tabs.createdAt,
				updatedAt: tabs.updatedAt,
				archivedAt: tabs.archivedAt,
			})
			.from(tabs)
			.where(
				and(
					eq(tabs.type, "session"),
					eq(tabs.active, true),
					isNull(tabs.archivedAt),
					isNotNull(tabs.sessionId)
				)
			)
			.orderBy(desc(tabs.updatedAt), asc(tabs.createdAt)),
		ctx.vars.db
			.select({
				tabId: tabs.id,
				type: tabs.type,
				title: tabs.title,
				active: tabs.active,
				createdAt: tabs.createdAt,
				updatedAt: tabs.updatedAt,
				archivedAt: tabs.archivedAt,
				terminalId: terminals.id,
			})
			.from(tabs)
			.innerJoin(terminals, eq(tabs.id, terminals.tabId))
			.where(
				and(
					eq(tabs.type, "terminal"),
					eq(tabs.active, true),
					isNull(tabs.archivedAt)
				)
			)
			.orderBy(desc(tabs.updatedAt), asc(tabs.createdAt)),
	]);

	const sessionTabs: SessionTab[] = sessionTabRows.map((row) => {
		const sessionId = row.sessionId as string;
		return {
			id: row.tabId,
			type: "session",
			title: row.title,
			active: row.active,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			archivedAt: row.archivedAt,
			sessionId,
		};
	});

	const terminalTabs: TerminalTab[] = terminalRows.map((row) => ({
		id: row.tabId,
		type: "terminal",
		title: row.title,
		active: row.active,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		archivedAt: row.archivedAt,
		terminalId: row.terminalId,
	}));

	return [...sessionTabs, ...terminalTabs];
}
