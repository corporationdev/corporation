import { api } from "@corporation/backend/convex/_generated/api";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { Check, ExternalLink } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import acpAgents from "@/data/acp-agents.json";

export const Route = createFileRoute("/_authenticated/settings/agents")({
	component: AgentsPage,
});

type AcpAgent = {
	id: string;
	name: string;
	description: string;
	icon: string | null;
	auth: {
		vars: Array<{ name: string; label: string }>;
		link: string;
	} | null;
};

const agents = acpAgents as AcpAgent[];
const configurableAgents = agents.filter((a) => a.auth !== null);

function AgentCard({
	agent,
	secrets,
}: {
	agent: AcpAgent & { auth: NonNullable<AcpAgent["auth"]> };
	secrets: Array<{ name: string; hint: string }>;
}) {
	const upsertKey = useMutation(api.secrets.upsert);
	const removeKey = useMutation(api.secrets.remove);
	const [editingVar, setEditingVar] = useState<string | null>(null);
	const [inputValue, setInputValue] = useState("");
	const [saving, setSaving] = useState(false);
	const [removingVar, setRemovingVar] = useState<string | null>(null);

	const isConfigured = agent.auth.vars.every((v) =>
		secrets.some((s) => s.name === v.name)
	);

	const handleSave = async (varName: string) => {
		setSaving(true);
		try {
			await upsertKey({ name: varName, apiKey: inputValue });
			setEditingVar(null);
			setInputValue("");
		} finally {
			setSaving(false);
		}
	};

	const handleRemove = async (varName: string) => {
		setRemovingVar(varName);
		try {
			await removeKey({ name: varName });
		} finally {
			setRemovingVar(null);
		}
	};

	return (
		<Card size="sm">
			<CardHeader>
				<div className="flex items-center gap-2">
					{agent.icon && (
						<img
							alt={`${agent.name} logo`}
							className="size-5 dark:invert"
							height={20}
							src={agent.icon}
							width={20}
						/>
					)}
					<div>
						<CardTitle className="flex items-center gap-1.5">
							{agent.name}
							{isConfigured && <Check className="size-3.5 text-green-500" />}
						</CardTitle>
						<CardDescription>{agent.description}</CardDescription>
					</div>
				</div>
				<CardAction>
					<a
						className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
						href={agent.auth.link}
						rel="noopener noreferrer"
						target="_blank"
					>
						Get key
						<ExternalLink className="size-3" />
					</a>
				</CardAction>
			</CardHeader>
			<div className="space-y-2 px-3 pb-3">
				{agent.auth.vars.map((v) => {
					const existing = secrets.find((s) => s.name === v.name);
					const isEditing = editingVar === v.name;

					if (isEditing) {
						return (
							<div className="flex items-center gap-2" key={v.name}>
								<Input
									autoFocus
									className="h-7 max-w-xs text-xs"
									onChange={(e) => setInputValue(e.target.value)}
									placeholder={v.label}
									type="password"
									value={inputValue}
								/>
								<Button
									disabled={!inputValue.trim() || saving}
									onClick={() => handleSave(v.name)}
									size="sm"
								>
									{saving ? "Saving..." : "Save"}
								</Button>
								<Button
									onClick={() => {
										setEditingVar(null);
										setInputValue("");
									}}
									size="sm"
									variant="ghost"
								>
									Cancel
								</Button>
							</div>
						);
					}

					return (
						<div className="flex items-center gap-2" key={v.name}>
							{existing ? (
								<>
									<span className="font-mono text-muted-foreground text-xs">
										{existing.hint}
									</span>
									<Button
										onClick={() => {
											setEditingVar(v.name);
											setInputValue("");
										}}
										size="sm"
										variant="ghost"
									>
										Update
									</Button>
									<Button
										disabled={removingVar === v.name}
										onClick={() => handleRemove(v.name)}
										size="sm"
										variant="destructive"
									>
										{removingVar === v.name ? "Removing..." : "Remove"}
									</Button>
								</>
							) : (
								<Button
									onClick={() => {
										setEditingVar(v.name);
										setInputValue("");
									}}
									size="sm"
									variant="outline"
								>
									Configure
								</Button>
							)}
						</div>
					);
				})}
			</div>
		</Card>
	);
}

function AgentsPage() {
	const secrets = useQuery(api.secrets.list);

	return (
		<div className="p-6">
			<h1 className="font-semibold text-lg">Agents</h1>
			<p className="mt-1 mb-4 text-muted-foreground text-sm">
				Configure API keys for ACP coding agents.
			</p>

			{secrets === undefined ? (
				<div className="flex flex-col gap-3">
					<Skeleton className="h-16 w-full" />
					<Skeleton className="h-16 w-full" />
					<Skeleton className="h-16 w-full" />
				</div>
			) : (
				<div className="flex flex-col gap-3">
					{configurableAgents.map((agent) => (
						<AgentCard
							agent={
								agent as AcpAgent & { auth: NonNullable<AcpAgent["auth"]> }
							}
							key={agent.id}
							secrets={secrets}
						/>
					))}
				</div>
			)}
		</div>
	);
}
