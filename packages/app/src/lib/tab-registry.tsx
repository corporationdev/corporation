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

export type AppTabType = keyof TabConfigMap;
export type TabConfig = TabConfigMap[AppTabType];
export type AppTabParam = {
	[K in AppTabType]: {
		type: K;
		id: string;
	};
}[AppTabType];

const appTabTypeSet = new Set<AppTabType>(
	Object.keys(tabRegistry) as AppTabType[]
);

export function isAppTabType(value: string): value is AppTabType {
	return appTabTypeSet.has(value as AppTabType);
}

export function toAppTabParam(value: TabRouteParam): AppTabParam | undefined {
	if (!isAppTabType(value.type)) {
		return undefined;
	}
	return value as AppTabParam;
}
