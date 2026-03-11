import { resolveProxyIntegrationForUrl } from "@corporation/config/proxy-integrations";
import { verifyRuntimeAccessToken } from "@corporation/contracts/runtime-auth";
import { Nango } from "@nangohq/node";
import { Hono } from "hono";
import { z } from "zod";
import { verifyAuthToken } from "./auth";

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
	method: NangoProxyMethod;
	headers?: Record<string, string>;
	bodyBase64?: string;
};

type AuthVariables = {
	userId: string;
};

type ResponseHeadersInput = Headers | Record<string, unknown>;

type NangoProxyMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const proxyRequestBodySchema = z.object({
	url: z.url("Proxy request target URL must be a valid URL").refine((value) => {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	}, "Proxy request target URL must use http or https"),
	method: z
		.string({
			error: "Proxy request must include an HTTP method",
		})
		.transform((value) => value.toUpperCase())
		.pipe(
			z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"], {
				error: () => ({
					message:
						"Proxy request method must be one of GET, POST, PUT, PATCH, or DELETE",
				}),
			})
		),
	headers: z.record(z.string(), z.string()).optional(),
	bodyBase64: z.string().optional(),
});

function buildForwardHeaders(
	input: Record<string, string> | undefined
): Record<string, string> {
	const headers: Record<string, string> = {};
	if (!input) {
		return headers;
	}

	for (const [key, value] of Object.entries(input)) {
		const normalizedKey = key.toLowerCase();
		if (
			HOP_BY_HOP_HEADERS.has(normalizedKey) ||
			normalizedKey === "authorization"
		) {
			continue;
		}
		headers[key] = value;
	}

	return headers;
}

function buildResponseHeaders(input: ResponseHeadersInput): Headers {
	const headers = new Headers();

	if (input instanceof Headers) {
		for (const [key, value] of input.entries()) {
			if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
				continue;
			}
			headers.set(key, value);
		}
		return headers;
	}

	for (const [key, value] of Object.entries(input)) {
		if (value === undefined || HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
			continue;
		}
		headers.set(
			key,
			Array.isArray(value)
				? value.map((item) => String(item)).join(", ")
				: String(value)
		);
	}

	return headers;
}

function isNangoHttpErrorWithResponse(error: unknown): error is {
	response: {
		status: number;
		statusText: string;
		headers: Record<string, string | string[] | undefined>;
		data: Uint8Array | ArrayBuffer | string | null;
	};
} {
	if (!error || typeof error !== "object") {
		return false;
	}

	const candidate = error as Record<string, unknown>;
	return (
		typeof candidate.response === "object" &&
		candidate.response !== null &&
		typeof (candidate.response as { status?: unknown }).status === "number"
	);
}

function toResponseBody(
	value: Uint8Array | ArrayBuffer | string | null | undefined
): BodyInit | null {
	if (value == null) {
		return null;
	}
	if (typeof value === "string") {
		return value;
	}
	if (value instanceof Uint8Array) {
		const copy = new Uint8Array(value.byteLength);
		copy.set(value);
		return copy.buffer;
	}
	return value;
}

export const proxyApp = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
	.use(async (c, next) => {
		const authHeader = c.req.header("authorization");
		if (!authHeader?.startsWith("Bearer ")) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		const token = authHeader.slice("Bearer ".length).trim();
		if (!token) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		const browserPayload = await verifyAuthToken(
			token,
			c.env.CORPORATION_CONVEX_SITE_URL
		);
		if (browserPayload) {
			c.set("userId", browserPayload.sub);
			return await next();
		}

		const runtimeSecret = c.env.CORPORATION_RUNTIME_AUTH_SECRET?.trim();
		if (!runtimeSecret) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		const runtimePayload = await verifyRuntimeAccessToken(token, runtimeSecret);
		if (!runtimePayload) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		c.set("userId", runtimePayload.sub);
		return await next();
	})
	.post("/", async (c) => {
		const bodyResult = proxyRequestBodySchema.safeParse(
			await c.req.json().catch(() => null)
		);
		if (!bodyResult.success) {
			return c.json(
				{
					error: bodyResult.error.issues
						.map((issue) =>
							issue.path.length > 0
								? `${issue.path.join(".")}: ${issue.message}`
								: issue.message
						)
						.join("; "),
				},
				400
			);
		}
		const parsedBody: ProxyRequestBody = bodyResult.data;

		const url = new URL(parsedBody.url);

		const integration = resolveProxyIntegrationForUrl(url);
		if (!integration) {
			return c.json({ error: "No matching proxy integration for URL" }, 400);
		}

		const userId = c.get("userId");
		const nango = new Nango({ secretKey: c.env.NANGO_SECRET_KEY });
		const { connections } = await nango.listConnections({
			userId,
			integrationId: integration.integrationId,
		});
		const matchingConnections = connections.filter(
			(connection) =>
				connection.provider_config_key === integration.integrationId
		);
		const connection =
			[...matchingConnections].sort((a, b) => {
				const createdAtA = Date.parse(a.created);
				const createdAtB = Date.parse(b.created);
				const sortableCreatedAtA = Number.isFinite(createdAtA) ? createdAtA : 0;
				const sortableCreatedAtB = Number.isFinite(createdAtB) ? createdAtB : 0;
				return sortableCreatedAtB - sortableCreatedAtA;
			})[0] ?? null;

		if (!connection) {
			return c.json(
				{
					error: `No ${integration.integrationId} connection found for this user`,
				},
				401
			);
		}

		const requestData =
			parsedBody.bodyBase64 !== undefined
				? Uint8Array.from(atob(parsedBody.bodyBase64), (char) =>
						char.charCodeAt(0)
					)
				: undefined;

		try {
			const upstreamResponse = await nango.proxy({
				connectionId: connection.connection_id,
				providerConfigKey: integration.integrationId,
				method: parsedBody.method,
				endpoint: `${url.pathname}${url.search}` || "/",
				baseUrlOverride: `${url.protocol}//${url.host}`,
				headers: buildForwardHeaders(parsedBody.headers),
				data: requestData,
				responseType: "arraybuffer",
			});

			return new Response(toResponseBody(upstreamResponse.data), {
				status: upstreamResponse.status,
				statusText: upstreamResponse.statusText,
				headers: buildResponseHeaders(upstreamResponse.headers),
			});
		} catch (error) {
			if (isNangoHttpErrorWithResponse(error)) {
				return new Response(toResponseBody(error.response.data), {
					status: error.response.status,
					statusText: error.response.statusText,
					headers: buildResponseHeaders(error.response.headers),
				});
			}

			throw error;
		}
	});
