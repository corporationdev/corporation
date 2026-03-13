import type { RuntimeAccessTokenClaims } from "@corporation/contracts/runtime-auth";

const SPACE_RUNTIME_AUTH_HEADER = "x-space-runtime-auth";

type RuntimeAuthState = {
	authToken: string;
	claims: RuntimeAccessTokenClaims;
};

type EnvironmentStub = {
	fetch: (request: Request) => Promise<Response>;
};

export type EnvironmentStubBinding = {
	getByName: (name: string) => EnvironmentStub;
};

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
