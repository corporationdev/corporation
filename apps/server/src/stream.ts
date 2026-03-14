import { Hono } from "hono";
import { type AuthVariables, authMiddleware } from "./auth";
import { getSpaceStubWithAuth } from "./services/session-stream";

function getBearerToken(authHeader: string | undefined): string | null {
	if (!authHeader?.startsWith("Bearer ")) {
		return null;
	}

	const token = authHeader.slice("Bearer ".length).trim();
	return token || null;
}

function parseOffset(raw: string | undefined): number {
	if (raw === undefined || raw === "-1") {
		return -1;
	}
	if (raw === "now") {
		return Number.MAX_SAFE_INTEGER;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function parseLimit(raw: string | undefined): number | undefined {
	if (!raw) {
		return undefined;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

type StreamReadResult = {
	frames: unknown[];
	nextOffset: number;
	upToDate: boolean;
	streamClosed: boolean;
};

function buildControlEvent(result: StreamReadResult): string {
	return JSON.stringify({
		streamNextOffset: String(result.nextOffset),
		...(result.streamClosed
			? { streamClosed: true }
			: { streamCursor: String(result.nextOffset) }),
		...(result.upToDate ? { upToDate: true } : {}),
	});
}

function buildInitialSSEHeaders(result: StreamReadResult): HeadersInit {
	return {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-store",
		"X-Accel-Buffering": "no",
		"Stream-Next-Offset": String(result.nextOffset),
		...(result.streamClosed
			? { "Stream-Closed": "true" }
			: { "Stream-Cursor": String(result.nextOffset) }),
		...(result.upToDate ? { "Stream-Up-To-Date": "true" } : {}),
	};
}

function createSSEStream(opts: {
	spaceActor: ReturnType<typeof getSpaceStubWithAuth>;
	sessionId: string;
	initialResult: StreamReadResult;
	limit: number | undefined;
	timeoutMs: number | undefined;
	signal: AbortSignal;
}): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let offset = opts.initialResult.nextOffset;

	const formatSSE = (result: StreamReadResult) => {
		let out = "";
		if (result.frames.length > 0) {
			out += `event: data\ndata: ${JSON.stringify(result.frames)}\n\n`;
		}
		out += `event: control\ndata: ${buildControlEvent(result)}\n\n`;
		return out;
	};

	return new ReadableStream({
		async start(controller) {
			const enqueue = (chunk: string) => {
				controller.enqueue(encoder.encode(chunk));
			};
			let nextResult: StreamReadResult | null = opts.initialResult;

			try {
				while (!opts.signal.aborted) {
					const result =
						nextResult ??
						(await opts.spaceActor.readSessionStream(
							opts.sessionId,
							offset,
							opts.limit,
							false,
							opts.timeoutMs
						));
					nextResult = null;

					enqueue(formatSSE(result));
					offset = result.nextOffset;

					if (result.streamClosed) {
						break;
					}

					if (result.upToDate) {
						nextResult = await opts.spaceActor.readSessionStream(
							opts.sessionId,
							offset,
							opts.limit,
							true,
							opts.timeoutMs
						);
					}
				}
			} catch {
				// Client disconnected or error
			} finally {
				try {
					controller.close();
				} catch {
					// Already closed
				}
			}
		},
	});
}

export const streamApp = new Hono<{
	Bindings: Env;
	Variables: AuthVariables;
}>()
	.use(authMiddleware)
	.get("/:spaceSlug/sessions/:sessionId/state", async (c) => {
		const { spaceSlug, sessionId } = c.req.param();
		const authToken = getBearerToken(c.req.header("authorization"));
		if (!authToken) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		const spaceActor = getSpaceStubWithAuth({
			env: c.env,
			spaceSlug,
		});
		try {
			const state = await spaceActor.getSessionStreamState(sessionId);
			return c.json(state);
		} catch (error) {
			console.error("session-stream.state-failed", {
				spaceSlug,
				sessionId,
				error,
			});
			return c.json({ error: "Session not found" }, 404);
		}
	})
	.get("/:spaceSlug/sessions/:sessionId/stream", async (c) => {
		const { spaceSlug, sessionId } = c.req.param();
		const authToken = getBearerToken(c.req.header("authorization"));
		if (!authToken) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		const offsetRaw = c.req.query("offset");
		const parsedOffset = parseOffset(offsetRaw);
		if (!Number.isFinite(parsedOffset)) {
			return c.json({ error: "Invalid offset query parameter" }, 400);
		}

		const spaceActor = getSpaceStubWithAuth({
			env: c.env,
			spaceSlug,
		});
		const limit = parseLimit(c.req.query("limit"));
		const timeoutMs = parseLimit(c.req.query("timeoutMs"));

		try {
			let offset = parsedOffset;
			if (offset === Number.MAX_SAFE_INTEGER) {
				const state = await spaceActor.getSessionStreamState(sessionId);
				offset = state.lastOffset;
			}
			const initialResult = await spaceActor.readSessionStream(
				sessionId,
				offset,
				limit,
				false,
				timeoutMs
			);

			const stream = createSSEStream({
				spaceActor,
				sessionId,
				initialResult,
				limit,
				timeoutMs,
				signal: c.req.raw.signal,
			});

			return new Response(stream, {
				headers: buildInitialSSEHeaders(initialResult),
			});
		} catch (error) {
			console.error("session-stream.read-failed", {
				spaceSlug,
				sessionId,
				offset: parsedOffset,
				error,
			});
			return c.json({ error: "Session not found" }, 404);
		}
	});
