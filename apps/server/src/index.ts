import { app } from "./app";
import { SpaceDurableObject as RawSpaceDurableObject } from "./space-do/object";
import { UserDurableObject as RawUserDurableObject } from "./user-do";
const worker = {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return app.fetch(request, env as never, ctx);
	},
};

const SpaceDurableObject = RawSpaceDurableObject;
const UserDurableObject = RawUserDurableObject;

export default worker;
export { SpaceDurableObject, UserDurableObject };
