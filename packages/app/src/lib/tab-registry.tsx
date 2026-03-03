import type { SpaceTab } from "@corporation/server/space";
import type { ReactNode } from "react";
import { PreviewView } from "@/components/preview-view";
import { SessionView } from "@/components/session-view";
import { TerminalView } from "@/components/terminal-view";
import type { SpaceActor } from "@/lib/rivetkit";

type TabRenderContext = {
	actor: SpaceActor;
	tab: SpaceTab | undefined;
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
	preview: BaseTabConfig<"preview">;
};

export const tabRegistry: TabConfigMap = {
	session: {
		requiresSandbox: false,
		defaultTitle: "New Chat",
		render: ({ actor, tab, spaceSlug }) => {
			const sessionTab = tab?.type === "session" ? tab : undefined;
			return (
				<SessionView
					actor={actor}
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
		render: ({ actor, tab }) => {
			if (tab?.type !== "terminal") {
				return null;
			}
			return (
				<TerminalView
					actor={actor}
					key={tab.terminalId}
					terminalId={tab.terminalId}
				/>
			);
		},
		tabParamFromSpaceTab: (tab) => {
			if (tab.type !== "terminal") {
				return undefined;
			}
			return { type: "terminal", id: tab.terminalId };
		},
	},
	preview: {
		requiresSandbox: true,
		defaultTitle: "Preview",
		render: ({ tab }) => {
			if (tab?.type !== "preview") {
				return null;
			}
			return <PreviewView key={tab.previewId} url={tab.url} />;
		},
		tabParamFromSpaceTab: (tab) => {
			if (tab.type !== "preview") {
				return undefined;
			}
			return { type: "preview", id: tab.previewId };
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
