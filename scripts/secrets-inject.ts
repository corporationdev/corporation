import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { deriveEnvTier, resolveStage } from "@corporation/config/stage";
import { parse as parseDotEnv } from "dotenv";

const repoRoot = resolve(import.meta.dirname, "..");
const templatePath = resolve(repoRoot, ".env.op");
const envAssignmentRegex =
	/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/;
const stageVariableRegex = /\$\{STAGE\}/g;
const envTierVariableRegex = /\$\{ENV_TIER\}/g;
const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
	console.log("Usage: bun secrets:inject [--dev|--sandbox]");
	process.exit(0);
}

const useSandbox = argv.includes("--sandbox");
const useDev = argv.includes("--dev");
if (useSandbox && useDev) {
	throw new Error("Use only one mode flag: --dev or --sandbox");
}

const stage = resolveStage(useSandbox ? "sandbox" : "dev");
const tier = deriveEnvTier(stage);

const tempDirectory = mkdtempSync(join(tmpdir(), "corporation-op-"));
const resolvedTemplatePath = resolve(tempDirectory, ".env.resolved");

const template = readFileSync(templatePath, "utf8");
const resolvedTemplate = template
	.replace(stageVariableRegex, stage)
	.replace(envTierVariableRegex, tier);
writeFileSync(resolvedTemplatePath, resolvedTemplate, "utf8");

const injectResult = spawnSync("op", ["inject", "-i", resolvedTemplatePath], {
	cwd: repoRoot,
	encoding: "utf8",
	env: {
		...process.env,
		STAGE: stage,
		ENV_TIER: tier,
	},
});
if (injectResult.status !== 0) {
	const stderr = injectResult.stderr?.trim();
	const stdout = injectResult.stdout?.trim();
	rmSync(tempDirectory, { recursive: true, force: true });
	throw new Error(
		`op inject failed (${injectResult.status}). ${stderr || stdout || "No output"}`
	);
}

const secrets = parseDotEnv(injectResult.stdout ?? "");
rmSync(tempDirectory, { recursive: true, force: true });

const findExamplesResult = spawnSync(
	"rg",
	[
		"--files",
		"--hidden",
		"-g",
		"**/.env.example",
		"-g",
		"!**/node_modules/**",
		"-g",
		"!**/.git/**",
	],
	{
		cwd: repoRoot,
		encoding: "utf8",
	}
);
if (findExamplesResult.status !== 0) {
	const stderr = findExamplesResult.stderr?.trim();
	throw new Error(
		`Failed to find .env.example files. ${stderr || "No output"}`
	);
}

const envExamples = findExamplesResult.stdout
	.split("\n")
	.map((line) => line.trim())
	.filter((line) => line.length > 0)
	.map((line) => resolve(repoRoot, line))
	.sort();

if (envExamples.length === 0) {
	throw new Error("No .env.example files found.");
}

const outputPaths: string[] = [];
for (const examplePath of envExamples) {
	const outputPath = resolve(dirname(examplePath), ".env");
	const exampleRaw = readFileSync(examplePath, "utf8");
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

		const value = secrets[key];
		if (!value) {
			throw new Error(`Missing required secret "${key}" for ${examplePath}`);
		}

		return [`${prefix}${key}${equals}${value}`];
	});

	const renderedBody = renderedLines.join("\n");
	const stageBlock = `# Stage\nSTAGE=${stage}`;
	const rendered =
		renderedBody.length > 0 ? `${stageBlock}\n\n${renderedBody}` : stageBlock;
	writeFileSync(outputPath, `${rendered}\n`, "utf8");
	outputPaths.push(outputPath);
}

console.log(`Injected secrets for stage=${stage}, tier=${tier}`);
for (const outputPath of outputPaths) {
	console.log(`- ${outputPath}`);
}
