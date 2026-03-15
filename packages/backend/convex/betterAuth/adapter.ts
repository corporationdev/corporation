import { createApi } from "@convex-dev/better-auth";
import { createAuthOptions } from "../auth";
import schema from "./customSchema";

export const {
	create,
	findOne,
	findMany,
	updateOne,
	updateMany,
	deleteOne,
	deleteMany,
} = createApi(schema, createAuthOptions);
