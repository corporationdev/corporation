import type { SpaceTab, TabType } from "../db/schema";
import type { SpaceRuntimeContext } from "./types";

export type SandboxContextUpdate = {
	sandboxId: string | null;
	sandboxUrl?: string | null;
};

export type TabDriverLifecycle = {
	kind: TabType;
	onSleep: (ctx: SpaceRuntimeContext) => Promise<void>;
	onSandboxContextChanged: (
		ctx: SpaceRuntimeContext,
		update: SandboxContextUpdate
	) => Promise<void>;
	listTabs: (ctx: SpaceRuntimeContext) => Promise<SpaceTab[]>;
};
