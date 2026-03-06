import { createHandler } from "@rivetkit/cloudflare-workers";
import { app } from "./app";
import { registry } from "./registry";

const { handler, ActorHandler } = createHandler(registry, {
	fetch: app.fetch,
});

export { ActorHandler };
export default handler;
