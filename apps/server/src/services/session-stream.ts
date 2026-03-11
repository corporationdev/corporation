import type { SessionStreamState } from "@corporation/contracts/browser-do";
import type { AuthVariables } from "../auth";
import { createSpaceForwardHeaders, getSpaceStub } from "../space-do/stub";

type StreamReadResult = {
	frames: unknown[];
	nextOffset: number;
	upToDate: boolean;
	streamClosed: boolean;
};

export function getSpaceStubWithAuth(opts: {
	env: Env;
	spaceSlug: string;
	authToken: string;
	jwtPayload: AuthVariables["jwtPayload"];
}) {
	return {
		readSessionStream: async (
			sessionId: string,
			offset: number,
			limit: number | undefined,
			live: boolean,
			timeoutMs: number | undefined
		): Promise<StreamReadResult> => {
			const url = new URL("http://space/internal/session-stream/read");
			url.searchParams.set("sessionId", sessionId);
			url.searchParams.set("offset", String(offset));
			if (typeof limit === "number") {
				url.searchParams.set("limit", String(limit));
			}
			if (typeof timeoutMs === "number") {
				url.searchParams.set("timeoutMs", String(timeoutMs));
			}
			url.searchParams.set("live", String(live));

			const response = await getSpaceStub(opts.env, opts.spaceSlug).fetch(
				new Request(url, {
					headers: createSpaceForwardHeaders({
						spaceSlug: opts.spaceSlug,
						authToken: opts.authToken,
						jwtPayload: opts.jwtPayload,
					}),
				})
			);
			if (!response.ok) {
				throw new Error(`Failed to read session stream (${response.status})`);
			}
			return (await response.json()) as StreamReadResult;
		},
		getSessionStreamState: async (
			sessionId: string
		): Promise<SessionStreamState> => {
			const url = new URL("http://space/internal/session-stream/state");
			url.searchParams.set("sessionId", sessionId);
			const response = await getSpaceStub(opts.env, opts.spaceSlug).fetch(
				new Request(url, {
					headers: createSpaceForwardHeaders({
						spaceSlug: opts.spaceSlug,
						authToken: opts.authToken,
						jwtPayload: opts.jwtPayload,
					}),
				})
			);
			if (!response.ok) {
				throw new Error(
					`Failed to read session stream state (${response.status})`
				);
			}
			return (await response.json()) as SessionStreamState;
		},
	};
}
