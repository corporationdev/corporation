// Generates packages/app/src/data/agent-models.json by querying the local
// sandbox-agent daemon for each agent's model config options.
//
// Usage:
//   bun scripts/generate-agent-models.ts

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const HOST = "127.0.0.1";
const PORT = 2468;
const BASE_URL = `http://${HOST}:${PORT}`;
const OUTPUT_PATH = resolve(
	import.meta.dirname,
	"../packages/app/src/data/agent-models.json"
);

const AGENT_LABELS: Record<string, string> = {
	claude: "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
	amp: "Amp",
	pi: "Pi",
	cursor: "Cursor",
};

// Amp exposes modes (smart, deep, free, rush) under category "mode" instead of
// "model", so the generic extractor misses them. We merge them in as overrides.
const MODEL_OVERRIDES: Record<
	string,
	{ models?: { id: string; name: string }[]; defaultModel?: string }
> = {
	amp: {
		defaultModel: "smart",
		models: [
			{ id: "smart", name: "Smart" },
			{ id: "deep", name: "Deep" },
			{ id: "free", name: "Free" },
			{ id: "rush", name: "Rush" },
		],
	},
};

type SelectOption = { value: string; name: string };
type GroupedOption = { group: string; options: SelectOption[] };
type ConfigOption = {
	category?: string;
	type?: string;
	currentValue?: string;
	options?: SelectOption[] | GroupedOption[];
};

type AgentEntry = {
	label: string;
	defaultModel: string | null;
	models: { id: string; name: string }[];
};

function flattenOptions(
	options: SelectOption[] | GroupedOption[]
): SelectOption[] {
	if (options.length === 0) {
		return [];
	}
	if ("value" in options[0]) {
		return options as SelectOption[];
	}
	return (options as GroupedOption[]).flatMap((g) => g.options);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function isDaemonRunning(): Promise<boolean> {
	try {
		const res = await fetch(`${BASE_URL}/v1/health`, {
			signal: AbortSignal.timeout(2000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

function spawnDaemon(args: string[]): void {
	execSync(`bunx sandbox-agent ${args.join(" ")}`, {
		stdio: "inherit",
	});
}

async function startDaemon(): Promise<void> {
	console.log("Starting sandbox-agent daemon…");
	spawnDaemon(["daemon", "start", "--host", HOST, "--port", String(PORT)]);
	for (let i = 0; i < 30; i++) {
		if (await isDaemonRunning()) {
			return;
		}
		await sleep(500);
	}
	throw new Error("Daemon did not start within 15 seconds");
}

function stopDaemon(): void {
	console.log("Stopping sandbox-agent daemon…");
	spawnDaemon(["daemon", "stop", "--host", HOST, "--port", String(PORT)]);
}

function extractModels(
	agents: Array<{ id: string; configOptions?: ConfigOption[] | null }>
): Record<string, AgentEntry> {
	const result: Record<string, AgentEntry> = {};

	for (const agent of agents) {
		const label = AGENT_LABELS[agent.id];
		if (!label) {
			continue;
		}

		let models: { id: string; name: string }[] = [];
		let defaultModel: string | null = null;

		for (const opt of agent.configOptions ?? []) {
			if (opt.category === "model" && opt.type === "select" && opt.options) {
				models = flattenOptions(opt.options).map((o) => ({
					id: o.value,
					name: o.name,
				}));
			}
			if (
				opt.category === "model" &&
				opt.type === "select" &&
				opt.currentValue
			) {
				defaultModel = opt.currentValue;
			}
		}

		result[agent.id] = { label, defaultModel, models };
	}

	// Ensure all expected agents are present even if not returned by daemon
	for (const [id, label] of Object.entries(AGENT_LABELS)) {
		if (!result[id]) {
			console.warn(
				`Agent "${id}" not found in daemon response, adding empty entry`
			);
			result[id] = { label, defaultModel: null, models: [] };
		}
	}

	// Apply manual overrides for agents whose API response is incomplete
	for (const [id, override] of Object.entries(MODEL_OVERRIDES)) {
		if (!result[id]) {
			continue;
		}
		if (override.models) {
			result[id].models = override.models;
		}
		if (override.defaultModel) {
			result[id].defaultModel = override.defaultModel;
		}
	}

	return result;
}

async function main() {
	const alreadyRunning = await isDaemonRunning();
	if (alreadyRunning) {
		console.log("Daemon already running on port", PORT);
	} else {
		await startDaemon();
	}

	try {
		console.log("Fetching agents with config…");
		const res = await fetch(`${BASE_URL}/v1/agents?config=true`);
		if (!res.ok) {
			throw new Error(
				`GET /v1/agents?config=true failed: ${res.status} ${await res.text()}`
			);
		}

		const data = (await res.json()) as {
			agents: Array<{
				id: string;
				configOptions?: ConfigOption[] | null;
			}>;
		};

		const result = extractModels(data.agents);
		const json = JSON.stringify(result, null, "  ");
		writeFileSync(OUTPUT_PATH, `${json}\n`);
		console.log(`Wrote ${OUTPUT_PATH}`);
	} finally {
		if (!alreadyRunning) {
			stopDaemon();
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
