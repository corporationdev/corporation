import { verifyRuntimeAccessToken } from "@corporation/contracts/runtime-auth";
import { app } from "./app";
import { verifyAuthToken } from "./auth";
import { SpaceDurableObject as RawSpaceDurableObject } from "./space-do/object";
import {
	createRuntimeForwardHeaders,
	createSpaceForwardHeaders,
	getSpaceStub,
} from "./space-do/stub";

const SPACE_SOCKET_PATH_RE = /^\/api\/spaces\/([^/]+)\/socket$/;
const RUNTIME_SPACE_SOCKET_PATH_RE =
	/^\/api\/spaces\/([^/]+)\/runtime\/socket$/;

async function handleSpaceSocket(
	request: Request,
	env: Env
): Promise<Response> {
	const url = new URL(request.url);
	const match = SPACE_SOCKET_PATH_RE.exec(url.pathname);
	if (!match) {
		return new Response("Not found", { status: 404 });
	}

	const token = url.searchParams.get("token")?.trim();
	if (!token) {
		return new Response("Unauthorized", { status: 401 });
	}

	const jwtPayload = await verifyAuthToken(
		token,
		env.CORPORATION_CONVEX_SITE_URL
	);
	if (!jwtPayload) {
		return new Response("Unauthorized", { status: 401 });
	}

	const spaceSlug = decodeURIComponent(match[1] ?? "");
	const headers = createSpaceForwardHeaders({
		spaceSlug,
		authToken: token,
		jwtPayload,
		headers: request.headers,
	});

	return await getSpaceStub(env, spaceSlug).fetch(
		new Request("http://space/socket", {
			method: request.method,
			headers,
		})
	);
}

async function handleRuntimeSpaceSocket(
	request: Request,
	env: Env
): Promise<Response> {
	const url = new URL(request.url);
	const match = RUNTIME_SPACE_SOCKET_PATH_RE.exec(url.pathname);
	if (!match) {
		return new Response("Not found", { status: 404 });
	}

	const token = url.searchParams.get("token")?.trim();
	const secret = env.CORPORATION_RUNTIME_AUTH_SECRET?.trim();
	if (!(token && secret)) {
		return new Response("Unauthorized", { status: 401 });
	}

	const claims = await verifyRuntimeAccessToken(token, secret);
	if (!claims) {
		return new Response("Unauthorized", { status: 401 });
	}

	const spaceSlug = decodeURIComponent(match[1] ?? "");
	if (claims.spaceSlug !== spaceSlug) {
		return new Response("Unauthorized", { status: 401 });
	}

	const headers = createRuntimeForwardHeaders({
		spaceSlug,
		authToken: token,
		claims,
		headers: request.headers,
	});

	return await getSpaceStub(env, spaceSlug).fetch(
		new Request("http://space/runtime/socket", {
			method: request.method,
			headers,
		})
	);
}

const worker = {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		if (SPACE_SOCKET_PATH_RE.test(url.pathname)) {
			return handleSpaceSocket(request, env);
		}
		if (RUNTIME_SPACE_SOCKET_PATH_RE.test(url.pathname)) {
			return handleRuntimeSpaceSocket(request, env);
		}
		return app.fetch(request, env, ctx);
	},
};

const SpaceDurableObject = RawSpaceDurableObject;

export default worker;
export { SpaceDurableObject };
