import { DurableObject } from "cloudflare:workers";
import type {
	EnvironmentRpcResult,
	EnvironmentStreamConsumer,
	EnvironmentStreamDelivery,
	EnvironmentStreamDeliveryAck,
} from "@corporation/contracts/environment-do";

function okResult<T>(value: T): EnvironmentRpcResult<T> {
	return {
		ok: true,
		value,
	};
}

export class TestStreamConsumerDurableObject
	extends DurableObject
	implements EnvironmentStreamConsumer
{
	private readonly deliveries: EnvironmentStreamDelivery[] = [];
	private ackEnabled = true;

	receiveEnvironmentStreamItems(
		input: EnvironmentStreamDelivery
	): EnvironmentRpcResult<EnvironmentStreamDeliveryAck> {
		this.deliveries.push(input);
		if (!this.ackEnabled) {
			return {
				ok: false,
				error: {
					code: "runtime_request_send_failed",
					message: "Consumer intentionally withheld ack",
				},
			};
		}
		return okResult({
			committedOffset: input.nextOffset,
		});
	}

	getReceivedStreamItems(): EnvironmentRpcResult<{
		deliveries: EnvironmentStreamDelivery[];
	}> {
		return okResult({
			deliveries: [...this.deliveries],
		});
	}

	setAckEnabled(input: { enabled: boolean }): EnvironmentRpcResult<{}> {
		this.ackEnabled = input.enabled;
		return okResult({});
	}
}
