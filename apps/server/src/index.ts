import { app } from "./app";
import { SpaceDurableObject as RawSpaceDurableObject } from "./space-do/object";
import { EnvironmentDurableObject as RawEnvironmentDurableObject } from "./environment-do";
const worker = {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return app.fetch(request, env as never, ctx);
	},
};

const SpaceDurableObject = RawSpaceDurableObject;
const EnvironmentDurableObject = RawEnvironmentDurableObject;

export default worker;
export { SpaceDurableObject, EnvironmentDurableObject };
