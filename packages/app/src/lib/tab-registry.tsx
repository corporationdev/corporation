import type { SpaceTab } from "@corporation/server/space";
import type { ReactNode } from "react";
import { SessionView } from "@/components/session-view";
import { TerminalView } from "@/components/terminal-view";
import type { SpaceActor } from "@/lib/rivetkit";

type TabRenderContext = {
	actor: SpaceActor;
	tab: SpaceTab | undefined;
	routeParamId: string | undefined;
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
		render: ({ actor, tab, routeParamId, spaceSlug }) => {
			const sessionTab = tab?.type === "session" ? tab : undefined;
			return (
				<SessionView
					actor={actor}
					key={routeParamId}
					sessionId={routeParamId}
					sessionTab={sessionTab}
					spaceSlug={spaceSlug}
				/>
			);
		},
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
		render: ({ actor, tab, routeParamId }) => {
			const terminalId =
				tab?.type === "terminal" ? tab.terminalId : routeParamId;
			if (!terminalId) {
				return null;
			}
			return (
				<TerminalView actor={actor} key={terminalId} terminalId={terminalId} />
			);
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
