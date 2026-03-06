import type { TabType } from "../db/schema";
import type { SpaceRuntimeContext } from "./types";

export type DriverAction = (
	ctx: SpaceRuntimeContext,
	...args: never[]
) => Promise<unknown> | unknown;

export type DriverActionMap = Record<string, DriverAction>;

export type TabDriverLifecycle<TPublicActions extends DriverActionMap> = {
	kind: TabType;
	onWake?: (ctx: SpaceRuntimeContext) => Promise<void>;
	publicActions: TPublicActions;
};
