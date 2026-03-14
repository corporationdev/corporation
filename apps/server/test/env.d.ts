import type { EnvironmentDurableObject } from "../src/environment-do";
import type { TestStreamConsumerDurableObject } from "../src/test-stream-consumer-do";

declare module "cloudflare:test" {
	type ProvidedEnv = {
		ENABLE_TEST_ROUTES: string;
		RUNTIME_AUTH_SECRET: string;
		WEB_URL: string;
		ENVIRONMENT_DO: DurableObjectNamespace<EnvironmentDurableObject>;
		SPACE_DO: DurableObjectNamespace;
		TEST_STREAM_CONSUMER_DO: DurableObjectNamespace<TestStreamConsumerDurableObject>;
	};
}
