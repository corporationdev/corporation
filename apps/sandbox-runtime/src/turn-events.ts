import type {
	PromptRequestBody,
	SessionEvent,
	TurnRunnerError,
} from "@corporation/contracts/sandbox-do";
import type { CallbackDeliveryError } from "./errors";

export type StartTurnRequest = {
	turnId: string;
	sessionId: string;
	agent: string;
	cwd: string;
	modelId?: string;
	prompt: PromptRequestBody["prompt"];
	onEvent: TurnEventCallback;
};

export type RuntimeTurnEvent =
	| { _tag: "SessionEvent"; event: SessionEvent }
	| { _tag: "Completed" }
	| { _tag: "Failed"; error: TurnRunnerError };

export type TurnEventCallback = (
	event: RuntimeTurnEvent
) => import("effect").Effect.Effect<void, CallbackDeliveryError>;
