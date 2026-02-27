import { getStageKind } from "./stage";

export type RuntimeContext = {
	webClientEnv: {
		VITE_SERVER_URL: string;
		VITE_CONVEX_URL: string;
		VITE_CONVEX_SITE_URL: string;
	};
	webDevProxyEnv: {
		DEV_SERVER_PROXY_TARGET: string;
		DEV_CONVEX_PROXY_TARGET: string;
		DEV_CONVEX_SITE_PROXY_TARGET: string;
	};
	serverBindings: {
		CONVEX_URL: string;
		CONVEX_SITE_URL: string;
	};
	convexSyncEnv: {
		WEB_URL: string;
		DESKTOP_URL: string;
	};
};

export function resolveRuntimeContext(stage: string): RuntimeContext {
	const stageKind = getStageKind(stage);

	if (stageKind === "dev") {
		const CONVEX_URL = "https://hip-impala-208.convex.cloud";
		const CONVEX_SITE_URL = "https://hip-impala-208.convex.site";
		return {
			webClientEnv: {
				VITE_SERVER_URL: "/api",
				VITE_CONVEX_URL: CONVEX_URL,
				VITE_CONVEX_SITE_URL: CONVEX_SITE_URL,
			},
			webDevProxyEnv: {
				DEV_SERVER_PROXY_TARGET: "http://localhost:3000",
				DEV_CONVEX_PROXY_TARGET: CONVEX_URL,
				DEV_CONVEX_SITE_PROXY_TARGET: CONVEX_SITE_URL,
			},
			serverBindings: {
				CONVEX_URL,
				CONVEX_SITE_URL,
			},
			convexSyncEnv: {
				WEB_URL: "http://localhost:3001",
				DESKTOP_URL: "http://localhost:5173",
			},
		};
	}

	if (stageKind === "sandbox") {
		const CONVEX_URL = "http://localhost:3210";
		const CONVEX_SITE_URL = "http://localhost:3211";
		return {
			webClientEnv: {
				VITE_SERVER_URL: "/api",
				VITE_CONVEX_URL: "/convex",
				VITE_CONVEX_SITE_URL: "/convex",
			},
			webDevProxyEnv: {
				DEV_SERVER_PROXY_TARGET: "http://localhost:3000",
				DEV_CONVEX_PROXY_TARGET: CONVEX_URL,
				DEV_CONVEX_SITE_PROXY_TARGET: CONVEX_SITE_URL,
			},
			serverBindings: {
				CONVEX_URL,
				CONVEX_SITE_URL,
			},
			convexSyncEnv: {
				WEB_URL: "http://localhost:3001",
				DESKTOP_URL: "http://localhost:5173",
			},
		};
	}

	throw new Error(
		`Unsupported stage "${stage}" for runtime resolution. Expected dev-* or sandbox-* for local runtime.`
	);
}
