import fs from "node:fs";
import { exportVariable, setSecret } from "@actions/core";
import dotenv from "dotenv";

const env = dotenv.parse(fs.readFileSync(".env.resolved", "utf8"));

for (const [key, value] of Object.entries(env)) {
	const isSecret =
		key.endsWith("_KEY") ||
		key.endsWith("_TOKEN") ||
		key.endsWith("_SECRET") ||
		key.endsWith("_PASSWORD");

	if (isSecret) {
		setSecret(value);
	}

	exportVariable(key, value);
}
