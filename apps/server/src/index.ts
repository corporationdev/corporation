import { app } from "./app";
import { EnvironmentDurableObject as RawEnvironmentDurableObject } from "./environment-do";
import { SpaceDurableObject as RawSpaceDurableObject } from "./space-do/object";
import { TestStreamConsumerDurableObject as RawTestStreamConsumerDurableObject } from "./test-stream-consumer-do";

const worker = {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return app.fetch(request, env as never, ctx);
	},
};

const SpaceDurableObject = RawSpaceDurableObject;
const EnvironmentDurableObject = RawEnvironmentDurableObject;
const TestStreamConsumerDurableObject = RawTestStreamConsumerDurableObject;

export default worker;
export {
	SpaceDurableObject,
	EnvironmentDurableObject,
	TestStreamConsumerDurableObject,
};
