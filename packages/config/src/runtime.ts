import { getStageServerUrl } from "@corporation/config/server-url";
import { getStageKind } from "@corporation/config/stage";

type ResolveRuntimeContextOptions = {
	allowMissingPreviewConvex?: boolean;
};

export type RuntimeContext = {
	webClientEnv: {
		VITE_CORPORATION_SERVER_URL: string;
		VITE_CORPORATION_CONVEX_URL: string;
		VITE_CORPORATION_CONVEX_SITE_URL: string;
		VITE_STAGE_KIND: "dev" | "sandbox" | "preview" | "production";
	};
	webDevProxyEnv?: {
		DEV_SERVER_PROXY_TARGET: string;
		DEV_CONVEX_PROXY_TARGET: string;
		DEV_CONVEX_SITE_PROXY_TARGET: string;
	};
	serverBindings: {
		CORPORATION_CONVEX_URL: string;
		CORPORATION_CONVEX_SITE_URL: string;
		CORPORATION_SERVER_URL: string;
	};
	convexSyncEnv: {
		CORPORATION_WEB_URL: string;
		CORPORATION_CONVEX_SITE_URL: string;
		CORPORATION_SERVER_URL: string;
		CORPORATION_EMAIL_FROM: string;
	};
};

export function resolveRuntimeContext(
	stage: string,
	options: ResolveRuntimeContextOptions = {}
): RuntimeContext {
	const stageKind = getStageKind(stage);

	if (stageKind === "dev") {
		const CONVEX_URL = "https://hip-impala-208.convex.cloud";
		const CONVEX_SITE_URL = "https://hip-impala-208.convex.site";
		const SERVER_URL = getStageServerUrl(stage);

		return {
			webClientEnv: {
				VITE_CORPORATION_SERVER_URL: "/api",
				VITE_CORPORATION_CONVEX_URL: "/convex",
				VITE_CORPORATION_CONVEX_SITE_URL: "/convex",
				VITE_STAGE_KIND: "dev",
			},
			webDevProxyEnv: {
				DEV_SERVER_PROXY_TARGET: "http://localhost:3000",
				DEV_CONVEX_PROXY_TARGET: CONVEX_URL,
				DEV_CONVEX_SITE_PROXY_TARGET: CONVEX_SITE_URL,
			},
			serverBindings: {
				CORPORATION_CONVEX_URL: CONVEX_URL,
				CORPORATION_CONVEX_SITE_URL: CONVEX_SITE_URL,
				CORPORATION_SERVER_URL: SERVER_URL,
			},
			convexSyncEnv: {
				CORPORATION_WEB_URL: "http://localhost:3001",
				CORPORATION_CONVEX_SITE_URL: CONVEX_SITE_URL,
				CORPORATION_SERVER_URL: SERVER_URL,
				CORPORATION_EMAIL_FROM: "dev@corporation.dev",
			},
		};
	}

	if (stageKind === "sandbox") {
		const CONVEX_URL = "http://localhost:3210";
		const CONVEX_SITE_URL = "http://localhost:3211";
		const SERVER_URL = getStageServerUrl(stage);

		return {
			webClientEnv: {
				VITE_CORPORATION_SERVER_URL: "/api",
				VITE_CORPORATION_CONVEX_URL: "/convex",
				VITE_CORPORATION_CONVEX_SITE_URL: "/convex",
				VITE_STAGE_KIND: "sandbox",
			},
			webDevProxyEnv: {
				DEV_SERVER_PROXY_TARGET: "http://localhost:3000",
				DEV_CONVEX_PROXY_TARGET: CONVEX_URL,
				DEV_CONVEX_SITE_PROXY_TARGET: CONVEX_SITE_URL,
			},
			serverBindings: {
				CORPORATION_CONVEX_URL: CONVEX_URL,
				CORPORATION_CONVEX_SITE_URL: CONVEX_SITE_URL,
				CORPORATION_SERVER_URL: SERVER_URL,
			},
			convexSyncEnv: {
				CORPORATION_WEB_URL: "http://localhost:3001",
				CORPORATION_CONVEX_SITE_URL: CONVEX_SITE_URL,
				CORPORATION_SERVER_URL: SERVER_URL,
				CORPORATION_EMAIL_FROM: "sandbox@corporation.dev",
			},
		};
	}

	if (stageKind === "preview") {
		const CONVEX_URL =
			process.env.CONVEX_URL ??
			(options.allowMissingPreviewConvex
				? "https://missing-preview-convex-url.invalid"
				: undefined);
		const CONVEX_SITE_URL =
			process.env.CONVEX_SITE_URL ??
			(options.allowMissingPreviewConvex
				? "https://missing-preview-convex-site-url.invalid"
				: undefined);
		if (!(CONVEX_URL && CONVEX_SITE_URL)) {
			throw new Error(
				`Missing CONVEX_URL or CONVEX_SITE_URL for preview stage "${stage}". These are set by \`npx convex deploy\` in CI.`
			);
		}

		const SERVER_URL = getStageServerUrl(stage);

		return {
			webClientEnv: {
				VITE_CORPORATION_SERVER_URL: "/api",
				VITE_CORPORATION_CONVEX_URL: CONVEX_URL,
				VITE_CORPORATION_CONVEX_SITE_URL: CONVEX_SITE_URL,
				VITE_STAGE_KIND: "preview",
			},
			serverBindings: {
				CORPORATION_CONVEX_URL: CONVEX_URL,
				CORPORATION_CONVEX_SITE_URL: CONVEX_SITE_URL,
				CORPORATION_SERVER_URL: SERVER_URL,
			},
			convexSyncEnv: {
				CORPORATION_WEB_URL: `https://${stage}.corporation.dev`,
				CORPORATION_CONVEX_SITE_URL: CONVEX_SITE_URL,
				CORPORATION_SERVER_URL: SERVER_URL,
				CORPORATION_EMAIL_FROM: "preview@corporation.dev",
			},
		};
	}

	if (stageKind === "production") {
		const CONVEX_URL = "https://joyous-snake-377.convex.cloud";
		const CONVEX_SITE_URL = "https://joyous-snake-377.convex.site";
		const SERVER_URL = getStageServerUrl(stage);
		return {
			webClientEnv: {
				VITE_CORPORATION_SERVER_URL: "/api",
				VITE_CORPORATION_CONVEX_URL: CONVEX_URL,
				VITE_CORPORATION_CONVEX_SITE_URL: CONVEX_SITE_URL,
				VITE_STAGE_KIND: "production",
			},
			serverBindings: {
				CORPORATION_CONVEX_URL: CONVEX_URL,
				CORPORATION_CONVEX_SITE_URL: CONVEX_SITE_URL,
				CORPORATION_SERVER_URL: SERVER_URL,
			},
			convexSyncEnv: {
				CORPORATION_WEB_URL: "https://app.corporation.dev",
				CORPORATION_CONVEX_SITE_URL: CONVEX_SITE_URL,
				CORPORATION_SERVER_URL: SERVER_URL,
				CORPORATION_EMAIL_FROM: "hello@corporation.dev",
			},
		};
	}

	throw new Error(`Unsupported stage "${stage}" for runtime resolution.`);
}
