import { getStageKind } from "@tendril/config/stage-kind";

const ROOT_DOMAIN = "tendril.sh";
const SERVER_LABEL_PREFIX = "server-";
const MAX_DNS_LABEL_LENGTH = 63;
const HASH_LENGTH = 8;

function shortHash(input: string): string {
	let hash = 0;
	for (let index = 0; index < input.length; index += 1) {
		hash = (hash * 31 + input.charCodeAt(index)) % 4_294_967_296;
	}
	return hash.toString(16).padStart(HASH_LENGTH, "0").slice(0, HASH_LENGTH);
}

function getSingleLabelServerSubdomain(stage: string): string {
	const baseLabel = `${SERVER_LABEL_PREFIX}${stage}`;
	if (baseLabel.length <= MAX_DNS_LABEL_LENGTH) {
		return baseLabel;
	}

	const hashSuffix = `-${shortHash(stage)}`;
	const maxStageLength =
		MAX_DNS_LABEL_LENGTH - SERVER_LABEL_PREFIX.length - hashSuffix.length;

	return `${SERVER_LABEL_PREFIX}${stage.slice(0, maxStageLength)}${hashSuffix}`;
}

export function getStageServerHostname(stage: string): string {
	const stageKind = getStageKind(stage);

	if (stageKind === "dev" || stageKind === "sandbox") {
		return `${getSingleLabelServerSubdomain(stage)}.${ROOT_DOMAIN}`;
	}

	if (stageKind === "preview") {
		return `${stage}.${ROOT_DOMAIN}`;
	}

	if (stageKind === "production") {
		return `app.${ROOT_DOMAIN}`;
	}

	throw new Error(
		`Unsupported stage "${stage}" for server hostname resolution.`
	);
}

export function getStageServerUrl(stage: string): string {
	return `https://${getStageServerHostname(stage)}/api`;
}
