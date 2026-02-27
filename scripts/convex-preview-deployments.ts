// Run: bun scripts/convex-preview-deployments.ts --all
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";

type Deployment = {
	createTime: number;
	deploymentType: "dev" | "prod" | "preview" | "custom";
	name: string;
	previewIdentifier: string | null;
};

type ProjectDetails = {
	id: number;
};

const DEFAULT_API_BASE_URL = "https://api.convex.dev/v1";
const DEFAULT_ENV_FILE = ".env";
const CONVEX_TEAM_SLUG = "corporation";
const CONVEX_PROJECT_SLUG = "corporation";

const argv = process.argv.slice(2);
const clearAll = argv.includes("--all");
const dryRun = argv.includes("--dry-run");

const stageArgIndex = argv.indexOf("--stage");
const stageArg =
	stageArgIndex >= 0 && stageArgIndex + 1 < argv.length
		? argv[stageArgIndex + 1]
		: undefined;

const envFile = process.env.CONVEX_PREVIEW_ENV_FILE?.trim() || DEFAULT_ENV_FILE;
const resolvedEnvPath = resolve(process.cwd(), envFile);
if (existsSync(resolvedEnvPath)) {
	config({ path: resolvedEnvPath, override: false });
}

const apiBaseUrl =
	process.env.CONVEX_MANAGEMENT_API_URL?.trim() || DEFAULT_API_BASE_URL;
const managementToken = process.env.CONVEX_MANAGEMENT_TOKEN?.trim();
if (!managementToken) {
	throw new Error(
		`Missing CONVEX_MANAGEMENT_TOKEN. Add it to ${resolvedEnvPath} or your current environment.`
	);
}

async function apiFetch<T>(
	path: string,
	init: RequestInit = {}
): Promise<T | undefined> {
	const response = await fetch(`${apiBaseUrl}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${managementToken}`,
			"Content-Type": "application/json",
			...(init.headers ?? {}),
		},
	});

	if (response.status === 204) {
		return undefined;
	}

	const rawBody = await response.text();
	if (!response.ok) {
		throw new Error(
			`Convex API request failed (${response.status}) for ${path}: ${rawBody || response.statusText}`
		);
	}

	if (rawBody.length === 0) {
		return undefined;
	}

	return JSON.parse(rawBody) as T;
}

async function resolveProjectId(): Promise<number> {
	const project = await apiFetch<ProjectDetails>(
		`/teams/${encodeURIComponent(CONVEX_TEAM_SLUG)}/projects/${encodeURIComponent(CONVEX_PROJECT_SLUG)}`
	);
	if (!project) {
		throw new Error(
			`Unable to resolve project id for team "${CONVEX_TEAM_SLUG}" and project "${CONVEX_PROJECT_SLUG}".`
		);
	}
	return project.id;
}

async function listPreviewDeployments(
	projectId: number
): Promise<Deployment[]> {
	const deployments =
		(await apiFetch<Deployment[]>(
			`/projects/${projectId}/list_deployments?deploymentType=preview`
		)) ?? [];
	return deployments.filter(
		(deployment) => deployment.deploymentType === "preview"
	);
}

async function deleteDeploymentByName(name: string): Promise<void> {
	if (dryRun) {
		console.log(`[dry-run] Would delete deployment ${name}`);
		return;
	}

	await apiFetch(`/deployments/${encodeURIComponent(name)}/delete`, {
		method: "POST",
		body: "{}",
	});
	console.log(`Deleted deployment ${name}`);
}

async function main() {
	const projectId = await resolveProjectId();
	const previewDeployments = await listPreviewDeployments(projectId);

	if (clearAll) {
		if (previewDeployments.length === 0) {
			console.log("No preview deployments found.");
			return;
		}
		console.log(`Found ${previewDeployments.length} preview deployment(s).`);
		for (const deployment of previewDeployments) {
			await deleteDeploymentByName(deployment.name);
		}
		return;
	}

	const stage = stageArg?.trim() || process.env.STAGE?.trim();
	if (!stage) {
		throw new Error(
			"Missing STAGE. Set STAGE in .env or pass --stage <preview-id>."
		);
	}

	const matchingDeployments = previewDeployments
		.filter((deployment) => deployment.previewIdentifier === stage)
		.sort((a, b) => b.createTime - a.createTime);

	if (matchingDeployments.length === 0) {
		console.log(`No preview deployment found for STAGE=${stage}.`);
		return;
	}

	const deploymentToDelete = matchingDeployments[0];
	if (!deploymentToDelete) {
		throw new Error(`No deployment available to delete for STAGE=${stage}.`);
	}

	if (matchingDeployments.length > 1) {
		console.warn(
			`Found ${matchingDeployments.length} deployments for STAGE=${stage}; deleting newest ${deploymentToDelete.name}.`
		);
	}

	await deleteDeploymentByName(deploymentToDelete.name);
}

await main();
