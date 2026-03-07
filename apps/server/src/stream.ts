import { Hono } from "hono";
import { createClient } from "rivetkit/client";
import { type AuthVariables, authMiddleware } from "./auth";
import type { registry } from "./registry";

function getRivetClient(reqUrl: string) {
	const baseUrl = new URL(reqUrl);
	return createClient<typeof registry>({
		endpoint: `${baseUrl.origin}/api/rivet`,
		disableMetadataLookup: true,
		devtools: false,
	});
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

type SpaceActor = ReturnType<ReturnType<typeof getRivetClient>["space"]["get"]>;

function createSSEStream(opts: {
	spaceActor: SpaceActor;
	sessionId: string;
	initialOffset: number;
	limit: number | undefined;
	timeoutMs: number | undefined;
	signal: AbortSignal;
}): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let offset = opts.initialOffset;

	const formatSSE = (result: StreamReadResult) => {
		let out = `event: data\ndata: ${JSON.stringify(result.frames)}\n\n`;
		out += `event: control\ndata: ${JSON.stringify({
			streamNextOffset: String(result.nextOffset),
			upToDate: result.upToDate,
			streamClosed: result.streamClosed,
		})}\n\n`;
		return out;
	};

	return new ReadableStream({
		async start(controller) {
			const enqueue = (chunk: string) => {
				controller.enqueue(encoder.encode(chunk));
			};

			try {
				while (!opts.signal.aborted) {
					const result = await opts.spaceActor.readSessionStream(
						opts.sessionId,
						offset,
						opts.limit,
						false,
						opts.timeoutMs
					);

					enqueue(formatSSE(result));
					offset = result.nextOffset;

					if (result.streamClosed) {
						break;
					}

					if (result.upToDate) {
						const liveResult = await opts.spaceActor.readSessionStream(
							opts.sessionId,
							offset,
							opts.limit,
							true,
							opts.timeoutMs
						);

						enqueue(formatSSE(liveResult));
						offset = liveResult.nextOffset;

						if (liveResult.streamClosed) {
							break;
						}
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
		const client = getRivetClient(c.req.url);
		try {
			const state = await client.space
				.get([spaceSlug])
				.getSessionStreamState(sessionId);
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
		const offsetRaw = c.req.query("offset");
		const parsedOffset = parseOffset(offsetRaw);
		if (!Number.isFinite(parsedOffset)) {
			return c.json({ error: "Invalid offset query parameter" }, 400);
		}

		const client = getRivetClient(c.req.url);
		const limit = parseLimit(c.req.query("limit"));
		const timeoutMs = parseLimit(c.req.query("timeoutMs"));

		try {
			let offset = parsedOffset;
			if (offset === Number.MAX_SAFE_INTEGER) {
				const state = await client.space
					.get([spaceSlug])
					.getSessionStreamState(sessionId);
				offset = state.lastOffset;
			}

			const stream = createSSEStream({
				spaceActor: client.space.get([spaceSlug]),
				sessionId,
				initialOffset: offset,
				limit,
				timeoutMs,
				signal: c.req.raw.signal,
			});

			return new Response(stream, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-store",
					"X-Accel-Buffering": "no",
				},
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
