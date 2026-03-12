"use node";

import { dirname } from "node:path";
import acpAgents, {
	type AcpAgentManifestEntry,
	supportsAgentCredentials,
} from "@corporation/config/acp-agent-manifest";
import { FileType, type Sandbox } from "e2b";
import { SANDBOX_HOME_DIR } from "./sandbox";

export type StoredAgentCredentialBundle = {
	schemaVersion: number;
	files: Array<{
		path: string;
		contentBase64: string;
	}>;
};

export const credentialEnabledAgents = acpAgents.filter(
	(
		agent
	): agent is AcpAgentManifestEntry & {
		credentialBundle: NonNullable<AcpAgentManifestEntry["credentialBundle"]>;
	} => supportsAgentCredentials(agent) && agent.credentialBundle !== null
);

export const credentialEnabledAgentIds = new Set(
	credentialEnabledAgents.map((agent) => agent.id)
);

export function getCredentialEnabledAgent(agentId: string) {
	return credentialEnabledAgents.find((agent) => agent.id === agentId) ?? null;
}

function resolveSandboxPath(path: string) {
	if (path === "$HOME") {
		return SANDBOX_HOME_DIR;
	}

	if (path.startsWith("$HOME/")) {
		return `${SANDBOX_HOME_DIR}/${path.slice("$HOME/".length)}`;
	}

	return path;
}

function shellEscape(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function pathExistsInSandbox(sandbox: Sandbox, path: string) {
	const result = await sandbox.commands.run(
		`if test -e ${shellEscape(path)}; then printf present; else printf missing; fi`,
		{
			timeoutMs: 5000,
		}
	);

	return result.stdout.trim() === "present";
}

export async function collectAgentCredentialBundle(
	sandbox: Sandbox,
	agent: AcpAgentManifestEntry & {
		credentialBundle: NonNullable<AcpAgentManifestEntry["credentialBundle"]>;
	}
): Promise<StoredAgentCredentialBundle> {
	const files: StoredAgentCredentialBundle["files"] = [];

	for (const entry of agent.credentialBundle.paths) {
		const remotePath = resolveSandboxPath(entry.path);
		const exists = await pathExistsInSandbox(sandbox, remotePath);
		if (!exists) {
			if (entry.required) {
				throw new Error(
					`Missing required credential path for ${agent.id}: ${remotePath}`
				);
			}
			continue;
		}

		if (entry.kind === "file") {
			const data = await sandbox.files.read(remotePath, { format: "blob" });
			files.push({
				path: remotePath,
				contentBase64: Buffer.from(await data.arrayBuffer()).toString("base64"),
			});
			continue;
		}

		const listed = await sandbox.files.list(remotePath, { depth: 32 });
		for (const listedEntry of listed) {
			if (listedEntry.type !== FileType.FILE) {
				continue;
			}
			const data = await sandbox.files.read(listedEntry.path, {
				format: "blob",
			});
			files.push({
				path: listedEntry.path,
				contentBase64: Buffer.from(await data.arrayBuffer()).toString("base64"),
			});
		}
	}

	return {
		schemaVersion: agent.credentialBundle.schemaVersion,
		files,
	};
}

export async function restoreAgentCredentialBundle(
	sandbox: Sandbox,
	bundle: StoredAgentCredentialBundle
) {
	if (bundle.files.length === 0) {
		return;
	}

	const parentDirs = Array.from(
		new Set(bundle.files.map((file) => dirname(file.path)))
	);
	for (const path of parentDirs) {
		await sandbox.commands.run(`mkdir -p ${shellEscape(path)}`, {
			timeoutMs: 5000,
		});
	}

	await sandbox.files.write(
		bundle.files.map((file) => ({
			path: file.path,
			data: new Blob([Buffer.from(file.contentBase64, "base64")]),
		}))
	);
}
