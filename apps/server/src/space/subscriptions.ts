import type { SpaceRuntimeContext, SubscriptionHub } from "./types";

export function createSubscriptionHub(): SubscriptionHub {
	return {
		channels: new Map(),
		connToChannels: new Map(),
	};
}

export function clearSubscriptions(hub: SubscriptionHub): void {
	hub.channels.clear();
	hub.connToChannels.clear();
}

export function subscribeToChannel(
	hub: SubscriptionHub,
	channel: string,
	connId: string
): void {
	let channelSubscribers = hub.channels.get(channel);
	if (!channelSubscribers) {
		channelSubscribers = new Set<string>();
		hub.channels.set(channel, channelSubscribers);
	}
	channelSubscribers.add(connId);

	let connectionChannels = hub.connToChannels.get(connId);
	if (!connectionChannels) {
		connectionChannels = new Set<string>();
		hub.connToChannels.set(connId, connectionChannels);
	}
	connectionChannels.add(channel);
}

export function unsubscribeFromChannel(
	hub: SubscriptionHub,
	channel: string,
	connId: string
): void {
	const channelSubscribers = hub.channels.get(channel);
	if (channelSubscribers) {
		channelSubscribers.delete(connId);
		if (channelSubscribers.size === 0) {
			hub.channels.delete(channel);
		}
	}

	const connectionChannels = hub.connToChannels.get(connId);
	if (connectionChannels) {
		connectionChannels.delete(channel);
		if (connectionChannels.size === 0) {
			hub.connToChannels.delete(connId);
		}
	}
}

export function unsubscribeConnection(
	hub: SubscriptionHub,
	connId: string
): void {
	const connectionChannels = hub.connToChannels.get(connId);
	if (!connectionChannels) {
		return;
	}

	for (const channel of connectionChannels) {
		const channelSubscribers = hub.channels.get(channel);
		if (!channelSubscribers) {
			continue;
		}
		channelSubscribers.delete(connId);
		if (channelSubscribers.size === 0) {
			hub.channels.delete(channel);
		}
	}

	hub.connToChannels.delete(connId);
}

export function publishToChannel(
	ctx: Pick<SpaceRuntimeContext, "vars" | "conns">,
	channel: string,
	eventName: string,
	...args: unknown[]
): void {
	const subscribers = ctx.vars.subscriptions.channels.get(channel);
	if (!subscribers) {
		return;
	}

	for (const connId of subscribers) {
		const subscriber = ctx.conns.get(connId);
		subscriber?.send(eventName, ...args);
	}
}
