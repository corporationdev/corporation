import type { TabRow } from "@corporation/server/space";
import type { ReactNode } from "react";
import { SessionView } from "@/components/session-view";
import { TerminalView } from "@/components/terminal-view";
import type { SpaceActor } from "@/lib/rivetkit";
import { parseTabEntityId, parseTabEntityIdFromRow } from "@/lib/tab-id";

type TabRenderContext = {
	actor: SpaceActor;
	tab: TabRow | undefined;
	routeTabId: string | undefined;
	spaceSlug: string;
};

type TabRouteParam = {
	type: string;
	id: string;
};

type BaseTabConfig<TType extends string> = {
	requiresSandbox: boolean;
	defaultTitle: string;
	render: (context: TabRenderContext) => ReactNode;
	tabParamFromTab: (tab: TabRow) => { type: TType; id: string } | undefined;
};

type TabConfigMap = {
	session: BaseTabConfig<"session">;
	terminal: BaseTabConfig<"terminal">;
};

export const tabRegistry: TabConfigMap = {
	session: {
		requiresSandbox: false,
		defaultTitle: "New Chat",
		render: ({ actor, tab, routeTabId, spaceSlug }) => {
			const sessionId =
				tab?.type === "session"
					? parseTabEntityIdFromRow(tab)
					: routeTabId
						? parseTabEntityId(routeTabId, "session")
						: undefined;
			if (routeTabId && !sessionId) {
				return null;
			}
			return (
				<SessionView
					actor={actor}
					key={sessionId ?? routeTabId}
					sessionId={sessionId}
					spaceSlug={spaceSlug}
				/>
			);
		},
		tabParamFromTab: (tab) => {
			if (tab.type !== "session") {
				return undefined;
			}
			return { type: "session", id: tab.id };
		},
	},
	terminal: {
		requiresSandbox: true,
		defaultTitle: "Terminal",
		render: ({ actor, tab, routeTabId }) => {
			const terminalId =
				tab?.type === "terminal"
					? parseTabEntityIdFromRow(tab)
					: routeTabId
						? parseTabEntityId(routeTabId, "terminal")
						: undefined;
			if (!terminalId) {
				return null;
			}
			return (
				<TerminalView actor={actor} key={terminalId} terminalId={terminalId} />
			);
		},
		tabParamFromTab: (tab) => {
			if (tab.type !== "terminal") {
				return undefined;
			}
			return { type: "terminal", id: tab.id };
		},
	},
};

export type TabType = keyof TabConfigMap;
export type TabConfig = TabConfigMap[TabType];
export type TabParam = {
	[K in TabType]: {
		type: K;
		id: string;
	};
}[TabType];

const tabTypeSet = new Set<TabType>(Object.keys(tabRegistry) as TabType[]);

export function isTabType(value: string): value is TabType {
	return tabTypeSet.has(value as TabType);
}

export function toTabParam(value: TabRouteParam): TabParam | undefined {
	if (!isTabType(value.type)) {
		return undefined;
	}
	return value as TabParam;
}
