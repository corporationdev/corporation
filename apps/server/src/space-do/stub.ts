import type { JWTPayload } from "../auth";

const SPACE_AUTH_HEADER = "x-space-auth";
const SPACE_SLUG_HEADER = "x-space-slug";

type SpaceAuthState = {
	authToken: string;
	jwtPayload: JWTPayload;
};

type SpaceStub = {
	fetch: (request: Request) => Promise<Response>;
};

export function getSpaceStub(
	env: { SPACE_DO: unknown },
	spaceSlug: string
): SpaceStub {
	return (
		env as unknown as { SPACE_DO: { getByName: (name: string) => SpaceStub } }
	).SPACE_DO.getByName(spaceSlug);
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
