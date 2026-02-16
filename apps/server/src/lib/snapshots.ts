import { createLogger } from "@corporation/logger";
import { type Daytona, Image } from "@daytonaio/sdk";

const log = createLogger("snapshots");

type RepoSnapshotInput = {
	owner: string;
	name: string;
	defaultBranch: string;
	installCommand: string;
};

export async function buildRepoSnapshot(
	daytona: Daytona,
	repo: RepoSnapshotInput,
	githubToken: string
): Promise<string> {
	const snapshotName = `repo-${repo.owner}-${repo.name}-${Date.now()}`;

	log.info(
		{ snapshotName, repo: `${repo.owner}/${repo.name}` },
		"building repo snapshot"
	);
	await daytona.snapshot.create({
		name: snapshotName,
		image: Image.base("ubuntu:22.04").runCommands(
			"apt-get update && apt-get install -y curl ca-certificates git unzip",
			// Install Node.js LTS via NodeSource (puts node/npm on default PATH)
			"curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs",
			// Install package managers
			"npm install -g yarn pnpm",
			"curl -fsSL https://bun.sh/install | bash && ln -s /root/.bun/bin/bun /usr/local/bin/bun",
			// Install sandbox-agent
			"curl -fsSL https://releases.rivet.dev/sandbox-agent/0.1.9/install.sh | sh",
			"sandbox-agent install-agent claude",
			`git clone https://x-access-token:${githubToken}@github.com/${repo.owner}/${repo.name}.git /root/${repo.owner}-${repo.name} --branch ${repo.defaultBranch} --single-branch`,
			`cd /root/${repo.owner}-${repo.name} && ${repo.installCommand}`
		),
	});
	log.info({ snapshotName }, "repo snapshot built");

	return snapshotName;
}

export async function deleteSnapshot(
	daytona: Daytona,
	snapshotName: string
): Promise<void> {
	try {
		const snapshot = await daytona.snapshot.get(snapshotName);
		await daytona.snapshot.delete(snapshot);
		log.info({ snapshotName }, "snapshot deleted");
	} catch {
		log.warn({ snapshotName }, "snapshot not found for deletion");
	}
}
