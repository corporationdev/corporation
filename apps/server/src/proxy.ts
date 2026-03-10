import { Hono } from "hono";
import { type AuthVariables, authMiddleware } from "./auth";

const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"host",
]);

type ProxyRequestBody = {
	url: string;
	method: string;
	headers?: Record<string, string>;
	bodyBase64?: string;
};

function buildForwardHeaders(
	input: Record<string, string> | undefined
): Headers {
	const headers = new Headers();
	if (!input) {
		return headers;
	}

	for (const [key, value] of Object.entries(input)) {
		if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
			continue;
		}
		headers.set(key, value);
	}

	return headers;
}

function buildResponseHeaders(input: Headers): Headers {
	const headers = new Headers();
	for (const [key, value] of input.entries()) {
		if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
			continue;
		}
		headers.set(key, value);
	}
	return headers;
}

function parseProxyBody(value: unknown): ProxyRequestBody | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const body = value as Record<string, unknown>;
	if (typeof body.url !== "string" || typeof body.method !== "string") {
		return null;
	}

	if (
		body.headers !== undefined &&
		(typeof body.headers !== "object" ||
			body.headers === null ||
			Array.isArray(body.headers))
	) {
		return null;
	}

	if (body.bodyBase64 !== undefined && typeof body.bodyBase64 !== "string") {
		return null;
	}

	return {
		url: body.url,
		method: body.method,
		headers: body.headers as Record<string, string> | undefined,
		bodyBase64: body.bodyBase64,
	};
}

function decodeBase64(value: string): ArrayBuffer {
	const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength
	);
}

export const proxyApp = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
	.use(authMiddleware)
	.post("/", async (c) => {
		console.log("/proxy❤️❤️");
		const parsedBody = parseProxyBody(await c.req.json().catch(() => null));
		console.log("parsed body ❤️❤️❤️", { parsedBody });
		if (!parsedBody) {
			return c.json({ error: "Invalid proxy request body" }, 400);
		}

		let url: URL;
		try {
			url = new URL(parsedBody.url);
		} catch {
			return c.json({ error: "Invalid target URL" }, 400);
		}

		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return c.json({ error: "Only http and https URLs are allowed" }, 400);
		}

		const body =
			parsedBody.bodyBase64 !== undefined
				? decodeBase64(parsedBody.bodyBase64)
				: undefined;
		const headers = buildForwardHeaders(parsedBody.headers);
		const upstreamResponse = await fetch(
			new Request(url.toString(), {
				method: parsedBody.method,
				headers,
				body,
			})
		);

		return new Response(upstreamResponse.body, {
			status: upstreamResponse.status,
			statusText: upstreamResponse.statusText,
			headers: buildResponseHeaders(upstreamResponse.headers),
		});
	});
