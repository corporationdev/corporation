/* global Bun */

import { BunRuntime } from "@effect/platform-bun";
import { Effect, Exit, Layer, Scope } from "effect";
import { log } from "./logging";
import { runtimeLayer } from "./runtime-layer";

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

const main: Effect.Effect<void, Error, never> = Effect.scoped(
	Effect.gen(function* () {
		const scope = yield* Scope.make();
		yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

		yield* Layer.buildWithScope(runtimeLayer, scope);

		const server = Bun.serve({
			hostname: host,
			port,
			fetch: (request) => {
				const url = new URL(request.url);
				if (url.pathname === "/health") {
					return Response.json({ status: "ok" as const });
				}
				return new Response("Not found", { status: 404 });
			},
		});

		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				server.stop(true);
			})
		);

		log("info", `Listening on ${host}:${port}`);
		console.log(`[sandbox-runtime] Listening on ${host}:${port}`);

		yield* Effect.promise(() => new Promise<never>(() => undefined));
	})
);

BunRuntime.runMain(main);
