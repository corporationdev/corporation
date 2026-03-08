import { getStageKind } from "@corporation/config/stage";

type ResolveRuntimeContextOptions = {
	allowMissingPreviewConvex?: boolean;
};

export type RuntimeContext = {
	webClientEnv: {
		VITE_SERVER_URL: string;
		VITE_CONVEX_URL: string;
		VITE_CONVEX_SITE_URL: string;
		VITE_STAGE_KIND: "dev" | "sandbox" | "preview" | "production";
	};
	webDevProxyEnv?: {
		DEV_SERVER_PROXY_TARGET: string;
		DEV_CONVEX_PROXY_TARGET: string;
		DEV_CONVEX_SITE_PROXY_TARGET: string;
	};
	serverBindings: {
		CONVEX_URL: string;
		CONVEX_SITE_URL: string;
		SERVER_PUBLIC_URL: string;
	};
	convexSyncEnv: {
		WEB_URL: string;
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
		// Alchemy overrides SERVER_PUBLIC_URL with the tunnel URL at deploy time,
		// so this default is just a placeholder for config resolution.
		const SERVER_PUBLIC_URL =
			process.env.SERVER_PUBLIC_URL ?? "http://localhost:3000";

		return {
			webClientEnv: {
				VITE_SERVER_URL: "/api",
				VITE_CONVEX_URL: "/convex",
				VITE_CONVEX_SITE_URL: "/convex",
				VITE_STAGE_KIND: "dev",
			},
			webDevProxyEnv: {
				DEV_SERVER_PROXY_TARGET: SERVER_PUBLIC_URL,
				DEV_CONVEX_PROXY_TARGET: CONVEX_URL,
				DEV_CONVEX_SITE_PROXY_TARGET: CONVEX_SITE_URL,
			},
			serverBindings: {
				CONVEX_URL,
				CONVEX_SITE_URL,
				SERVER_PUBLIC_URL,
			},
			convexSyncEnv: {
				WEB_URL: "http://localhost:3001",
			},
		};
	}

	if (stageKind === "sandbox") {
		const CONVEX_URL = "http://localhost:3210";
		const CONVEX_SITE_URL = "http://localhost:3211";
		// Alchemy overrides SERVER_PUBLIC_URL with the tunnel URL at deploy time,
		// so this default is just a placeholder for config resolution.
		const SERVER_PUBLIC_URL =
			process.env.SERVER_PUBLIC_URL ?? "http://localhost:3000";

		return {
			webClientEnv: {
				VITE_SERVER_URL: "/api",
				VITE_CONVEX_URL: "/convex",
				VITE_CONVEX_SITE_URL: "/convex",
				VITE_STAGE_KIND: "sandbox",
			},
			webDevProxyEnv: {
				DEV_SERVER_PROXY_TARGET: SERVER_PUBLIC_URL,
				DEV_CONVEX_PROXY_TARGET: CONVEX_URL,
				DEV_CONVEX_SITE_PROXY_TARGET: CONVEX_SITE_URL,
			},
			serverBindings: {
				CONVEX_URL,
				CONVEX_SITE_URL,
				SERVER_PUBLIC_URL,
			},
			convexSyncEnv: {
				WEB_URL: "http://localhost:3001",
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

		return {
			webClientEnv: {
				VITE_SERVER_URL: "/api",
				VITE_CONVEX_URL: CONVEX_URL,
				VITE_CONVEX_SITE_URL: CONVEX_SITE_URL,
				VITE_STAGE_KIND: "preview",
			},
			serverBindings: {
				CONVEX_URL,
				CONVEX_SITE_URL,
				SERVER_PUBLIC_URL: `https://${stage}.corporation.dev/api`,
			},
			convexSyncEnv: {
				WEB_URL: `https://${stage}.corporation.dev`,
			},
		};
	}

	if (stageKind === "production") {
		const CONVEX_URL = "https://joyous-snake-377.convex.cloud";
		const CONVEX_SITE_URL = "https://joyous-snake-377.convex.site";

		return {
			webClientEnv: {
				VITE_SERVER_URL: "/api",
				VITE_CONVEX_URL: CONVEX_URL,
				VITE_CONVEX_SITE_URL: CONVEX_SITE_URL,
				VITE_STAGE_KIND: "production",
			},
			serverBindings: {
				CONVEX_URL,
				CONVEX_SITE_URL,
				SERVER_PUBLIC_URL: "https://app.corporation.dev/api",
			},
			convexSyncEnv: {
				WEB_URL: "https://app.corporation.dev",
			},
		};
	}

	throw new Error(`Unsupported stage "${stage}" for runtime resolution.`);
}
