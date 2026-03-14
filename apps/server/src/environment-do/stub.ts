import type { RuntimeAccessTokenClaims } from "@corporation/contracts/runtime-auth";
import type { EnvironmentDurableObject } from "./index";

const SPACE_RUNTIME_AUTH_HEADER = "x-space-runtime-auth";

type RuntimeAuthState = {
	authToken: string;
	claims: RuntimeAccessTokenClaims;
};

export type EnvironmentStubBinding =
	DurableObjectNamespace<EnvironmentDurableObject>;

export type EnvironmentStub = ReturnType<EnvironmentStubBinding["getByName"]>;

export function getEnvironmentStub(
	environmentDo: EnvironmentStubBinding,
	environmentKey: string
): EnvironmentStub {
	return environmentDo.getByName(environmentKey);
}

export function createRuntimeForwardHeaders(opts: {
	authToken: string;
	claims: RuntimeAccessTokenClaims;
	headers?: HeadersInit;
}): Headers {
	const headers = new Headers(opts.headers);
	headers.set(
		SPACE_RUNTIME_AUTH_HEADER,
		JSON.stringify({
			authToken: opts.authToken,
			claims: opts.claims,
		} satisfies RuntimeAuthState)
	);
	return headers;
}
