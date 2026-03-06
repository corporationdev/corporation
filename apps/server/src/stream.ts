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
		const liveParam = c.req.query("live");
		const live = liveParam === "long-poll" || liveParam === "sse";
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

			const result = await client.space
				.get([spaceSlug])
				.readSessionStream(sessionId, offset, limit, live, timeoutMs);

			c.header("Cache-Control", "no-store");
			c.header("Stream-Next-Offset", String(result.nextOffset));
			if (result.upToDate) {
				c.header("Stream-Up-To-Date", "true");
			}
			if (result.streamClosed) {
				c.header("Stream-Closed", "true");
			}

			return c.json(result.frames);
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
