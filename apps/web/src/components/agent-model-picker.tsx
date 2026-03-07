import { ChevronDownIcon, LoaderCircleIcon } from "lucide-react";
import { type FC, useCallback, useMemo } from "react";
import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
} from "@/components/ui/combobox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import agentModelsData from "@/data/agent-models.json";
import { cn } from "@/lib/utils";

type ModelInfo = { id: string; name?: string };

const KNOWN_AGENTS = Object.keys(agentModelsData);

const AGENT_LABELS: Record<string, string> = Object.fromEntries(
	Object.entries(agentModelsData).map(([id, cfg]) => [id, cfg.label])
);

const STATIC_MODELS: Record<string, ModelInfo[]> = Object.fromEntries(
	Object.entries(agentModelsData).map(([id, cfg]) => [id, cfg.models])
);

const STATIC_DEFAULTS: Record<string, string> = Object.fromEntries(
	Object.entries(agentModelsData)
		.filter(([, cfg]) => cfg.defaultModel !== null)
		.map(([id, cfg]) => [id, cfg.defaultModel as string])
);

export const AgentModelPicker: FC<{
	agent: string;
	onAgentChange: (agent: string) => void;
	modelId: string;
	onModelIdChange: (modelId: string) => void;
	agentLocked?: boolean;
	modelLocked?: boolean;
	agentModels?: Record<string, ModelInfo[]>;
	defaultModels?: Record<string, string>;
}> = ({
	agent,
	onAgentChange,
	modelId,
	onModelIdChange,
	agentLocked,
	modelLocked,
	agentModels,
	defaultModels,
}) => {
	const models = useMemo(() => {
		const dynamic = agentModels?.[agent];
		if (dynamic && dynamic.length > 0) {
			return dynamic;
		}
		return STATIC_MODELS[agent] ?? [];
	}, [agent, agentModels]);

	const handleAgentChange = useCallback(
		(nextAgent: string) => {
			onAgentChange(nextAgent);
			const defaults = defaultModels ?? STATIC_DEFAULTS;
			const nextDefault = defaults[nextAgent];
			if (nextDefault) {
				onModelIdChange(nextDefault);
			} else {
				const dynamic = agentModels?.[nextAgent];
				const fallback = dynamic?.[0]?.id ?? STATIC_MODELS[nextAgent]?.[0]?.id;
				if (fallback) {
					onModelIdChange(fallback);
				}
			}
		},
		[onAgentChange, onModelIdChange, agentModels, defaultModels]
	);

	const agentLabel = AGENT_LABELS[agent] ?? agent;
	const currentModelLabel =
		models.find((m) => m.id === modelId)?.name ?? modelId;

	const locked = agentLocked && modelLocked;

	const modelNames = useMemo(() => models.map((m) => m.name ?? m.id), [models]);

	const nameToId = useMemo(() => {
		const map: Record<string, string> = {};
		for (const m of models) {
			map[m.name ?? m.id] = m.id;
		}
		return map;
	}, [models]);

	return (
		<div className="flex items-center gap-2">
			<DropdownMenu>
				<DropdownMenuTrigger
					className={cn(
						"inline-flex h-7 items-center gap-1 rounded-full border border-border/50 bg-muted/50 px-2.5 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground",
						(agentLocked || locked) && "pointer-events-none opacity-50"
					)}
				>
					{agentLabel}
					<ChevronDownIcon className="size-3" />
				</DropdownMenuTrigger>
				<DropdownMenuContent>
					{KNOWN_AGENTS.map((id) => (
						<DropdownMenuItem key={id} onClick={() => handleAgentChange(id)}>
							{AGENT_LABELS[id] ?? id}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
			{agentModels === undefined && models.length === 0 ? (
				<div className="inline-flex h-7 items-center gap-1 rounded-full border border-border/50 bg-muted/50 px-2.5 text-muted-foreground text-xs">
					<LoaderCircleIcon className="size-3 animate-spin" />
					<span>Loading models…</span>
				</div>
			) : models.length > 0 ? (
				<Combobox
					disabled={modelLocked || locked}
					items={modelNames}
					onValueChange={(val) => {
						if (val) {
							const id = nameToId[val as string];
							if (id) {
								onModelIdChange(id);
							}
						}
					}}
					value={currentModelLabel}
				>
					<ComboboxInput
						className={cn(
							"h-7 rounded-full border-border/50 bg-muted/50 text-muted-foreground text-xs",
							(modelLocked || locked) && "pointer-events-none opacity-50"
						)}
						onFocus={(e) => e.currentTarget.select()}
						placeholder="Select model..."
					/>
					<ComboboxContent>
						<ComboboxEmpty>No model found.</ComboboxEmpty>
						<ComboboxList>
							{(item) => (
								<ComboboxItem key={item} value={item}>
									{item}
								</ComboboxItem>
							)}
						</ComboboxList>
					</ComboboxContent>
				</Combobox>
			) : null}
		</div>
	);
};
