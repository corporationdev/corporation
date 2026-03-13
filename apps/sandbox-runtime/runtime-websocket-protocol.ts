import { z } from "zod";
import type { RuntimeSession, RuntimeTurn } from "./index";
import type { RuntimeEvent } from "./runtime-events";
import {
	cancelTurnInputSchema,
	createSessionInputSchema,
	getSessionInputSchema,
	getTurnInputSchema,
	respondToPermissionRequestInputSchema,
	startTurnInputSchema,
} from "./runtime-schema";

export const runtimeWebSocketCommandSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("create_session"),
		requestId: z.string().min(1),
		input: createSessionInputSchema,
	}),
	z.object({
		type: z.literal("start_turn"),
		requestId: z.string().min(1),
		input: startTurnInputSchema,
	}),
	z.object({
		type: z.literal("cancel_turn"),
		requestId: z.string().min(1),
		input: cancelTurnInputSchema,
	}),
	z.object({
		type: z.literal("respond_to_permission_request"),
		requestId: z.string().min(1),
		input: respondToPermissionRequestInputSchema,
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
				| { cancelled: boolean }
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
