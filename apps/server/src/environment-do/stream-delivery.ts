import type {
	EnvironmentDoCallbackBindings,
	EnvironmentStreamSubscriptionState,
	RuntimeStreamItemsMessage,
	StreamConsumerStub,
} from "./types";

type StreamDeliveryLogger = {
	warn(bindings: Record<string, unknown>, message: string): void;
};

function getStreamConsumerStub(
	bindings: EnvironmentDoCallbackBindings,
	subscription: EnvironmentStreamSubscriptionState
): StreamConsumerStub | null {
	const binding = bindings[subscription.subscriber.callback.binding];
	if (!binding) {
		return null;
	}
	return binding.getByName(subscription.subscriber.callback.name);
}

export async function forwardStreamItemsToSubscriber(input: {
	actorId: string;
	bindings: EnvironmentDoCallbackBindings;
	log: StreamDeliveryLogger;
	message: RuntimeStreamItemsMessage;
	subscription: EnvironmentStreamSubscriptionState | null;
}): Promise<void> {
	if (!input.subscription) {
		return;
	}

	const consumer = getStreamConsumerStub(input.bindings, input.subscription);
	if (!consumer) {
		input.log.warn(
			{
				actorId: input.actorId,
				binding: input.subscription.subscriber.callback.binding,
				requesterId: input.subscription.subscriber.requesterId,
				stream: input.message.stream,
			},
			"missing stream consumer binding"
		);
		return;
	}

	const result = await consumer.receiveEnvironmentStreamItems({
		stream: input.message.stream,
		requesterId: input.subscription.subscriber.requesterId,
		items: input.message.items,
		nextOffset: input.message.nextOffset,
		upToDate: input.message.upToDate,
		streamClosed: input.message.streamClosed,
	});

	if (!result.ok) {
		input.log.warn(
			{
				actorId: input.actorId,
				error: result.error,
				requesterId: input.subscription.subscriber.requesterId,
				stream: input.message.stream,
			},
			"stream consumer rejected stream items"
		);
	}
}
