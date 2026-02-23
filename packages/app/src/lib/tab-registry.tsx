import type { SpaceTab } from "@corporation/server/space";
import type { ReactNode } from "react";
import { SessionView } from "@/components/session-view";
import { TerminalView } from "@/components/terminal-view";
import type { SpaceActor } from "@/lib/rivetkit";

type TabRenderContext = {
	actor: SpaceActor;
	tabId: string | undefined;
	spaceSlug: string | undefined;
};

type TabRouteParam = {
	type: string;
	id: string;
};

type BaseTabConfig<TType extends string> = {
	requiresSandbox: boolean;
	defaultTitle: string;
	render: (context: TabRenderContext) => ReactNode;
	tabParamFromSpaceTab: (
		tab: SpaceTab
	) => { type: TType; id: string } | undefined;
};

type TabConfigMap = {
	session: BaseTabConfig<"session">;
	terminal: BaseTabConfig<"terminal">;
};

export const tabRegistry: TabConfigMap = {
	session: {
		requiresSandbox: false,
		defaultTitle: "New Chat",
		render: ({ actor, tabId, spaceSlug }) => (
			<SessionView actor={actor} sessionId={tabId} spaceSlug={spaceSlug} />
		),
		tabParamFromSpaceTab: (tab) => {
			if (tab.type !== "session") {
				return undefined;
			}
			return { type: "session", id: tab.sessionId };
		},
	},
	terminal: {
		requiresSandbox: true,
		defaultTitle: "Terminal",
		render: ({ actor, tabId }) => {
			if (!tabId) {
				return null;
			}
			return <TerminalView actor={actor} key={tabId} terminalId={tabId} />;
		},
		tabParamFromSpaceTab: (tab) => {
			if (tab.type !== "terminal") {
				return undefined;
			}
			return { type: "terminal", id: tab.terminalId };
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
