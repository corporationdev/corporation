import type { RuntimeAccessTokenClaims } from "@corporation/contracts/runtime-auth";

const SPACE_RUNTIME_AUTH_HEADER = "x-space-runtime-auth";

type RuntimeAuthState = {
	authToken: string;
	claims: RuntimeAccessTokenClaims;
};

type UserStub = {
	fetch: (request: Request) => Promise<Response>;
};

export type UserStubBinding = {
	getByName: (name: string) => UserStub;
};

export function getUserStub(
	userDo: UserStubBinding,
	userId: string
): UserStub {
	return userDo.getByName(userId);
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
