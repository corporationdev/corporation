import { mkdirSync, writeFileSync } from "node:fs";
import type { workerHttpContract } from "@corporation/contracts/orpc/worker-http";
import {
	type RuntimeAuthSessionResponse,
	runtimeAuthSessionResponseSchema,
} from "@corporation/contracts/runtime-auth";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { Effect, Layer, Ref, ServiceMap } from "effect";
import { toRuntimeAuthError } from "./errors";
import { log } from "./logging";
import { getLocalProxyConfig } from "./proxy-config";

const REFRESH_SKEW_MS = 60_000;
const MIN_REFRESH_DELAY_MS = 5000;

type AuthState = {
	session: RuntimeAuthSessionResponse | null;
	inFlight: Promise<RuntimeAuthSessionResponse> | null;
};

type RuntimeAuthStateShape = {
	getSession: () => Effect.Effect<
		RuntimeAuthSessionResponse,
		import("./errors").RuntimeAuthError
	>;
	refreshSession: () => Effect.Effect<
		RuntimeAuthSessionResponse,
		import("./errors").RuntimeAuthError
	>;
	getAccessToken: () => Effect.Effect<
		string,
		import("./errors").RuntimeAuthError
	>;
};

export class RuntimeAuthState extends ServiceMap.Service<
	RuntimeAuthState,
	RuntimeAuthStateShape
>()("sandbox-runtime/RuntimeAuthState") {}

function requireEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`Missing required env var: ${name}`);
	}
	return value;
}

function persistProxyAccessToken(token: string) {
	try {
		const proxyConfig = getLocalProxyConfig(process.env);
		mkdirSync(proxyConfig.stateDir, { recursive: true });
		writeFileSync(proxyConfig.workerTokenPath, token);
	} catch (error) {
		console.error("Failed to persist proxy auth token", error);
	}
}

function createWorkerHttpClient(
	serverUrl: string
): ContractRouterClient<typeof workerHttpContract> {
	return createORPCClient(
		new RPCLink({
			url: new URL("/api/rpc", serverUrl).toString(),
		})
	);
}

async function requestRuntimeSession(): Promise<RuntimeAuthSessionResponse> {
	const serverUrl = requireEnv("CORPORATION_SERVER_URL");
	const spaceSlug = requireEnv("CORPORATION_SPACE_SLUG");
	const refreshToken = requireEnv("CORPORATION_RUNTIME_REFRESH_TOKEN");
	const client = createWorkerHttpClient(serverUrl);

	const parsed = runtimeAuthSessionResponseSchema.safeParse(
		await client.runtimeAuth.createSession(
			{
				spaceSlug,
				refreshToken,
			},
			{
				signal: AbortSignal.timeout(15_000),
			}
		)
	);
	if (!parsed.success) {
		throw new Error(
			`Invalid runtime auth session response: ${parsed.error.message}`
		);
	}
	persistProxyAccessToken(parsed.data.accessToken);
	return parsed.data;
}

function isSessionFresh(session: RuntimeAuthSessionResponse | null): boolean {
	return !!session && session.expiresAt - Date.now() > REFRESH_SKEW_MS;
}

export const RuntimeAuthStateLive = Layer.effect(RuntimeAuthState)(
	Effect.gen(function* () {
		const stateRef = yield* Ref.make<AuthState>({
			session: null,
			inFlight: null,
		});

		const refreshInternal = (force: boolean) =>
			Effect.tryPromise({
				try: async () => {
					const current = await Effect.runPromise(Ref.get(stateRef));
					if (!force && isSessionFresh(current.session)) {
						return current.session as RuntimeAuthSessionResponse;
					}
					if (current.inFlight) {
						return await current.inFlight;
					}

					const promise = requestRuntimeSession();
					await Effect.runPromise(
						Ref.update(stateRef, (state) => ({
							...state,
							inFlight: promise,
						}))
					);

					try {
						const session = await promise;
						await Effect.runPromise(
							Ref.update(stateRef, () => ({
								session,
								inFlight: null,
							}))
						);
						return session;
					} catch (error) {
						await Effect.runPromise(
							Ref.update(stateRef, (state) => ({
								...state,
								inFlight: null,
							}))
						);
						throw error;
					}
				},
				catch: (cause) =>
					toRuntimeAuthError("Failed to refresh runtime auth session", cause),
			});

		const service: RuntimeAuthStateShape = {
			getSession: () => refreshInternal(false),
			refreshSession: () => refreshInternal(true),
			getAccessToken: () =>
				refreshInternal(false).pipe(
					Effect.map((session) => session.accessToken)
				),
		};

		const refreshLoop = Effect.forever(
			Effect.gen(function* () {
				const session = yield* service.getSession();
				const delayMs = Math.max(
					MIN_REFRESH_DELAY_MS,
					session.expiresAt - Date.now() - REFRESH_SKEW_MS
				);
				yield* Effect.sleep(delayMs);
				yield* service.refreshSession().pipe(
					Effect.catchIf(
						(_error): _error is import("./errors").RuntimeAuthError => true,
						(error) => {
							log(
								"error",
								"Failed to proactively refresh runtime auth session",
								{
									error,
								}
							);
							return Effect.void;
						}
					)
				);
			})
		);

		yield* Effect.forkScoped(refreshLoop);
		return service;
	})
);
