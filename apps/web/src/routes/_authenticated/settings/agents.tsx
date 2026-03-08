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
import { Textarea } from "@/components/ui/textarea";
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
const CLAUDE_SETUP_TOKEN_COMMAND = "claude setup-token";
const CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME = "CLAUDE_CODE_OAUTH_TOKEN";
const CODEX_IMPORT_COMMAND =
	"node -e \"const fs=require('fs');const os=require('os');const path=require('path');const file=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'auth.json');const value=Buffer.from(fs.readFileSync(file,'utf8')).toString('base64url');process.stdout.write('\\n\\n'+value+'\\n\\n')\"";
const CODEX_AUTH_SECRET_NAME = "CODEX_AUTH_JSON";
const CLAUDE_CODE_OAUTH_TOKEN_ENV_PATTERN =
	/(?:^|\b)(?:export\s+)?CLAUDE_CODE_OAUTH_TOKEN\s*=\s*['"]?([^'"\s]+)['"]?/m;
const WHITESPACE_PATTERN = /\s/;
const WHITESPACE_GLOBAL_PATTERN = /\s+/g;
const CONNECTED_SECRET_NAMES_BY_AGENT: Partial<Record<string, string[]>> = {
	"claude-acp": ["ANTHROPIC_API_KEY", CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME],
	"codex-acp": ["OPENAI_API_KEY", CODEX_AUTH_SECRET_NAME],
};

function normalizeClaudeCodeOauthToken(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error("Missing Claude Code OAuth token");
	}

	const envMatch = trimmed.match(CLAUDE_CODE_OAUTH_TOKEN_ENV_PATTERN);
	const token = (envMatch?.[1] ?? trimmed)
		.trim()
		.replace(WHITESPACE_GLOBAL_PATTERN, "");

	if (!token || WHITESPACE_PATTERN.test(token)) {
		throw new Error("Invalid Claude Code OAuth token");
	}

	return token;
}

function decodeCodexImportBlob(blob: string): string {
	const trimmed = blob.trim();
	if (trimmed.startsWith("{")) {
		return trimmed;
	}

	const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
	const padding =
		normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
	const decoded = atob(`${normalized}${padding}`);
	return decoded;
}

function validateCodexAuthJson(authJson: string): string {
	const parsed = JSON.parse(authJson) as {
		auth_mode?: string;
		tokens?: {
			id_token?: string;
			access_token?: string;
			refresh_token?: string;
		};
		last_refresh?: string;
	};

	if (
		parsed.auth_mode !== "chatgpt" ||
		typeof parsed.tokens?.id_token !== "string" ||
		typeof parsed.tokens?.access_token !== "string" ||
		typeof parsed.tokens?.refresh_token !== "string" ||
		typeof parsed.last_refresh !== "string"
	) {
		throw new Error("Invalid Codex auth.json payload");
	}

	return JSON.stringify(parsed, null, 2);
}

