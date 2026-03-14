import { Nango } from "@nangohq/node";
import { Octokit } from "octokit";

const GITHUB_PROVIDER_KEY = "github";

type GitHubListReposOutput = {
	repositories: Array<{
		id: number;
		name: string;
		fullName: string;
		owner: string;
		defaultBranch: string;
		private: boolean;
		url: string;
	}>;
};

async function getGitHubToken(env: Env, userId: string): Promise<string> {
	const nango = new Nango({ secretKey: env.NANGO_SECRET_KEY });
	const { connections } = await nango.listConnections({ userId });

	const conn = connections.find(
		(connection) => connection.provider_config_key === GITHUB_PROVIDER_KEY
	);
	if (!conn) {
		throw new Error("No GitHub connection found");
	}

	const token = await nango.getToken(GITHUB_PROVIDER_KEY, conn.connection_id);
	if (typeof token !== "string") {
		throw new Error("Unexpected token format");
	}

	return token;
}

export async function listGitHubRepos(
	env: Env,
	userId: string
): Promise<GitHubListReposOutput> {
	const token = await getGitHubToken(env, userId);
	const octokit = new Octokit({ auth: token });
	const repos = await octokit.paginate(
		octokit.rest.repos.listForAuthenticatedUser,
		{
			per_page: 100,
			visibility: "all",
			affiliation: "owner,collaborator,organization_member",
			sort: "updated",
			direction: "desc",
		}
	);

	return {
		repositories: repos.map((repo) => ({
			id: repo.id,
			name: repo.name,
			fullName: repo.full_name,
			owner: repo.owner.login,
			defaultBranch: repo.default_branch,
			private: repo.private,
			url: repo.html_url,
		})),
	};
}
