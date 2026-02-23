import {
	type AppTabParam,
	isAppTabType,
	toAppTabParam,
} from "@/lib/tab-registry";

export type TabParam = AppTabParam;

export function serializeTab(tab: TabParam): string {
	return `${tab.type}:${tab.id}`;
}

export function parseTab(raw: string | undefined): TabParam | undefined {
	if (!raw) {
		return undefined;
	}

	const colonIdx = raw.indexOf(":");
	if (colonIdx === -1) {
		return undefined;
	}

	const type = raw.slice(0, colonIdx);
	const id = raw.slice(colonIdx + 1);
	if (!id) {
		return undefined;
	}

	if (!isAppTabType(type)) {
		return undefined;
	}

	return toAppTabParam({ type, id });
}
