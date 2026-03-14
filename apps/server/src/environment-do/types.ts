import type {
	EnvironmentRpcErrorCode,
	EnvironmentRpcResult,
	EnvironmentStreamConsumer,
	EnvironmentStreamOffset,
	EnvironmentStreamSubscriber as SharedEnvironmentStreamSubscriber,
	EnvironmentStreamSubscriptionSnapshot as SharedEnvironmentStreamSubscriptionSnapshot,
	EnvironmentSubscribeStreamInput as SharedEnvironmentSubscribeStreamInput,
} from "@corporation/contracts/environment-do";
import type { RuntimeAccessTokenClaims } from "@corporation/contracts/runtime-auth";

export type RuntimeConnectionAuthState = {
	authToken: string;
	claims: RuntimeAccessTokenClaims;
};

export type RuntimeSocketAttachment = {
	connectionId: string;
	connectedAt: number;
	lastSeenAt: number | null;
	auth: RuntimeConnectionAuthState;
};

export type RuntimeConnectionSnapshot = {
	connectionId: string;
	connectedAt: number;
	lastSeenAt: number | null;
	userId: string;
	clientId: string;
};

export type EnvironmentDoRuntimeConnectionsSnapshot = {
	activeConnection: RuntimeConnectionSnapshot | null;
	activeConnectionId: string | null;
	connected: boolean;
	connectionCount: number;
	connections: RuntimeConnectionSnapshot[];
};

export type EnvironmentDoCallbackBindingName =
	| "SPACE_DO"
	| "TEST_STREAM_CONSUMER_DO";

export type EnvironmentStreamSubscriber =
	SharedEnvironmentStreamSubscriber<EnvironmentDoCallbackBindingName>;

export type EnvironmentStreamSubscriptionState = Readonly<{
	offset: EnvironmentStreamOffset;
	subscriber: EnvironmentStreamSubscriber;
}>;

export type EnvironmentStreamSubscriptionSnapshot =
	SharedEnvironmentStreamSubscriptionSnapshot<EnvironmentDoCallbackBindingName>;

export type EnvironmentSubscribeStreamInput =
	SharedEnvironmentSubscribeStreamInput<EnvironmentDoCallbackBindingName>;

export type EnvironmentPersistedStreamSubscription = Readonly<{
	stream: string;
	lastPersistedOffset: EnvironmentStreamOffset;
	subscriber: EnvironmentStreamSubscriber;
}>;

export type EmptyResult = Record<PropertyKey, never>;

export type EnvironmentDoCallbackBindings = {
	SPACE_DO?: {
		getByName(name: string): EnvironmentStreamConsumer;
	};
	TEST_STREAM_CONSUMER_DO?: {
		getByName(name: string): EnvironmentStreamConsumer;
	};
};

export function okResult<T>(value: T): EnvironmentRpcResult<T> {
	return {
		ok: true,
		value,
	};
}

export function errorResult(
	code: EnvironmentRpcErrorCode,
	message: string
): EnvironmentRpcResult<never> {
	return {
		ok: false,
		error: {
			code,
			message,
		},
	};
}
