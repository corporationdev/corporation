import { getStageServerUrl } from "@tendril/config/server-url";
import { getStageKind } from "@tendril/config/stage-kind";

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
		SERVER_URL: string;
		WEB_URL: string;
	};
	emailFrom: string;
};

export function getStageWebUrl(stage: string): string {
	const stageKind = getStageKind(stage);

	if (stageKind === "dev" || stageKind === "sandbox") {
		return "http://localhost:3001";
	}
	if (stageKind === "preview") {
		return `https://${stage}.tendril.sh`;
	}
	if (stageKind === "production") {
		return "https://app.tendril.sh";
	}

	throw new Error(`Unsupported stage "${stage}" for web URL resolution.`);
}

export function getStageEmailFrom(stage: string): string {
	const stageKind = getStageKind(stage);

	if (stageKind === "dev") {
		return "dev@tendril.sh";
	}
	if (stageKind === "sandbox") {
		return "sandbox@tendril.sh";
	}
	if (stageKind === "preview") {
		return "preview@tendril.sh";
	}
	if (stageKind === "production") {
		return "hello@tendril.sh";
	}

	throw new Error(`Unsupported stage "${stage}" for email resolution.`);
}

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
				VITE_SERVER_URL: "/api",
				VITE_CONVEX_URL: "/convex",
				VITE_CONVEX_SITE_URL: "/convex",
				VITE_STAGE_KIND: "dev",
			},
			webDevProxyEnv: {
				DEV_SERVER_PROXY_TARGET: "http://localhost:3000",
				DEV_CONVEX_PROXY_TARGET: CONVEX_URL,
				DEV_CONVEX_SITE_PROXY_TARGET: CONVEX_SITE_URL,
			},
			serverBindings: {
				CONVEX_URL,
				CONVEX_SITE_URL,
				SERVER_URL,
				WEB_URL: getStageWebUrl(stage),
			},
			emailFrom: getStageEmailFrom(stage),
		};
	}

	if (stageKind === "sandbox") {
		const CONVEX_URL = "http://localhost:3210";
		const CONVEX_SITE_URL = "http://localhost:3211";
		const SERVER_URL = getStageServerUrl(stage);

		return {
			webClientEnv: {
				VITE_SERVER_URL: "/api",
				VITE_CONVEX_URL: "/convex",
				VITE_CONVEX_SITE_URL: "/convex",
				VITE_STAGE_KIND: "sandbox",
			},
			webDevProxyEnv: {
				DEV_SERVER_PROXY_TARGET: "http://localhost:3000",
				DEV_CONVEX_PROXY_TARGET: CONVEX_URL,
				DEV_CONVEX_SITE_PROXY_TARGET: CONVEX_SITE_URL,
			},
			serverBindings: {
				CONVEX_URL,
				CONVEX_SITE_URL,
				SERVER_URL,
				WEB_URL: getStageWebUrl(stage),
			},
			emailFrom: getStageEmailFrom(stage),
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
				VITE_SERVER_URL: "/api",
				VITE_CONVEX_URL: CONVEX_URL,
				VITE_CONVEX_SITE_URL: CONVEX_SITE_URL,
				VITE_STAGE_KIND: "preview",
			},
			serverBindings: {
				CONVEX_URL,
				CONVEX_SITE_URL,
				SERVER_URL,
				WEB_URL: getStageWebUrl(stage),
			},
			emailFrom: getStageEmailFrom(stage),
		};
	}

	if (stageKind === "production") {
		const CONVEX_URL = "https://joyous-snake-377.convex.cloud";
		const CONVEX_SITE_URL = "https://joyous-snake-377.convex.site";
		const SERVER_URL = getStageServerUrl(stage);
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
				SERVER_URL,
				WEB_URL: getStageWebUrl(stage),
			},
			emailFrom: getStageEmailFrom(stage),
		};
	}

	throw new Error(`Unsupported stage "${stage}" for runtime resolution.`);
}
