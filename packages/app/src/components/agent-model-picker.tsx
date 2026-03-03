import { ChevronDownIcon, LoaderCircleIcon } from "lucide-react";
import { type FC, useCallback, useMemo } from "react";
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
	agentModels?: Record<string, ModelInfo[]>;
	defaultModels?: Record<string, string>;
}> = ({
	agent,
	onAgentChange,
	modelId,
	onModelIdChange,
	agentLocked,
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

	return (
		<div className="flex items-center gap-2">
			<DropdownMenu>
				<DropdownMenuTrigger
					className={cn(
						"inline-flex h-7 items-center gap-1 rounded-full border border-border/50 bg-muted/50 px-2.5 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground",
						agentLocked && "pointer-events-none opacity-50"
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
				<DropdownMenu>
					<DropdownMenuTrigger
						className={cn(
							"inline-flex h-7 items-center gap-1 rounded-full border border-border/50 bg-muted/50 px-2.5 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
						)}
					>
						{currentModelLabel}
						<ChevronDownIcon className="size-3" />
					</DropdownMenuTrigger>
					<DropdownMenuContent>
						{models.map((m) => (
							<DropdownMenuItem
								key={m.id}
								onClick={() => onModelIdChange(m.id)}
							>
								{m.name ?? m.id}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			) : null}
		</div>
	);
};
