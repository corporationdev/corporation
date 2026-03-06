import type { TabRow, TabType } from "@corporation/server/space";

export function createTabId(type: TabType, entityId: string): string {
	return `${type}_${entityId}`;
}

export function parseTabEntityId(
	tabId: string,
	type: TabType
): string | undefined {
	const prefix = `${type}_`;
	if (!tabId.startsWith(prefix)) {
		return undefined;
	}

	const entityId = tabId.slice(prefix.length);
	return entityId.length > 0 ? entityId : undefined;
}

export function parseTabEntityIdFromRow(
	tab: Pick<TabRow, "id" | "type">
): string | undefined {
	return parseTabEntityId(tab.id, tab.type);
}
