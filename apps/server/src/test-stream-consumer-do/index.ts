import { DurableObject } from "cloudflare:workers";
import type {
	EnvironmentRpcResult,
	EnvironmentStreamDelivery,
} from "../environment-do";

function okResult<T>(value: T): EnvironmentRpcResult<T> {
	return {
		ok: true,
		value,
	};
}

export class TestStreamConsumerDurableObject extends DurableObject {
	private readonly deliveries: EnvironmentStreamDelivery[] = [];

	receiveEnvironmentStreamItems(
		input: EnvironmentStreamDelivery
	): EnvironmentRpcResult<{}> {
		this.deliveries.push(input);
		return okResult({});
	}

	getReceivedStreamItems(): EnvironmentRpcResult<{
		deliveries: EnvironmentStreamDelivery[];
	}> {
		return okResult({
			deliveries: [...this.deliveries],
		});
	}
}
