import manifest from "./acp-agent-manifest.json";

const acpAgentManifest = manifest;

export type AcpAgentManifestEntry = (typeof acpAgentManifest)[number];

export function supportsAgentCredentials(
	agent: AcpAgentManifestEntry
): boolean {
	return agent.credentialSupport === "supported";
}

export default acpAgentManifest;
