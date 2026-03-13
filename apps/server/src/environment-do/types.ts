import type { RequestPermissionOutcome } from "@agentclientprotocol/sdk";
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

export type EnvironmentStreamOffset = "-1" | "now" | `${number}`;

export type EnvironmentStreamSubscriber = Readonly<{
	callback: Readonly<{
		binding: "SPACE_DO" | "TEST_STREAM_CONSUMER_DO";
		name: string;
	}>;
	requesterId: string;
}>;

export type EnvironmentStreamSubscriptionSnapshot = Readonly<{
	callbackBinding: "SPACE_DO" | "TEST_STREAM_CONSUMER_DO";
	callbackName: string;
	requesterId: string;
	stream: string;
}>;

export type EnvironmentRpcErrorCode =
	| "runtime_connection_closed"
	| "runtime_connection_errored"
	| "runtime_connection_superseded"
	| "runtime_not_connected"
	| "runtime_request_already_pending"
	| "runtime_request_send_failed"
	| "runtime_request_timed_out";

export type EnvironmentRpcError = Readonly<{
	code: EnvironmentRpcErrorCode;
	message: string;
}>;

export type EnvironmentRpcResult<T> =
	| Readonly<{
			ok: true;
			value: T;
	  }>
	| Readonly<{
			ok: false;
			error: EnvironmentRpcError;
	  }>;

export type EnvironmentRuntimeSession = Readonly<{
	sessionId: string;
	activeTurnId: string | null;
	agent: string;
	cwd: string;
	model?: string;
	mode?: string;
	configOptions: Readonly<Record<string, string>>;
}>;

export type EnvironmentRuntimeCommand =
	| {
			type: "create_session";
			requestId: string;
			input: {
				sessionId: string;
				agent: string;
				cwd: string;
				model?: string;
				mode?: string;
				configOptions?: Record<string, string>;
			};
	  }
	| {
			type: "prompt";
			requestId: string;
			input: {
				sessionId: string;
				prompt: Array<{
					type: "text";
					text: string;
				}>;
				model?: string;
				mode?: string;
				configOptions?: Record<string, string>;
			};
	  }
	| {
			type: "abort";
			requestId: string;
			input: {
				sessionId: string;
			};
	  }
	| {
			type: "respond_to_permission";
			requestId: string;
			input: {
				requestId: string;
				outcome: RequestPermissionOutcome;
			};
	  }
	| {
			type: "get_session";
			requestId: string;
			input: {
				sessionId: string;
			};
	  };

export type EnvironmentRuntimeCommandResponse =
	| {
			type: "response";
			requestId: string;
			ok: true;
			result:
				| { session: EnvironmentRuntimeSession }
				| { turnId: string }
				| { aborted: boolean }
				| { handled: boolean }
				| { session: EnvironmentRuntimeSession | null };
	  }
	| {
			type: "response";
			requestId: string;
			ok: false;
			error: string;
	  };

export type EnvironmentSubscribeStreamInput = Readonly<{
	offset: EnvironmentStreamOffset;
	stream: string;
	subscriber: EnvironmentStreamSubscriber;
}>;

export type EnvironmentUnsubscribeStreamInput = Readonly<{
	stream: string;
}>;

export type EnvironmentStreamDeliveryItem = Readonly<{
	commandId?: string;
	createdAt: number;
	event: unknown;
	eventId: string;
	offset: EnvironmentStreamOffset;
}>;

export type EnvironmentStreamDelivery = Readonly<{
	items: EnvironmentStreamDeliveryItem[];
	nextOffset: EnvironmentStreamOffset;
	requesterId: string;
	stream: string;
	streamClosed: boolean;
	upToDate: boolean;
}>;

export type RuntimeHelloMessage = {
	type: "hello";
	runtime: "sandbox-runtime";
};

export type RuntimeStreamItemsMessage = Readonly<{
	type: "stream_items";
	stream: string;
	items: EnvironmentStreamDeliveryItem[];
	nextOffset: EnvironmentStreamOffset;
	upToDate: boolean;
	streamClosed: boolean;
}>;

export type EnvironmentStreamSubscriptionState = Readonly<{
	offset: EnvironmentStreamOffset;
	subscriber: EnvironmentStreamSubscriber;
}>;

export type StreamConsumerStub = {
	receiveEnvironmentStreamItems(
		input: EnvironmentStreamDelivery
	): Promise<EnvironmentRpcResult<{}>> | EnvironmentRpcResult<{}>;
};

export type EnvironmentDoCallbackBindings = {
	SPACE_DO?: {
		getByName(name: string): StreamConsumerStub;
	};
	TEST_STREAM_CONSUMER_DO?: {
		getByName(name: string): StreamConsumerStub;
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
