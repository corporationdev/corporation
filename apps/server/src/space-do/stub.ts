import type { RuntimeAccessTokenClaims } from "@tendril/contracts/runtime-auth";
import type { JWTPayload } from "../auth";
import type { SpaceDurableObject } from "./object";

const SPACE_AUTH_HEADER = "x-space-auth";
const SPACE_SLUG_HEADER = "x-space-slug";
const SPACE_RUNTIME_AUTH_HEADER = "x-space-runtime-auth";

type SpaceAuthState = {
	authToken: string;
	jwtPayload: JWTPayload;
};

type RuntimeAuthState = {
	authToken: string;
	claims: RuntimeAccessTokenClaims;
};

export type SpaceStubBinding = DurableObjectNamespace<SpaceDurableObject>;

export type SpaceStub = ReturnType<SpaceStubBinding["getByName"]>;

export function getSpaceStub(
	env: { SPACE_DO: unknown },
	spaceSlug: string
): SpaceStub {
	return (env as unknown as { SPACE_DO: SpaceStubBinding }).SPACE_DO.getByName(
		spaceSlug
	);
}

export function createSpaceForwardHeaders(opts: {
	spaceSlug: string;
	authToken: string;
	jwtPayload: JWTPayload;
	headers?: HeadersInit;
}): Headers {
	const headers = new Headers(opts.headers);
	headers.set(
		SPACE_AUTH_HEADER,
		JSON.stringify({
			authToken: opts.authToken,
			jwtPayload: opts.jwtPayload,
		} satisfies SpaceAuthState)
	);
	headers.set(SPACE_SLUG_HEADER, opts.spaceSlug);
	return headers;
}

export function createRuntimeForwardHeaders(opts: {
	spaceSlug: string;
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
	headers.set(SPACE_SLUG_HEADER, opts.spaceSlug);
	return headers;
}
