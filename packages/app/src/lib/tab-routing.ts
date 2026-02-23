import type { TabParam } from "@/lib/tab-registry";
import { isTabType, toTabParam } from "@/lib/tab-registry";

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

	if (!isTabType(type)) {
		return undefined;
	}

	return toTabParam({ type, id });
}
