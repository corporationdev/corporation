// Normalizes packages/app/src/data/agent-models.json.
//
// Usage:
//   bun scripts/generate-agent-models.ts

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const OUTPUT_PATH = resolve(
	import.meta.dirname,
	"../packages/app/src/data/agent-models.json"
);

const modelSchema = z.object({
	id: z.string(),
	name: z.string(),
});

const agentEntrySchema = z.object({
	label: z.string(),
	defaultModel: z.string().nullable(),
	models: z.array(modelSchema),
});

const agentModelsFileSchema = z.record(z.string(), agentEntrySchema);

function sortModels(models: z.infer<typeof modelSchema>[]) {
	return [...models].sort((left, right) => left.name.localeCompare(right.name));
}

function main() {
	const raw = readFileSync(OUTPUT_PATH, "utf8");
	const parsed = agentModelsFileSchema.parse(JSON.parse(raw));

	const sorted = Object.fromEntries(
		Object.entries(parsed)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([agentId, entry]) => [
				agentId,
				{
					...entry,
					models: sortModels(entry.models),
				},
			])
	);

	writeFileSync(OUTPUT_PATH, `${JSON.stringify(sorted, null, "  ")}\n`);
	console.log(`Wrote ${OUTPUT_PATH}`);
}

main();
