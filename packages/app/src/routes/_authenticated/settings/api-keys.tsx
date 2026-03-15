import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Copy, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { authClient } from "@/lib/auth-client";
import { getAuthErrorMessage } from "@/lib/organization";

export const Route = createFileRoute("/_authenticated/settings/api-keys")({
	component: ApiKeysSettingsPage,
});

type ApiKeyRecord = Awaited<ReturnType<typeof listApiKeys>>["apiKeys"][number];

async function listApiKeys() {
	const result = await authClient.apiKey.list();
	if (!(result.data && !result.error)) {
		throw new Error(getAuthErrorMessage(result.error));
	}
	return result.data;
}

function formatDate(value: Date | null) {
	if (!value) {
		return "Never";
	}
	return new Date(value).toLocaleString();
}

function ApiKeysSettingsPage() {
	const queryClient = useQueryClient();
	const [name, setName] = useState("");
	const [expiresInDays, setExpiresInDays] = useState("");
	const [createdKey, setCreatedKey] = useState<string | null>(null);
	const queryKey = ["api-keys"];

	const {
		data: apiKeys,
		isPending,
		error,
	} = useQuery({
		queryKey,
		queryFn: listApiKeys,
	});

	const createMutation = useMutation({
		mutationFn: async () => {
			const parsedDays = Number.parseInt(expiresInDays, 10);
			const expiresIn =
				expiresInDays.trim().length > 0 && Number.isFinite(parsedDays)
					? parsedDays * 24 * 60 * 60
					: undefined;
			const result = await authClient.apiKey.create({
				name: name.trim(),
				expiresIn,
			});
			if (!(result.data && !result.error)) {
				throw new Error(getAuthErrorMessage(result.error));
			}
			return result.data;
		},
		onSuccess: async (data) => {
			setCreatedKey(data.key);
			setName("");
			setExpiresInDays("");
			toast.success("API key created");
			await queryClient.invalidateQueries({ queryKey });
		},
		onError: (mutationError) => {
			toast.error(mutationError.message);
		},
	});

	const deleteMutation = useMutation({
		mutationFn: async (keyId: string) => {
			const result = await authClient.apiKey.delete({
				keyId,
			});
			if (!(result.data && !result.error)) {
				throw new Error(getAuthErrorMessage(result.error));
			}
		},
		onSuccess: async () => {
			toast.success("API key deleted");
			await queryClient.invalidateQueries({ queryKey });
		},
		onError: (mutationError) => {
			toast.error(mutationError.message);
		},
	});

	return (
		<div className="space-y-6 p-6">
			<div>
				<h1 className="font-semibold text-lg">API Keys</h1>
				<p className="mt-1 text-muted-foreground text-sm">
					Create and revoke API keys for non-interactive Tendril access.
				</p>
			</div>

			<Card>
				<CardHeader>
					<div>
						<CardTitle>Create API key</CardTitle>
						<CardDescription>
							Use API keys for CI and other automated environments.
						</CardDescription>
					</div>
				</CardHeader>
				<CardContent className="space-y-3">
					<div className="grid gap-3 md:grid-cols-2">
						<Input
							onChange={(event) => setName(event.target.value)}
							placeholder="CI deploy"
							value={name}
						/>
						<Input
							inputMode="numeric"
							onChange={(event) => setExpiresInDays(event.target.value)}
							placeholder="Expires in days (optional)"
							value={expiresInDays}
						/>
					</div>
					<Button
						disabled={createMutation.isPending || !name.trim()}
						onClick={() => createMutation.mutate()}
					>
						{createMutation.isPending ? "Creating..." : "Create key"}
					</Button>
					{createdKey ? (
						<div className="rounded-lg border bg-muted/40 p-3">
							<div className="flex items-center justify-between gap-3">
								<div className="min-w-0">
									<p className="font-medium text-sm">
										Copy this key now. It will not be shown again.
									</p>
									<code className="mt-2 block overflow-x-auto rounded bg-background px-3 py-2 text-xs">
										{createdKey}
									</code>
								</div>
								<Button
									onClick={async () => {
										await navigator.clipboard.writeText(createdKey);
										toast.success("API key copied");
									}}
									size="icon"
									variant="outline"
								>
									<Copy />
								</Button>
							</div>
						</div>
					) : null}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<div>
						<CardTitle>Existing keys</CardTitle>
						<CardDescription>
							Keys are only shown by prefix after creation.
						</CardDescription>
					</div>
				</CardHeader>
				<CardContent className="space-y-3">
					{error ? (
						<p className="text-destructive text-sm">{error.message}</p>
					) : null}
					{isPending ? (
						<>
							<Skeleton className="h-14 w-full" />
							<Skeleton className="h-14 w-full" />
						</>
					) : apiKeys?.apiKeys.length ? (
						apiKeys.apiKeys.map((apiKey) => (
							<ApiKeyRow
								apiKey={apiKey}
								isDeleting={
									deleteMutation.isPending &&
									deleteMutation.variables === apiKey.id
								}
								key={apiKey.id}
								onDelete={(keyId) => deleteMutation.mutate(keyId)}
							/>
						))
					) : (
						<p className="text-muted-foreground text-sm">
							No API keys created yet.
						</p>
					)}
				</CardContent>
			</Card>
		</div>
	);
}

function ApiKeyRow({
	apiKey,
	isDeleting,
	onDelete,
}: {
	apiKey: ApiKeyRecord;
	isDeleting: boolean;
	onDelete: (keyId: string) => void;
}) {
	return (
		<div className="flex items-center gap-3 rounded-lg border px-4 py-3">
			<div className="min-w-0 flex-1">
				<div className="font-medium text-sm">
					{apiKey.name || "Unnamed key"}
				</div>
				<div className="mt-1 text-muted-foreground text-xs">
					{apiKey.start || apiKey.prefix || "Hidden"} • created{" "}
					{formatDate(apiKey.createdAt)}
				</div>
				<div className="text-muted-foreground text-xs">
					Expires {formatDate(apiKey.expiresAt)}
				</div>
			</div>
			<CardAction>
				<Button
					disabled={isDeleting}
					onClick={() => onDelete(apiKey.id)}
					size="icon"
					variant="destructive"
				>
					<Trash2 />
				</Button>
			</CardAction>
		</div>
	);
}
