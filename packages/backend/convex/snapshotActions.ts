"use node";

import { Daytona, Image } from "@daytonaio/sdk";
import { Nango } from "@nangohq/node";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const GITHUB_PROVIDER_KEY = "github";

async function getGitHubToken(nango: Nango, userId: string): Promise<string> {
	const { connections } = await nango.listConnections({ userId });

	const conn = connections.find(
		(c) => c.provider_config_key === GITHUB_PROVIDER_KEY
	);

	if (!conn) {
		throw new Error("No GitHub connection found for this user");
	}

	const token = await nango.getToken(GITHUB_PROVIDER_KEY, conn.connection_id);

	if (typeof token !== "string") {
		throw new Error("Unexpected token format for GitHub connection");
	}

	return token;
}

export const buildSnapshot = internalAction({
	args: {
		environmentId: v.id("environments"),
	},
	handler: async (ctx, args) => {
		const daytonaApiKey = process.env.DAYTONA_API_KEY;
		const nangoSecretKey = process.env.NANGO_SECRET_KEY;
		if (!(daytonaApiKey && nangoSecretKey)) {
			throw new Error("Missing DAYTONA_API_KEY or NANGO_SECRET_KEY env vars");
		}

		try {
			const envWithRepo = await ctx.runQuery(
				internal.environments.internalGet,
				{ id: args.environmentId }
			);

			const { repository } = envWithRepo;
			const nango = new Nango({ secretKey: nangoSecretKey });
			const githubToken = await getGitHubToken(nango, envWithRepo.userId);

			const branchRes = await fetch(
				`https://api.github.com/repos/${repository.owner}/${repository.name}/branches/${repository.defaultBranch}`,
				{
					headers: {
						Authorization: `Bearer ${githubToken}`,
						Accept: "application/vnd.github+json",
					},
				}
			);
			const snapshotCommitSha = branchRes.ok
				? ((await branchRes.json()) as { commit: { sha: string } }).commit.sha
				: undefined;

			const daytona = new Daytona({ apiKey: daytonaApiKey });
			const snapshotName = `repo-${repository.owner}-${repository.name}-${Date.now()}`;

			await daytona.snapshot.create({
				name: snapshotName,
				resources: { cpu: 4, memory: 8, disk: 10 },
				image: Image.base("ubuntu:22.04")
					.runCommands(
						"apt-get update && apt-get install -y curl ca-certificates git unzip zsh",
						'sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" -- --unattended',
						"chsh -s $(which zsh)",
						"curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs",
						"npm install -g yarn pnpm",
						"curl -fsSL https://bun.sh/install | bash && ln -s /root/.bun/bin/bun /usr/local/bin/bun",
						"curl -fsSL https://releases.rivet.dev/sandbox-agent/0.2.1/install.sh | sh",
						"sandbox-agent install-agent claude",
						"sandbox-agent install-agent opencode",
						`git clone https://x-access-token:${githubToken}@github.com/${repository.owner}/${repository.name}.git /root/${repository.owner}-${repository.name} --branch ${repository.defaultBranch} --single-branch`,
						`cd /root/${repository.owner}-${repository.name} && ${repository.setupCommand}`
					)
					.workdir(`/root/${repository.owner}-${repository.name}`),
			});

			await ctx.runMutation(internal.environments.completeSnapshotBuild, {
				id: args.environmentId,
				snapshotName,
				snapshotCommitSha,
			});
		} catch (error) {
			await ctx.runMutation(internal.environments.internalUpdate, {
				id: args.environmentId,
				snapshotStatus: "error",
			});

			throw error;
		}
	},
});

export const deleteSnapshot = internalAction({
	args: {
		snapshotName: v.string(),
	},
	handler: async (_ctx, args) => {
		const daytonaApiKey = process.env.DAYTONA_API_KEY;
		if (!daytonaApiKey) {
			throw new Error("Missing DAYTONA_API_KEY env var");
		}

		const daytona = new Daytona({ apiKey: daytonaApiKey });
		const snapshot = await daytona.snapshot.get(args.snapshotName);
		await daytona.snapshot.delete(snapshot);
	},
});
