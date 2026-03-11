import { ChevronDownIcon, LoaderCircleIcon } from "lucide-react";
import { type FC, useCallback, useMemo } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AgentSelectorOption } from "@/lib/agent-config-options";
import { cn } from "@/lib/utils";

type ModelInfo = { id: string; name?: string };

export const AgentModelPicker: FC<{
	agent: string;
	onAgentChange: (agent: string) => void;
	modelId: string;
	onModelIdChange: (modelId: string) => void;
	agentLocked?: boolean;
	modelLocked?: boolean;
	agentOptions?: AgentSelectorOption[];
	isLoading?: boolean;
}> = ({
	agent,
	onAgentChange,
	modelId,
	onModelIdChange,
	agentLocked,
	modelLocked,
	agentOptions,
	isLoading,
}) => {
	const availableAgents = agentOptions ?? [];
	const agentModels = useMemo(
		() =>
			Object.fromEntries(
				availableAgents.map((agentOption) => [
					agentOption.id,
					agentOption.models,
				])
			) as Record<string, ModelInfo[]>,
		[availableAgents]
	);
	const defaultModels = useMemo(
		() =>
			Object.fromEntries(
				availableAgents
					.filter((agentOption) => agentOption.defaultModelId)
					.map((agentOption) => [
						agentOption.id,
						agentOption.defaultModelId as string,
					])
			),
		[availableAgents]
	);
	const agentLabels = useMemo(
		() =>
			Object.fromEntries(
				availableAgents.map((agentOption) => [
					agentOption.id,
					agentOption.label,
				])
			),
		[availableAgents]
	);
	const models = useMemo(() => {
		return agentModels[agent] ?? [];
	}, [agent, agentModels]);

	const handleAgentChange = useCallback(
		(nextAgent: string) => {
			onAgentChange(nextAgent);
			const nextDefault = defaultModels[nextAgent];
			if (nextDefault) {
				onModelIdChange(nextDefault);
			} else {
				const fallback = agentModels[nextAgent]?.[0]?.id;
				if (fallback) {
					onModelIdChange(fallback);
				}
			}
		},
		[onAgentChange, onModelIdChange, agentModels, defaultModels]
	);

	const agentLabel =
		availableAgents.length === 0 ? "No agents" : (agentLabels[agent] ?? agent);
	const currentModelLabel =
		models.find((m) => m.id === modelId)?.name ?? modelId;

	const locked = agentLocked && modelLocked;
	const lockedClassName = "pointer-events-none";

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
						(agentLocked || locked || availableAgents.length === 0) &&
							lockedClassName
					)}
				>
					{agentLabel}
					<ChevronDownIcon className="size-3" />
				</DropdownMenuTrigger>
				<DropdownMenuContent>
					{availableAgents.map((agentOption) => (
						<DropdownMenuItem
							key={agentOption.id}
							onClick={() => handleAgentChange(agentOption.id)}
						>
							{agentOption.label}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
			{isLoading ? (
				<div className="inline-flex h-7 items-center gap-1 rounded-full border border-border/50 bg-muted/50 px-2.5 text-muted-foreground text-xs">
					<LoaderCircleIcon className="size-3 animate-spin" />
					<span>Loading models…</span>
				</div>
			) : models.length > 0 ? (
				<DropdownMenu>
					<DropdownMenuTrigger
						className={cn(
							"inline-flex h-7 min-w-0 max-w-80 items-center gap-1 rounded-full border border-border/50 bg-muted/50 px-2.5 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground",
							(modelLocked || locked) && lockedClassName
						)}
					>
						<span className="truncate">{currentModelLabel}</span>
						<ChevronDownIcon className="size-3" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start">
						{models.map((model) => {
							const label = model.name ?? model.id;
							const id = nameToId[label];
							return (
								<DropdownMenuItem
									key={model.id}
									onClick={() => {
										if (id) {
											onModelIdChange(id);
										}
									}}
								>
									{label}
								</DropdownMenuItem>
							);
						})}
					</DropdownMenuContent>
				</DropdownMenu>
			) : null}
		</div>
	);
};
