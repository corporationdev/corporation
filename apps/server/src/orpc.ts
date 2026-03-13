import { workerHttpContract } from "@corporation/contracts/orpc/worker-http";
import { implement, ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { type JWTPayload, verifyAuthToken } from "./auth";
import { listGitHubRepos } from "./services/github";
import {
	createIntegrationConnectSession,
	disconnectIntegration,
	getIntegrationConnection,
	listIntegrations,
} from "./services/integrations";
import {
	createRuntimeAuthSession,
	createRuntimeRefreshToken,
} from "./services/runtime-auth";
import { getSpaceStubWithAuth } from "./services/session-stream";

type WorkerORPCContext = {
	env: Env;
	request: Request;
	authToken?: string;
	jwtPayload?: JWTPayload;
};

function getBearerToken(authHeader: string | undefined): string | null {
	if (!authHeader?.startsWith("Bearer ")) {
		return null;
	}

	const token = authHeader.slice("Bearer ".length).trim();
	return token || null;
}

const workerHttpImplementer =
	implement(workerHttpContract).$context<WorkerORPCContext>();

const requireBrowserAuth = workerHttpImplementer.middleware(
	async ({ context, next }) => {
		const token = getBearerToken(
			context.request.headers.get("authorization") ?? undefined
		);
		if (!token) {
			throw new ORPCError("UNAUTHORIZED");
		}

		const jwtPayload = await verifyAuthToken(
			token,
			context.env.CORPORATION_CONVEX_SITE_URL
		);
		if (!jwtPayload) {
			throw new ORPCError("UNAUTHORIZED");
		}

		return next({
			context: {
				...context,
				authToken: token,
				jwtPayload,
			},
		});
	}
);

export const workerHttpRouter = workerHttpImplementer.router({
	github: {
		listRepos: workerHttpImplementer.github.listRepos
			.use(requireBrowserAuth)
			.handler(async ({ context }) => {
				try {
					return await listGitHubRepos(context.env, context.jwtPayload.sub);
				} catch (error) {
					if (
						error instanceof Error &&
						error.message === "No GitHub connection found"
					) {
						throw new ORPCError("UNAUTHORIZED", { message: error.message });
					}
					throw error;
				}
			}),
	},
	integrations: {
		list: workerHttpImplementer.integrations.list
			.use(requireBrowserAuth)
			.handler(async ({ context }) => {
				return await listIntegrations(context.env, context.jwtPayload.sub);
			}),
		getConnection: workerHttpImplementer.integrations.getConnection
			.use(requireBrowserAuth)
			.handler(async ({ context, input }) => {
				return await getIntegrationConnection(
					context.env,
					context.jwtPayload.sub,
					input.uniqueKey
				);
			}),
		connect: workerHttpImplementer.integrations.connect
			.use(requireBrowserAuth)
			.handler(async ({ context, input }) => {
				return await createIntegrationConnectSession(
					context.env,
					context.jwtPayload,
					input
				);
			}),
		disconnect: workerHttpImplementer.integrations.disconnect
			.use(requireBrowserAuth)
			.handler(async ({ context, input }) => {
				return await disconnectIntegration(context.env, input);
			}),
	},
	spaces: {
		getSessionStreamState: workerHttpImplementer.spaces.getSessionStreamState
			.use(requireBrowserAuth)
			.handler(async ({ context, input }) => {
				const spaceActor = getSpaceStubWithAuth({
					env: context.env,
					spaceSlug: input.spaceSlug,
					authToken: context.authToken,
					jwtPayload: context.jwtPayload,
				});
				return await spaceActor.getSessionStreamState(input.sessionId);
			}),
	},
	runtimeAuth: {
		createRefreshToken: workerHttpImplementer.runtimeAuth.createRefreshToken
			.use(requireBrowserAuth)
			.handler(async ({ context, input }) => {
				return await createRuntimeRefreshToken(context.env, {
					clientId: input.clientId,
					userId: context.jwtPayload.sub,
				});
			}),
		createSession: workerHttpImplementer.runtimeAuth.createSession.handler(
			async ({ context, input }) => {
				try {
					return await createRuntimeAuthSession(
						context.env,
						context.request.url,
						input
					);
				} catch (error) {
					if (error instanceof Error && error.message === "Unauthorized") {
						throw new ORPCError("UNAUTHORIZED");
					}
					throw error;
				}
			}
		),
	},
});

const workerHttpRPCHandler = new RPCHandler(workerHttpRouter);

export async function handleORPCRequest(
	request: Request,
	env: Env
): Promise<Response | null> {
	const result = await workerHttpRPCHandler.handle(request, {
		prefix: "/api/rpc",
		context: {
			env,
			request,
		},
	});
	return result.matched ? result.response : null;
}
