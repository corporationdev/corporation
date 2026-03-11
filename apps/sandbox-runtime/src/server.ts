/* global Bun */

import { BunRuntime } from "@effect/platform-bun";
import type { PromptRequestBody } from "@corporation/contracts/sandbox-do";
import { Effect, Exit, Layer, Scope, ServiceMap } from "effect";
import { createApp } from "./app";
import { makeHttpTurnEventCallback } from "./http-turn-event-callback";
import { log } from "./logging";
import { RuntimeActions } from "./runtime-actions";
import { runtimeLayer } from "./runtime-layer";

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 5799;
const DEFAULT_HOST = "0.0.0.0";

function parseArgs(): { host: string; port: number } {
	const args = process.argv.slice(2);
	let host = DEFAULT_HOST;
	let port = DEFAULT_PORT;

	for (let i = 0; i < args.length; i++) {
		const next = args[i + 1];
		if (args[i] === "--host" && next) {
			host = next;
			i++;
		} else if (args[i] === "--port" && next) {
			port = Number.parseInt(next, 10);
			i++;
		}
	}

	return { host, port };
}

const { host, port } = parseArgs();

const main = Effect.scoped(Effect.gen(function* () {
	const scope = yield* Scope.make();
	yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

	const services = yield* Layer.buildWithScope(runtimeLayer, scope);
	const runtimeActions = ServiceMap.get(services, RuntimeActions);

	const run = <A, E>(effect: Effect.Effect<A, E, never>) =>
		Effect.runPromise(effect);
	const app = createApp({
		startTurn: async (
			body: PromptRequestBody
		): Promise<{ error: string } | null> => {
			const callback = await run(
				makeHttpTurnEventCallback({
					turnId: body.turnId,
					sessionId: body.sessionId,
					callbackUrl: body.callbackUrl,
					callbackToken: body.callbackToken,
				})
			);

			return await run(
				runtimeActions
					.startTurn({
						turnId: body.turnId,
						sessionId: body.sessionId,
						agent: body.agent,
						cwd: body.cwd,
						modelId: body.modelId,
						prompt: body.prompt,
						onEvent: callback,
					})
					.pipe(
						Effect.as(null),
						Effect.catchTag("TurnConflictError", (error) =>
							Effect.succeed({ error: error.error })
						)
					)
			);
		},
		cancelTurn: (turnId) => run(runtimeActions.cancelTurn(turnId)),
		probeAgents: (body) => run(runtimeActions.probeAgents(body)),
	});

	const server = Bun.serve({
		hostname: host,
		port,
		fetch: app.fetch,
	});

	yield* Effect.addFinalizer(() =>
		Effect.sync(() => {
			server.stop(true);
		})
	);

	log("info", `Listening on ${host}:${port}`);
	console.log(`[sandbox-runtime] Listening on ${host}:${port}`);

	yield* Effect.never;
}));

BunRuntime.runMain(main);
