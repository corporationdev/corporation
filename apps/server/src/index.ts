import { createHandler } from "@rivetkit/cloudflare-workers";
import { app } from "./app";
import { registry } from "./registry";

const { handler, ActorHandler } = createHandler(registry, {
	fetch: app.fetch,
});

function applyRivetCorsHeaders(
	headers: Headers,
	origin: string,
	requestHeaders: string | null
): void {
	headers.set("Access-Control-Allow-Origin", origin);
	headers.set("Access-Control-Allow-Credentials", "true");
	headers.set(
		"Access-Control-Allow-Methods",
		"GET,POST,PUT,PATCH,DELETE,OPTIONS"
	);
	headers.set(
		"Access-Control-Allow-Headers",
		requestHeaders ?? "Authorization, Content-Type"
	);
	headers.set("Vary", "Origin, Access-Control-Request-Headers");
}

const wrappedHandler: ExportedHandler<Env> = {
	fetch: async (request, env, ctx) => {
		const isRivetRequest = new URL(request.url).pathname.startsWith(
			"/api/rivet"
		);
		const fetchFn = handler.fetch;
		if (!fetchFn) {
			throw new Error("Rivet handler fetch is not configured");
		}
		if (!isRivetRequest) {
			return fetchFn(request, env, ctx);
		}

		const origin = request.headers.get("origin");
		const requestHeaders = request.headers.get(
			"Access-Control-Request-Headers"
		);

		if (request.method === "OPTIONS" && origin) {
			const headers = new Headers();
			applyRivetCorsHeaders(headers, origin, requestHeaders);
			headers.set("Access-Control-Max-Age", "86400");
			return new Response(null, { status: 204, headers });
		}

		const response = await fetchFn(request, env, ctx);
		if (!origin || response.status === 101) {
			return response;
		}

		const headers = new Headers(response.headers);
		applyRivetCorsHeaders(headers, origin, requestHeaders);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	},
};

export { ActorHandler };
export default wrappedHandler;
