import type { TabType } from "./db/schema";

export function createTabId(type: TabType, entityId: string): string {
	return `${type}_${entityId}`;
}

export function createTabChannel(type: TabType, entityId: string): string {
	return `tab:${type}:${entityId}`;
}
