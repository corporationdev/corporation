import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { AcpBridgeFactoryLive } from "./acp-bridge";
import { ProbeServiceLive } from "./probe-service";
import { ensureLocalProxyStarted } from "./proxy";
import { RuntimeActionsLive } from "./runtime-actions";
import { SessionRegistryLive } from "./session-registry";

const localProxyLayer = Layer.effectDiscard(
	Effect.tryPromise({
		try: () => ensureLocalProxyStarted(),
		catch: (cause) =>
			new Error(
				`Failed to start local proxy: ${
					cause instanceof Error ? cause.message : String(cause)
				}`
			),
	})
);

const foundationLayer = Layer.mergeAll(
	BunServices.layer,
	localProxyLayer,
	AcpBridgeFactoryLive
);

const sessionRegistryLayer = SessionRegistryLive.pipe(
	Layer.provide(foundationLayer)
);

const baseLayer = Layer.mergeAll(foundationLayer, sessionRegistryLayer);

const probeLayer = ProbeServiceLive.pipe(Layer.provide(baseLayer));

export const runtimeLayer = Layer.mergeAll(
	baseLayer,
	probeLayer,
	RuntimeActionsLive.pipe(Layer.provide(Layer.mergeAll(baseLayer, probeLayer)))
);