function ClaudeOauthSection({
	claudeBusy,
	claudeError,
	claudeOauthSecret,
	claudeTokenInput,
	copiedClaudeCommand,
	onClaudeDisconnect,
	onClaudeImport,
	onClaudeTokenInputChange,
	onCopyClaudeCommand,
}: {
	claudeBusy: "disconnect" | "import" | null;
	claudeError: string | null;
	claudeOauthSecret: { name: string; hint: string } | undefined;
	claudeTokenInput: string;
	copiedClaudeCommand: boolean;
	onClaudeDisconnect: () => void;
	onClaudeImport: () => void;
	onClaudeTokenInputChange: (value: string) => void;
	onCopyClaudeCommand: () => void;
}) {
	return (
		<div className="rounded-md border p-2">
			<div className="mb-2 flex items-center justify-between gap-2">
				<div>
					<div className="font-medium text-sm">Claude Code subscription</div>
					<div className="text-muted-foreground text-xs">
						{claudeOauthSecret
							? `Connected: ${claudeOauthSecret.hint ?? "Connected"}`
							: "Create a Claude Code OAuth token locally, then paste it here to use your subscription inside new sandboxes."}
					</div>
				</div>
				{claudeOauthSecret && (
					<Button
						disabled={claudeBusy !== null}
						onClick={onClaudeDisconnect}
						size="sm"
						variant="ghost"
					>
						{claudeBusy === "disconnect" ? "Disconnecting..." : "Disconnect"}
					</Button>
				)}
			</div>
			<div className="mb-2 flex flex-wrap items-center gap-2">
				<Button
					disabled={claudeBusy !== null}
					onClick={onCopyClaudeCommand}
					size="sm"
					variant="outline"
				>
					{copiedClaudeCommand ? "Copied command" : "Copy command"}
				</Button>
				<span className="text-muted-foreground text-xs">
					Run it locally, then paste the token or export line below.
				</span>
			</div>
			<Textarea
				className="mb-2 min-h-20 text-xs"
				onChange={(event) => onClaudeTokenInputChange(event.target.value)}
				placeholder="Paste CLAUDE_CODE_OAUTH_TOKEN or export CLAUDE_CODE_OAUTH_TOKEN=..."
				value={claudeTokenInput}
			/>
			<div className="flex items-center gap-2">
				<Button
					disabled={!claudeTokenInput.trim() || claudeBusy !== null}
					onClick={onClaudeImport}
					size="sm"
				>
					{claudeBusy === "import" ? "Saving..." : "Save token"}
				</Button>
				<span className="text-muted-foreground text-xs">
					Used for Claude Code ACP in newly created sandboxes.
				</span>
			</div>
			{claudeError && (
				<div className="mt-2 text-destructive text-xs">{claudeError}</div>
			)}
		</div>
	);
}

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
	const [codexBusy, setCodexBusy] = useState<"disconnect" | "import" | null>(
		null
	);
	const [codexError, setCodexError] = useState<string | null>(null);
	const [copiedCommand, setCopiedCommand] = useState(false);
	const [importBlob, setImportBlob] = useState("");
	const [claudeBusy, setClaudeBusy] = useState<"disconnect" | "import" | null>(
		null
	);
	const [claudeError, setClaudeError] = useState<string | null>(null);
	const [claudeTokenInput, setClaudeTokenInput] = useState("");
	const [copiedClaudeCommand, setCopiedClaudeCommand] = useState(false);

	const storedSecretNames = new Set(secrets.map((secret) => secret.name));
	const isClaudeAgent = agent.id === "claude-acp";
	const isCodexAgent = agent.id === "codex-acp";
	const connectedSecretNames =
		CONNECTED_SECRET_NAMES_BY_AGENT[agent.id] ??
		agent.auth.vars.map((v) => v.name);
	const isConfigured = connectedSecretNames.some((name) =>
		storedSecretNames.has(name)
	);
	const codexAuthSecret = isCodexAgent
		? secrets.find((secret) => secret.name === CODEX_AUTH_SECRET_NAME)
		: undefined;
	const claudeOauthSecret = isClaudeAgent
		? secrets.find(
				(secret) => secret.name === CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME
			)
		: undefined;

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

	const handleCopyCommand = async () => {
		try {
			await navigator.clipboard.writeText(CODEX_IMPORT_COMMAND);
			setCopiedCommand(true);
			setCodexError(null);
		} catch (error) {
			setCodexError(
				error instanceof Error ? error.message : "Failed to copy command"
			);
		}
	};

	const handleCopyClaudeCommand = async () => {
		try {
			await navigator.clipboard.writeText(CLAUDE_SETUP_TOKEN_COMMAND);
			setCopiedClaudeCommand(true);
			setClaudeError(null);
		} catch (error) {
			setClaudeError(
				error instanceof Error ? error.message : "Failed to copy command"
			);
		}
	};

	const handleClaudeImport = async () => {
		setClaudeBusy("import");
		setClaudeError(null);
		try {
			await upsertKey({
				name: CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME,
				apiKey: normalizeClaudeCodeOauthToken(claudeTokenInput),
			});
			setClaudeTokenInput("");
		} catch (error) {
			setClaudeError(
				error instanceof Error
					? error.message
					: "Failed to save Claude Code OAuth token"
			);
		} finally {
			setClaudeBusy(null);
		}
	};

	const handleClaudeDisconnect = async () => {
		setClaudeBusy("disconnect");
		setClaudeError(null);
		try {
			await removeKey({ name: CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME });
		} catch (error) {
			setClaudeError(
				error instanceof Error
					? error.message
					: "Failed to disconnect Claude Code"
			);
		} finally {
			setClaudeBusy(null);
		}
	};

	const handleCodexImport = async () => {
		setCodexBusy("import");
		setCodexError(null);
		try {
			const authJson = validateCodexAuthJson(decodeCodexImportBlob(importBlob));
			await upsertKey({
				name: CODEX_AUTH_SECRET_NAME,
				apiKey: authJson,
			});
			setImportBlob("");
		} catch (error) {
			setCodexError(
				error instanceof Error ? error.message : "Failed to import Codex auth"
			);
		} finally {
			setCodexBusy(null);
		}
	};

	const handleCodexDisconnect = async () => {
		setCodexBusy("disconnect");
		setCodexError(null);
		try {
			await removeKey({ name: CODEX_AUTH_SECRET_NAME });
		} catch (error) {
			setCodexError(
				error instanceof Error ? error.message : "Failed to disconnect Codex"
			);
		} finally {
			setCodexBusy(null);
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
				{isClaudeAgent && (
					<ClaudeOauthSection
						claudeBusy={claudeBusy}
						claudeError={claudeError}
						claudeOauthSecret={claudeOauthSecret}
						claudeTokenInput={claudeTokenInput}
						copiedClaudeCommand={copiedClaudeCommand}
						onClaudeDisconnect={handleClaudeDisconnect}
						onClaudeImport={handleClaudeImport}
						onClaudeTokenInputChange={setClaudeTokenInput}
						onCopyClaudeCommand={handleCopyClaudeCommand}
					/>
				)}
				{isCodexAgent && (
					<div className="rounded-md border p-2">
						<div className="mb-2 flex items-center justify-between gap-2">
							<div>
								<div className="font-medium text-sm">Codex account</div>
								<div className="text-muted-foreground text-xs">
									{codexAuthSecret
										? `Connected: ${codexAuthSecret.hint ?? "Connected"}`
										: "Import your local Codex auth from a machine where Codex is already logged in."}
								</div>
							</div>
							{codexAuthSecret && (
								<Button
									disabled={codexBusy !== null}
									onClick={handleCodexDisconnect}
									size="sm"
									variant="ghost"
								>
									{codexBusy === "disconnect"
										? "Disconnecting..."
										: "Disconnect"}
								</Button>
							)}
						</div>
						<div className="mb-2 flex flex-wrap items-center gap-2">
							<Button
								disabled={codexBusy !== null}
								onClick={handleCopyCommand}
								size="sm"
								variant="outline"
							>
								{copiedCommand ? "Copied command" : "Copy command"}
							</Button>
							<span className="text-muted-foreground text-xs">
								Run it locally, then paste the output below.
							</span>
						</div>
						<Textarea
							className="mb-2 min-h-24 text-xs"
							onChange={(event) => setImportBlob(event.target.value)}
							placeholder="Paste the command output here"
							value={importBlob}
						/>
						<div className="flex items-center gap-2">
							<Button
								disabled={!importBlob.trim() || codexBusy !== null}
								onClick={handleCodexImport}
								size="sm"
							>
								{codexBusy === "import" ? "Importing..." : "Import auth"}
							</Button>
							<span className="text-muted-foreground text-xs">
								Re-import any time to refresh or replace the stored auth.
							</span>
						</div>
						{codexError && (
							<div className="mt-2 text-destructive text-xs">{codexError}</div>
						)}
					</div>
				)}
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

	if (secrets === undefined) {
		return (
			<div className="p-6">
				<h1 className="font-semibold text-lg">Agents</h1>
				<p className="mt-1 mb-4 text-muted-foreground text-sm">
					Configure API keys and subscription auth for ACP coding agents.
				</p>
				<div className="flex flex-col gap-3">
					<Skeleton className="h-16 w-full" />
					<Skeleton className="h-16 w-full" />
					<Skeleton className="h-16 w-full" />
				</div>
			</div>
		);
	}

	return (
		<div className="p-6">
			<h1 className="font-semibold text-lg">Agents</h1>
			<p className="mt-1 mb-4 text-muted-foreground text-sm">
				Configure API keys and subscription auth for ACP coding agents.
			</p>

			<div className="flex flex-col gap-3">
				{configurableAgents.map((agent) => (
					<AgentCard
						agent={agent as AcpAgent & { auth: NonNullable<AcpAgent["auth"]> }}
						key={agent.id}
						secrets={secrets}
					/>
				))}
			</div>
		</div>
	);
}
