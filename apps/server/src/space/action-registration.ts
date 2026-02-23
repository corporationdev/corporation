import type { TabType } from "../db/schema";
import { createTabChannel } from "./channels";
import type {
	DriverAction,
	DriverActionMap,
	TabDriverLifecycle,
} from "./driver-types";
import { subscribeToChannel, unsubscribeFromChannel } from "./subscriptions";
import type { SpaceRuntimeContext } from "./types";

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

type KindSubscriptionActions<K extends string> = {
	[P in `subscribe${Capitalize<K>}`]: (ctx: unknown, entityId: string) => void;
} & {
	[P in `unsubscribe${Capitalize<K>}`]: (
		ctx: unknown,
		entityId: string
	) => void;
};

type DriverPublicActions<
	TDrivers extends readonly TabDriverLifecycle<DriverActionMap>[],
> = UnionToIntersection<TDrivers[number]["publicActions"]>;

type DriverSubscriptionActions<
	TDrivers extends readonly TabDriverLifecycle<DriverActionMap>[],
> = UnionToIntersection<
	TDrivers[number] extends infer TDriver
		? TDriver extends TabDriverLifecycle<DriverActionMap>
			? KindSubscriptionActions<TDriver["kind"]>
			: never
		: never
>;

type CollectedDriverActions<
	TDrivers extends readonly TabDriverLifecycle<DriverActionMap>[],
> = ActionMapWithoutContext<DriverPublicActions<TDrivers>> &
	DriverSubscriptionActions<TDrivers>;

function capitalize(value: string): string {
	if (!value) {
		return value;
	}
	return `${value[0]?.toUpperCase()}${value.slice(1)}`;
}

function assertNoCollision(
	actions: Record<string, (ctx: unknown, ...args: never[]) => unknown>,
	actionName: string,
	source: string
): void {
	if (actionName in actions) {
		throw new Error(`Duplicate action '${actionName}' from ${source}`);
	}
}

function createSubscribeAction(kind: TabType) {
	const kindLabel = capitalize(kind);
	return (ctx: unknown, entityId: string) => {
		const runtime = ctx as SpaceRuntimeContext;
		if (!runtime.conn) {
			throw new Error(
				`${kindLabel} subscriptions require an active connection`
			);
		}
		subscribeToChannel(
			runtime.vars.subscriptions,
			createTabChannel(kind, entityId),
			runtime.conn.id
		);
	};
}

function createUnsubscribeAction(kind: TabType) {
	const kindLabel = capitalize(kind);
	return (ctx: unknown, entityId: string) => {
		const runtime = ctx as SpaceRuntimeContext;
		if (!runtime.conn) {
			throw new Error(
				`${kindLabel} subscriptions require an active connection`
			);
		}
		unsubscribeFromChannel(
			runtime.vars.subscriptions,
			createTabChannel(kind, entityId),
			runtime.conn.id
		);
	};
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
				actionHandler(ctx as SpaceRuntimeContext, ...args);
		}

		const kindSuffix = capitalize(driver.kind);
		const subscribeName = `subscribe${kindSuffix}`;
		const unsubscribeName = `unsubscribe${kindSuffix}`;

		assertNoCollision(actions, subscribeName, `${driver.kind}.subscriptions`);
		assertNoCollision(actions, unsubscribeName, `${driver.kind}.subscriptions`);

		actions[subscribeName] = createSubscribeAction(driver.kind);
		actions[unsubscribeName] = createUnsubscribeAction(driver.kind);
	}

	return actions as CollectedDriverActions<TDrivers>;
}
