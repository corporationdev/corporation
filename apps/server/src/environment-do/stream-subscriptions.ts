import type {
	EnvironmentRpcResult,
	EnvironmentStreamSubscriber,
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

	get(stream: string): EnvironmentStreamSubscriptionState | null {
		return this.subscriptions.get(stream) ?? null;
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

		const existingSubscription = this.subscriptions.get(input.subscription.stream);
		if (
			existingSubscription &&
			this.isSameSubscriber(
				existingSubscription.subscriber,
				input.subscription.subscriber
			)
		) {
			this.subscriptions.set(input.subscription.stream, {
				offset: input.subscription.offset,
				subscriber: input.subscription.subscriber,
			});
			return okResult({});
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

	private isSameSubscriber(
		left: EnvironmentStreamSubscriber,
		right: EnvironmentStreamSubscriber
	): boolean {
		return (
			left.requesterId === right.requesterId &&
			left.callback.binding === right.callback.binding &&
			left.callback.name === right.callback.name
		);
	}
}
