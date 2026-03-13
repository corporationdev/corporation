declare module "cloudflare:test" {
	interface ProvidedEnv {
		ENVIRONMENT_DO: DurableObjectNamespace;
		SPACE_DO: DurableObjectNamespace;
		CORPORATION_ENABLE_TEST_ROUTES: string;
		CORPORATION_RUNTIME_AUTH_SECRET: string;
		CORPORATION_WEB_URL: string;
	}
}

export {};
