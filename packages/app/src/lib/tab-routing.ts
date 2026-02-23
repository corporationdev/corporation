export type TabParam =
	| { type: "session"; id: string }
	| { type: "terminal"; id: string };

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

	if (type === "session" || type === "terminal") {
		return { type, id };
	}

	return undefined;
}
