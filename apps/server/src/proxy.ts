import { Hono } from "hono";
import { verifyAuthToken } from "./auth";
import {
	proxyViaNango,
	resolveNangoConnectionForHostname,
	type ResolvedNangoConnection,
} from "./nango-proxy";

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

export type ProxyFetch = (request: Request) => Promise<Response>;
export type ProxyAppOptions = {
	proxyFetch?: ProxyFetch;
	resolveUserId?: ResolveUserId;
	resolveNangoConnection?: ResolveNangoConnection;
	proxyViaNango?: ProxyViaNangoFn;
};

type ResolveUserId = (request: Request, env: Env) => Promise<string | null>;
type ResolveNangoConnection = (
	hostname: string,
	userId: string,
	env: Env
) => Promise<ResolvedNangoConnection | null>;
type ProxyViaNangoFn = (input: {
	env: Env;
	targetUrl: URL;
	method: string;
	headers: Headers;
	body?: Uint8Array;
	connection: Pick<ResolvedNangoConnection, "providerConfigKey" | "connectionId">;
}) => Promise<Response>;

function getBearerToken(request: Request): string | null {
	const header = request.headers.get("authorization");
	if (!header) {
		return null;
	}

	const [scheme, token] = header.split(" ");
	if (scheme?.toLowerCase() !== "bearer" || !token) {
		return null;
	}

	return token;
}

async function defaultResolveUserId(
	request: Request,
	env: Env
): Promise<string | null> {
	const token = getBearerToken(request);
	if (!token) {
		return null;
	}

	const payload = await verifyAuthToken(token, env.CONVEX_SITE_URL);
	return payload?.sub ?? null;
}

function buildForwardHeaders(input: Record<string, string> | undefined): Headers {
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

export function createProxyApp(options?: ProxyAppOptions) {
	const proxyFetch = options?.proxyFetch ?? fetch;
	const resolveUserId = options?.resolveUserId ?? defaultResolveUserId;
	const resolveNangoConnection =
		options?.resolveNangoConnection ?? resolveNangoConnectionForHostname;
	const proxyViaNangoRequest = options?.proxyViaNango ?? proxyViaNango;

	return new Hono<{ Bindings: Env }>().post("/http", async (c) => {
		const parsedBody = parseProxyBody(await c.req.json().catch(() => null));
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
				? new Uint8Array(Buffer.from(parsedBody.bodyBase64, "base64"))
				: undefined;
		const headers = buildForwardHeaders(parsedBody.headers);
		const userId = await resolveUserId(c.req.raw, c.env);

		if (userId) {
			const connection = await resolveNangoConnection(url.hostname, userId, c.env);
			if (connection) {
				const proxiedResponse = await proxyViaNangoRequest({
					env: c.env,
					targetUrl: url,
					method: parsedBody.method,
					headers,
					body,
					connection,
				});

				return new Response(proxiedResponse.body, {
					status: proxiedResponse.status,
					statusText: proxiedResponse.statusText,
					headers: buildResponseHeaders(proxiedResponse.headers),
				});
			}
		}

		const upstreamResponse = await proxyFetch(
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
}
