import { env } from "@corporation/env/server";
import { createLogger } from "@corporation/logger";
import type {
	DriverAction,
	DriverActionMap,
	TabDriverLifecycle,
} from "./driver-types";
import { listSpaceTabs } from "./tab-list";
import type { SpaceRuntimeContext } from "./types";

const log = createLogger("space:keepalive");

// Keep in sync with SANDBOX_TIMEOUT_MS in packages/backend/convex/sandboxActions.ts
const SANDBOX_TIMEOUT_MS = 900_000;
const SANDBOX_KEEPALIVE_DEBOUNCE_MS = 60_000;

export function refreshSandboxTimeout(runtime: SpaceRuntimeContext): void {
	const now = Date.now();
	const elapsed = now - runtime.vars.lastTimeoutRefreshAt;

	if (elapsed < SANDBOX_KEEPALIVE_DEBOUNCE_MS) {
		return;
	}

	runtime.vars.lastTimeoutRefreshAt = now;

	const sandboxId = runtime.state.sandboxId;
	const expiresAt = now + SANDBOX_TIMEOUT_MS;

	runtime.vars.sandbox
		.setTimeout(SANDBOX_TIMEOUT_MS)
		.then(() => {
			log.info({ actorId: runtime.actorId }, "sandbox-timeout.refreshed");

			const convexSiteUrl = env.CONVEX_SITE_URL;
			const internalApiKey = env.INTERNAL_API_KEY;
			if (!(convexSiteUrl && internalApiKey)) {
				return;
			}

			fetch(`${convexSiteUrl}/internal/sandbox-timeout`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${internalApiKey}`,
				},
				body: JSON.stringify({ sandboxId, expiresAt }),
			}).catch((error) => {
				log.warn(
					{ actorId: runtime.actorId, err: error },
					"sandbox-timeout.convex-update-failed"
				);
			});
		})
		.catch((error) => {
			log.warn(
				{ actorId: runtime.actorId, err: error },
				"sandbox-timeout.refresh-failed"
			);
			runtime.vars.lastTimeoutRefreshAt = 0;
		});
}

export function augmentContext(ctx: unknown): SpaceRuntimeContext {
	const runtime = ctx as SpaceRuntimeContext;
	runtime.broadcastTabsChanged = async () => {
		const allTabs = await listSpaceTabs(runtime);
		allTabs.sort((left, right) => left.createdAt - right.createdAt);
		runtime.broadcast("tabs.changed", allTabs);
	};
	refreshSandboxTimeout(runtime);
	return runtime;
}

type UnionToIntersection<T> = (
	T extends unknown
		? (arg: T) => void
		: never
) extends (arg: infer I) => void
	? I
	: never;

type ActionWithoutContext<TAction extends DriverAction> = TAction extends (
	ctx: SpaceRuntimeContext,
	...args: infer TArgs
) => infer TResult
	? (ctx: unknown, ...args: TArgs) => TResult
	: never;

type ActionMapWithoutContext<TMap> = {
	[K in keyof TMap]: TMap[K] extends DriverAction
		? ActionWithoutContext<TMap[K]>
		: never;
};

type DriverPublicActions<
	TDrivers extends readonly TabDriverLifecycle<DriverActionMap>[],
> = UnionToIntersection<TDrivers[number]["publicActions"]>;

type CollectedDriverActions<
	TDrivers extends readonly TabDriverLifecycle<DriverActionMap>[],
> = ActionMapWithoutContext<DriverPublicActions<TDrivers>>;

function assertNoCollision(
	actions: Record<string, (ctx: unknown, ...args: never[]) => unknown>,
	actionName: string,
	source: string
): void {
	if (actionName in actions) {
		throw new Error(`Duplicate action '${actionName}' from ${source}`);
	}
}

export function collectDriverActions<
	const TDrivers extends readonly TabDriverLifecycle<DriverActionMap>[],
>(drivers: TDrivers): CollectedDriverActions<TDrivers> {
	const actions: Record<string, (ctx: unknown, ...args: never[]) => unknown> =
		{};

	for (const driver of drivers) {
		for (const actionName of Object.keys(driver.publicActions)) {
			const actionHandler = driver.publicActions[
				actionName as keyof typeof driver.publicActions
			] as DriverAction;

			assertNoCollision(actions, actionName, `${driver.kind}.publicActions`);
			actions[actionName] = (ctx, ...args: never[]) =>
				actionHandler(augmentContext(ctx), ...args);
		}
	}

	return actions as CollectedDriverActions<TDrivers>;
}
