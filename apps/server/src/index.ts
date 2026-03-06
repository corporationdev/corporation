import { createHandler } from "@rivetkit/cloudflare-workers";
import { app } from "./app";
import { registry } from "./registry";

const { handler, ActorHandler } = createHandler(registry, {
	fetch: app.fetch,
});
const baseFetch = handler.fetch;

function isRivetManagerPath(pathname: string): boolean {
	return pathname.startsWith("/api/rivet");
}

function setRivetCorsHeaders(
	headers: Headers,
	origin: string,
	allowHeaders?: string | null
): void {
	headers.set("Access-Control-Allow-Origin", origin);
	headers.set("Access-Control-Allow-Credentials", "true");
	headers.set(
		"Access-Control-Allow-Methods",
		"GET, POST, PUT, PATCH, DELETE, OPTIONS"
	);
	headers.set(
		"Access-Control-Allow-Headers",
		allowHeaders ?? "Authorization, Content-Type"
	);
	headers.append("Vary", "Origin");
	headers.append("Vary", "Access-Control-Request-Headers");
}

const wrappedHandler: ExportedHandler<Env> = {
	fetch: async (request, env, ctx) => {
		const url = new URL(request.url);
		const isRivetRequest = isRivetManagerPath(url.pathname);
		const origin = request.headers.get("origin");

		if (isRivetRequest && request.method === "OPTIONS" && origin) {
			const headers = new Headers();
			setRivetCorsHeaders(
				headers,
				origin,
				request.headers.get("Access-Control-Request-Headers")
			);
			headers.set("Access-Control-Max-Age", "86400");
			return new Response(null, { status: 204, headers });
		}

		if (!baseFetch) {
			throw new Error("Rivet handler fetch is not configured");
		}
		const response = await baseFetch(request, env, ctx);
		if (!(isRivetRequest && origin)) {
			return response;
		}

		try {
			setRivetCorsHeaders(
				response.headers,
				origin,
				request.headers.get("Access-Control-Request-Headers")
			);
			return response;
		} catch {
			// Preserve WebSocket upgrade responses without cloning.
			if (response.status === 101) {
				return response;
			}
			const headers = new Headers(response.headers);
			setRivetCorsHeaders(
				headers,
				origin,
				request.headers.get("Access-Control-Request-Headers")
			);
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		}
	},
};

export { ActorHandler };
export default wrappedHandler;
