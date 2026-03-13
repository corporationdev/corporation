import { z } from "zod";
import type { RuntimeSession } from "./index";
import type { RuntimeStreamOffset } from "./runtime-message-store";
import type { RuntimeEvent } from "./runtime-events";
import {
	abortInputSchema,
	createSessionInputSchema,
	getSessionInputSchema,
	promptInputSchema,
	respondToPermissionInputSchema,
} from "./runtime-schema";

export const runtimeWebSocketCommandSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("create_session"),
		requestId: z.string().min(1),
		input: createSessionInputSchema,
	}),
	z.object({
		type: z.literal("prompt"),
		requestId: z.string().min(1),
		input: promptInputSchema,
	}),
	z.object({
		type: z.literal("abort"),
		requestId: z.string().min(1),
		input: abortInputSchema,
	}),
	z.object({
		type: z.literal("respond_to_permission"),
		requestId: z.string().min(1),
		input: respondToPermissionInputSchema,
	}),
	z.object({
		type: z.literal("get_session"),
		requestId: z.string().min(1),
		input: getSessionInputSchema,
	}),
]);
export type RuntimeWebSocketCommand = z.infer<
	typeof runtimeWebSocketCommandSchema
>;

export const runtimeWebSocketHelloSchema = z.object({
	type: z.literal("hello"),
	runtime: z.literal("sandbox-runtime"),
});
export type RuntimeWebSocketHello = z.infer<
	typeof runtimeWebSocketHelloSchema
>;

export const runtimeWebSocketHelloAckSchema = z.object({
	type: z.literal("hello_ack"),
	connectionId: z.string().min(1),
	connectedAt: z.number().int().nonnegative(),
});
export type RuntimeWebSocketHelloAck = z.infer<
	typeof runtimeWebSocketHelloAckSchema
>;

export const runtimeWebSocketSubscribeStreamSchema = z.object({
	type: z.literal("subscribe_stream"),
	stream: z.string().min(1),
	offset: z.union([
		z.literal("-1"),
		z.literal("now"),
		z.string().regex(/^\d+$/),
	]),
});
export type RuntimeWebSocketSubscribeStream = z.infer<
	typeof runtimeWebSocketSubscribeStreamSchema
>;

export type RuntimeWebSocketResponse =
	| {
			type: "response";
			requestId: string;
			ok: true;
			result:
				| { session: RuntimeSession }
				| { turnId: string }
				| { aborted: boolean }
				| { handled: boolean }
				| { session: RuntimeSession | null };
	  }
	| {
			type: "response";
			requestId: string;
			ok: false;
			error: string;
	  };

export type RuntimeWebSocketStreamItem = {
	offset: RuntimeStreamOffset;
	eventId: string;
	commandId?: string;
	createdAt: number;
	event: RuntimeEvent;
};

export type RuntimeWebSocketStreamItemsMessage = {
	type: "stream_items";
	stream: string;
	items: RuntimeWebSocketStreamItem[];
	nextOffset: RuntimeStreamOffset;
	upToDate: boolean;
	streamClosed: boolean;
};

export type RuntimeWebSocketIncomingMessage =
	| RuntimeWebSocketCommand
	| RuntimeWebSocketHelloAck
	| RuntimeWebSocketSubscribeStream;

export type RuntimeWebSocketOutgoingMessage =
	| RuntimeWebSocketHello
	| RuntimeWebSocketResponse
	| RuntimeWebSocketStreamItemsMessage;
