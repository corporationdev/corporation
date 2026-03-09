import manifest from "./acp-agent-manifest.json";

const acpAgentManifest = manifest;

export type AcpAgentManifestEntry = (typeof acpAgentManifest)[number];

export default acpAgentManifest;
