import { api } from "@corporation/backend/convex/_generated/api";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
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
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated/settings/secrets")({
	component: SecretsPage,
});

const KNOWN_KEYS = [
	{ name: "ANTHROPIC_API_KEY", label: "Anthropic" },
	{ name: "OPENAI_API_KEY", label: "OpenAI" },
] as const;

function getLabel(name: string): string {
	const known = KNOWN_KEYS.find((k) => k.name === name);
	return known?.label ?? name;
}

function SecretCard({
	name,
	hint,
	onRemove,
	isRemoving,
}: {
	name: string;
	hint: string;
	onRemove: () => void;
	isRemoving: boolean;
}) {
	return (
		<Card size="sm">
			<CardHeader>
				<div>
					<CardTitle>{getLabel(name)}</CardTitle>
					<CardDescription>{hint}</CardDescription>
				</div>
				<CardAction>
					<Button
						disabled={isRemoving}
						onClick={onRemove}
						size="sm"
						variant="destructive"
					>
						{isRemoving ? "Removing..." : "Remove"}
					</Button>
				</CardAction>
			</CardHeader>
		</Card>
	);
}

function SecretsPage() {
	const keys = useQuery(api.secrets.list);
	const removeKey = useMutation(api.secrets.remove);
	const upsertKey = useMutation(api.secrets.upsert);
	const [removingName, setRemovingName] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const [name, setName] = useState<string>(KNOWN_KEYS[0].name);
	const [apiKey, setApiKey] = useState("");

	const handleSave = async () => {
		setSaving(true);
		try {
			await upsertKey({ name, apiKey });
			setApiKey("");
		} finally {
			setSaving(false);
		}
	};

	const handleRemove = async (keyName: string) => {
		setRemovingName(keyName);
		try {
			await removeKey({ name: keyName });
		} finally {
			setRemovingName(null);
		}
	};

	return (
		<div className="p-6">
			<h1 className="font-semibold text-lg">Secrets</h1>
			<p className="mt-1 mb-4 text-muted-foreground text-sm">
				Add your API keys to use AI agents in your sandboxes.
			</p>

			{keys === undefined ? (
				<div className="flex flex-col gap-3">
					<Skeleton className="h-16 w-full" />
					<Skeleton className="h-16 w-full" />
				</div>
			) : keys.length > 0 ? (
				<div className="flex flex-col gap-3">
					{keys.map((key) => (
						<SecretCard
							hint={key.hint}
							isRemoving={removingName === key.name}
							key={key.name}
							name={key.name}
							onRemove={() => handleRemove(key.name)}
						/>
					))}
				</div>
			) : (
				<p className="mb-4 text-muted-foreground text-sm">
					No secrets configured yet.
				</p>
			)}

			<div className="mt-6 max-w-md space-y-4">
				<h2 className="font-medium text-sm">Add Secret</h2>

				<div className="space-y-2">
					<Label htmlFor="key-name">Provider</Label>
					<select
						className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						id="key-name"
						onChange={(e) => setName(e.target.value)}
						value={name}
					>
						{KNOWN_KEYS.map((k) => (
							<option key={k.name} value={k.name}>
								{k.label} ({k.name})
							</option>
						))}
					</select>
				</div>

				<div className="space-y-2">
					<Label htmlFor="api-key">API Key</Label>
					<Input
						id="api-key"
						onChange={(e) => setApiKey(e.target.value)}
						placeholder="sk-..."
						type="password"
						value={apiKey}
					/>
				</div>

				<Button
					disabled={!apiKey.trim() || saving}
					onClick={handleSave}
					size="sm"
				>
					{saving ? "Saving..." : "Save"}
				</Button>
			</div>
		</div>
	);
}
