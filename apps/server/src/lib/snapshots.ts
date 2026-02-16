import { createLogger } from "@corporation/logger";
import { type Daytona, Image } from "@daytonaio/sdk";

const log = createLogger("snapshots");

export function repoSnapshotName(owner: string, name: string): string {
	return `repo-${owner}-${name}`;
}

export async function buildRepoSnapshot(
	daytona: Daytona,
	owner: string,
	name: string,
	branch: string,
	githubToken: string,
	installCommand: string
): Promise<string> {
	const snapshotName = repoSnapshotName(owner, name);

	try {
		const existing = await daytona.snapshot.get(snapshotName);
		await daytona.snapshot.delete(existing);
		log.info({ snapshotName }, "deleted existing repo snapshot");
	} catch {
		// Snapshot doesn't exist yet
	}

	log.info(
		{ snapshotName, repo: `${owner}/${name}` },
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
			"curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/install.sh | sh",
			"sandbox-agent install-agent claude",
			`git clone https://x-access-token:${githubToken}@github.com/${owner}/${name}.git /home/daytona/project --branch ${branch} --single-branch`,
			`cd /home/daytona/project && ${installCommand}`
		),
	});
	log.info({ snapshotName }, "repo snapshot built");

	return snapshotName;
}
