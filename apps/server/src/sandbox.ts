import { Hono } from "hono";
import { authMiddleware } from "./auth";

export const sandboxApp = new Hono<{ Bindings: Env }>().use(authMiddleware);
