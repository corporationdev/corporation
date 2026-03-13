import type {
	EnvironmentRpcResult,
	EnvironmentStreamSubscriptionSnapshot,
	EnvironmentStreamSubscriptionState,
	EnvironmentSubscribeStreamInput,
	EnvironmentUnsubscribeStreamInput,
} from "./types";
import { errorResult, okResult } from "./types";

export class StreamSubscriptions {
	private readonly subscriptions = new Map<
		string,
		EnvironmentStreamSubscriptionState
	>();

	clear(): void {
		this.subscriptions.clear();
	}

	hydrate(
		subscriptions: Array<{
			stream: string;
			subscription: EnvironmentStreamSubscriptionState;
		}>
	): void {
		this.subscriptions.clear();
		for (const entry of subscriptions) {
			this.subscriptions.set(entry.stream, entry.subscription);
		}
	}

	get(stream: string): EnvironmentStreamSubscriptionState | null {
		return this.subscriptions.get(stream) ?? null;
	}

	list(): Array<{
		stream: string;
		subscription: EnvironmentStreamSubscriptionState;
	}> {
		return [...this.subscriptions.entries()].map(([stream, subscription]) => ({
			stream,
			subscription,
		}));
	}

	getSnapshot(): EnvironmentStreamSubscriptionSnapshot[] {
		return [...this.subscriptions.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([stream, subscription]) => ({
				stream,
				requesterId: subscription.subscriber.requesterId,
				callbackBinding: subscription.subscriber.callback.binding,
				callbackName: subscription.subscriber.callback.name,
			}));
	}

	subscribe(input: {
		activeRuntimeConnected: boolean;
		forwardToRuntime: (input: {
			offset: EnvironmentSubscribeStreamInput["offset"];
			stream: string;
		}) => void;
		subscription: EnvironmentSubscribeStreamInput;
	}): EnvironmentRpcResult<{}> {
		if (!input.activeRuntimeConnected) {
			return errorResult("runtime_not_connected", "Runtime is not connected");
		}

		input.forwardToRuntime({
			stream: input.subscription.stream,
			offset: input.subscription.offset,
		});
		this.subscriptions.set(input.subscription.stream, {
			offset: input.subscription.offset,
			subscriber: input.subscription.subscriber,
		});
		return okResult({});
	}

	unsubscribe(input: EnvironmentUnsubscribeStreamInput): EnvironmentRpcResult<{}> {
		this.subscriptions.delete(input.stream);
		return okResult({});
	}
}
