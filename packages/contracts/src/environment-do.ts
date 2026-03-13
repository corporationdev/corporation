import { z } from "zod";

export const environmentStreamOffsetSchema = z.union([
	z.literal("-1"),
	z.literal("now"),
	z.string().regex(/^\d+$/),
]);
export type EnvironmentStreamOffset = z.infer<
	typeof environmentStreamOffsetSchema
>;

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

export type EnvironmentStreamSubscriber<
	BindingName extends string = string,
> = Readonly<{
	callback: Readonly<{
		binding: BindingName;
		name: string;
	}>;
	requesterId: string;
}>;

export type EnvironmentStreamSubscriptionSnapshot<
	BindingName extends string = string,
> = Readonly<{
	callbackBinding: BindingName;
	callbackName: string;
	requesterId: string;
	stream: string;
}>;

export type EnvironmentSubscribeStreamInput<
	BindingName extends string = string,
> = Readonly<{
	offset: EnvironmentStreamOffset;
	stream: string;
	subscriber: EnvironmentStreamSubscriber<BindingName>;
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

export type EnvironmentStreamDeliveryAck = Readonly<{
	committedOffset: EnvironmentStreamOffset;
}>;

export interface EnvironmentStreamConsumer {
	receiveEnvironmentStreamItems(
		input: EnvironmentStreamDelivery
	):
		| Promise<EnvironmentRpcResult<EnvironmentStreamDeliveryAck>>
		| EnvironmentRpcResult<EnvironmentStreamDeliveryAck>;
}
