import { z } from "zod";
import type { RuntimeSession, RuntimeTurn } from "./index";
import type { RuntimeEvent } from "./runtime-events";
import {
	abortInputSchema,
	createSessionInputSchema,
	getSessionInputSchema,
	getTurnInputSchema,
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
	z.object({
		type: z.literal("get_turn"),
		requestId: z.string().min(1),
		input: getTurnInputSchema,
	}),
]);
export type RuntimeWebSocketCommand = z.infer<
	typeof runtimeWebSocketCommandSchema
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
				| { session: RuntimeSession | null }
				| { turn: RuntimeTurn | null };
	  }
	| {
			type: "response";
			requestId: string;
			ok: false;
			error: string;
	  };

export type RuntimeWebSocketEventMessage = {
	type: "runtime_event";
	event: RuntimeEvent;
};

export type RuntimeWebSocketOutgoingMessage =
	| RuntimeWebSocketResponse
	| RuntimeWebSocketEventMessage;
