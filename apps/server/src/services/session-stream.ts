import type { SessionStreamState } from "@corporation/contracts/browser-do";
import { getSpaceStub } from "../space-do/stub";

type StreamReadResult = {
	frames: unknown[];
	nextOffset: number;
	upToDate: boolean;
	streamClosed: boolean;
};

export function getSpaceStubWithAuth(opts: { env: Env; spaceSlug: string }) {
	const stub = getSpaceStub(opts.env, opts.spaceSlug);

	return {
		readSessionStream: async (
			sessionId: string,
			offset: number,
			limit: number | undefined,
			live: boolean,
			timeoutMs: number | undefined
		): Promise<StreamReadResult> => {
			return await stub.readSessionStream(
				sessionId,
				offset,
				limit,
				live,
				timeoutMs
			);
		},
		getSessionStreamState: async (
			sessionId: string
		): Promise<SessionStreamState> =>
			await stub.getSessionStreamState(sessionId),
	};
}
