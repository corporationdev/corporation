// Fetches the ACP agent registry and generates apps/web/src/data/acp-agents.json.
//
// Usage:
//   bun scripts/generate-acp-agents.ts

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const REGISTRY_URL =
	"https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const OUTPUT_PATH = resolve(
	import.meta.dirname,
	"../apps/web/src/data/acp-agents.json"
);

// ── Auth config per agent (hand-maintained) ──────────────────────────

type AuthConfig = {
	vars: Array<{ name: string; label: string }>;
	link: string;
};

const AUTH_CONFIG: Record<string, AuthConfig> = {
	"claude-acp": {
		vars: [{ name: "ANTHROPIC_API_KEY", label: "Anthropic API Key" }],
		link: "https://console.anthropic.com/settings/keys",
	},
	cursor: {
		vars: [{ name: "CURSOR_API_KEY", label: "Cursor API Key" }],
		link: "https://cursor.com/settings/integrations",
	},
	"codex-acp": {
		vars: [{ name: "OPENAI_API_KEY", label: "OpenAI API Key" }],
		link: "https://platform.openai.com/api-keys",
	},
	gemini: {
		vars: [{ name: "GEMINI_API_KEY", label: "Gemini API Key" }],
		link: "https://aistudio.google.com/apikey",
	},
	"github-copilot-cli": {
		vars: [{ name: "GITHUB_TOKEN", label: "GitHub Token" }],
		link: "https://github.com/settings/tokens",
	},
	goose: {
		vars: [{ name: "OPENAI_API_KEY", label: "OpenAI API Key" }],
		link: "https://platform.openai.com/api-keys",
	},
	cline: {
		vars: [{ name: "OPENAI_API_KEY", label: "OpenAI API Key" }],
		link: "https://platform.openai.com/api-keys",
	},
	kilo: {
		vars: [{ name: "OPENAI_API_KEY", label: "OpenAI API Key" }],
		link: "https://platform.openai.com/api-keys",
	},
	opencode: {
		vars: [{ name: "OPENAI_API_KEY", label: "OpenAI API Key" }],
		link: "https://platform.openai.com/api-keys",
	},
	auggie: {
		vars: [{ name: "AUGMENT_API_KEY", label: "Augment API Key" }],
		link: "https://augmentcode.com",
	},
};

// ── Registry schema ──────────────────────────────────────────────────

const registryAgentSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string(),
	icon: z.string().optional(),
});

const registrySchema = z.object({
	agents: z.array(registryAgentSchema),
});

// ── Output schema ────────────────────────────────────────────────────

type AcpAgent = {
	id: string;
	name: string;
	description: string;
	icon: string | null;
	auth: AuthConfig | null;
};

async function main() {
	console.log("Fetching ACP registry...");
	const response = await fetch(REGISTRY_URL);
	if (!response.ok) {
		throw new Error(`Failed to fetch registry: ${response.status}`);
	}

	const data = registrySchema.parse(await response.json());

	// Pinned agents appear first in this order, then the rest alphabetically
	const PINNED_ORDER = [
		"claude-acp",
		"codex-acp",
		"opencode",
		"cursor",
		"gemini",
		"github-copilot-cli",
	];

	const agents: AcpAgent[] = data.agents
		.map((agent) => ({
			id: agent.id,
			name: agent.name,
			description: agent.description,
			icon: agent.icon ?? null,
			auth: AUTH_CONFIG[agent.id] ?? null,
		}))
		.sort((a, b) => {
			const aPin = PINNED_ORDER.indexOf(a.id);
			const bPin = PINNED_ORDER.indexOf(b.id);
			if (aPin !== -1 && bPin !== -1) {
				return aPin - bPin;
			}
			if (aPin !== -1) {
				return -1;
			}
			if (bPin !== -1) {
				return 1;
			}
			return a.name.localeCompare(b.name);
		});

	writeFileSync(OUTPUT_PATH, `${JSON.stringify(agents, null, "  ")}\n`);
	console.log(`Wrote ${agents.length} agents to ${OUTPUT_PATH}`);
}

main();
