import { z } from "zod";
import {
	environmentStreamOffsetSchema,
	type EnvironmentStreamOffset,
} from "./environment-do";

export const environmentPromptPartSchema = z.object({
	type: z.literal("text"),
	text: z.string(),
});

export const environmentCreateSessionInputSchema = z.object({
	sessionId: z.string().min(1),
	agent: z.string().min(1),
	cwd: z.string().min(1),
	model: z.string().optional(),
	mode: z.string().optional(),
	configOptions: z.record(z.string(), z.string()).optional(),
});

export const environmentPromptInputSchema = z.object({
	sessionId: z.string().min(1),
	prompt: z.array(environmentPromptPartSchema),
	model: z.string().optional(),
	mode: z.string().optional(),
	configOptions: z.record(z.string(), z.string()).optional(),
});

export const environmentAbortInputSchema = z.object({
	sessionId: z.string().min(1),
});

export const environmentRespondToPermissionInputSchema = z.object({
	requestId: z.string().min(1),
	outcome: z.union([
		z.object({
			outcome: z.literal("selected"),
			optionId: z.string().min(1),
		}),
		z.object({
			outcome: z.literal("cancelled"),
		}),
	]),
});

export const environmentRuntimeCommandSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("create_session"),
		requestId: z.string().min(1),
		input: environmentCreateSessionInputSchema,
	}),
	z.object({
		type: z.literal("prompt"),
		requestId: z.string().min(1),
		input: environmentPromptInputSchema,
	}),
	z.object({
		type: z.literal("abort"),
		requestId: z.string().min(1),
		input: environmentAbortInputSchema,
	}),
	z.object({
		type: z.literal("respond_to_permission"),
		requestId: z.string().min(1),
		input: environmentRespondToPermissionInputSchema,
	}),
]);
export type EnvironmentRuntimeCommand = z.infer<
	typeof environmentRuntimeCommandSchema
>;

export type EnvironmentRuntimeSession = Readonly<{
	sessionId: string;
	activeTurnId: string | null;
	agent: string;
	cwd: string;
	model?: string;
	mode?: string;
	configOptions: Readonly<Record<string, string>>;
}>;

export const environmentRuntimeHelloSchema = z.object({
	type: z.literal("hello"),
	runtime: z.literal("sandbox-runtime"),
});
export type EnvironmentRuntimeHello = z.infer<
	typeof environmentRuntimeHelloSchema
>;

export const environmentRuntimeHelloAckSchema = z.object({
	type: z.literal("hello_ack"),
	connectionId: z.string().min(1),
	connectedAt: z.number().int().nonnegative(),
});
export type EnvironmentRuntimeHelloAck = z.infer<
	typeof environmentRuntimeHelloAckSchema
>;

export const environmentRuntimeSubscribeStreamSchema = z.object({
	type: z.literal("subscribe_stream"),
	stream: z.string().min(1),
	offset: environmentStreamOffsetSchema,
});
export type EnvironmentRuntimeSubscribeStream = z.infer<
	typeof environmentRuntimeSubscribeStreamSchema
>;

export type EnvironmentRuntimeCommandResponse =
	| {
			type: "response";
			requestId: string;
			ok: true;
			result:
				| { session: EnvironmentRuntimeSession }
				| { turnId: string }
				| { aborted: boolean }
				| { handled: boolean };
	  }
	| {
			type: "response";
			requestId: string;
			ok: false;
			error: string;
	  };

export const environmentRuntimeCommandResponseSchema = z.discriminatedUnion(
	"ok",
	[
		z.object({
			type: z.literal("response"),
			requestId: z.string().min(1),
			ok: z.literal(true),
			result: z.unknown(),
		}),
		z.object({
			type: z.literal("response"),
			requestId: z.string().min(1),
			ok: z.literal(false),
			error: z.string().min(1),
		}),
	]
);

export type EnvironmentRuntimeStreamItem = {
	offset: EnvironmentStreamOffset;
	eventId: string;
	commandId?: string;
	createdAt: number;
	event: unknown;
};

export const environmentRuntimeStreamItemSchema = z.object({
	offset: environmentStreamOffsetSchema,
	eventId: z.string().min(1),
	commandId: z.string().min(1).optional(),
	createdAt: z.number().int().nonnegative(),
	event: z.unknown(),
});

export type EnvironmentRuntimeStreamItemsMessage = {
	type: "stream_items";
	stream: string;
	items: EnvironmentRuntimeStreamItem[];
	nextOffset: EnvironmentStreamOffset;
	upToDate: boolean;
	streamClosed: boolean;
};

export const environmentRuntimeStreamItemsMessageSchema = z.object({
	type: z.literal("stream_items"),
	stream: z.string().min(1),
	items: z.array(environmentRuntimeStreamItemSchema),
	nextOffset: environmentStreamOffsetSchema,
	upToDate: z.boolean(),
	streamClosed: z.boolean(),
});

export type EnvironmentRuntimeIncomingMessage =
	| EnvironmentRuntimeCommand
	| EnvironmentRuntimeHelloAck
	| EnvironmentRuntimeSubscribeStream;

export type EnvironmentRuntimeOutgoingMessage =
	| EnvironmentRuntimeHello
	| EnvironmentRuntimeCommandResponse
	| EnvironmentRuntimeStreamItemsMessage;
