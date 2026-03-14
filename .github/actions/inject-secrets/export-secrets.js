import fs from "node:fs";
import path from "node:path";
import { exportVariable, setSecret } from "@actions/core";
import dotenv from "dotenv";

const repoRoot = process.cwd();
const env = dotenv.parse(fs.readFileSync(path.join(repoRoot, ".env.resolved"), "utf8"));
const envAssignmentRegex =
	/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/;

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

const envExamplePaths = findEnvExamples(repoRoot);

for (const examplePath of envExamplePaths) {
	const outputPath = path.join(path.dirname(examplePath), ".env");
	const exampleRaw = fs.readFileSync(examplePath, "utf8");
	const renderedLines = exampleRaw.split(/\r?\n/).flatMap((line) => {
		const match = line.match(envAssignmentRegex);
		if (!match) {
			return [line];
		}

		const prefix = match[1] ?? "";
		const key = match[2];
		const equals = match[3] ?? "=";
		if (!key) {
			return [line];
		}
		if (key === "STAGE") {
			return [];
		}

		const value = env[key];
		if (!value) {
			throw new Error(`Missing required secret "${key}" for ${examplePath}`);
		}

		return [`${prefix}${key}${equals}${value}`];
	});

	const renderedBody = renderedLines.join("\n");
	const stageBlock = `# Stage\nSTAGE=${env.STAGE ?? ""}`;
	const rendered =
		renderedBody.length > 0 ? `${stageBlock}\n\n${renderedBody}` : stageBlock;
	fs.writeFileSync(outputPath, `${rendered}\n`, "utf8");
}

function findEnvExamples(root) {
	const envExamples = [];
	walk(root, envExamples);
	return envExamples.sort();
}

function walk(directoryPath, envExamples) {
	for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === ".git") {
			continue;
		}

		const entryPath = path.join(directoryPath, entry.name);
		if (entry.isDirectory()) {
			walk(entryPath, envExamples);
			continue;
		}

		if (entry.isFile() && entry.name === ".env.example") {
			envExamples.push(entryPath);
		}
	}
}
