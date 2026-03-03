import { Sandbox } from "e2b";
import { Hono } from "hono";
import { SandboxAgent as SandboxAgentClient } from "sandbox-agent";
import { authMiddleware } from "./auth";

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
]);
const SANITIZE_FILENAME_NON_ALNUM = /[^a-zA-Z0-9._-]/g;
const SANITIZE_FILENAME_DUPLICATE_DASH = /-{2,}/g;
const SANITIZE_FILENAME_LEADING_DOTS = /^\.+/;

type UploadTargetResponse = {
	agentUrl: string;
	sandboxId: string;
	spaceId: string;
};

type UploadFile = {
	name: string;
	type: string;
	size: number;
	arrayBuffer: () => Promise<ArrayBuffer>;
};

function isUploadFile(value: unknown): value is UploadFile {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as Partial<UploadFile>;
	return (
		typeof candidate.name === "string" &&
		typeof candidate.type === "string" &&
		typeof candidate.size === "number" &&
		typeof candidate.arrayBuffer === "function"
	);
}

function sanitizeFileName(name: string): string {
	const trimmed = name.trim();
	const safe = trimmed
		.replaceAll(SANITIZE_FILENAME_NON_ALNUM, "-")
		.replaceAll(SANITIZE_FILENAME_DUPLICATE_DASH, "-")
		.replaceAll(SANITIZE_FILENAME_LEADING_DOTS, "")
		.slice(0, 80);
	return safe.length > 0 ? safe : "attachment";
}

function extensionForMimeType(mimeType: string): string {
	switch (mimeType) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		default:
			return "bin";
	}
}

export const sandboxApp = new Hono<{ Bindings: Env }>()
	.use(authMiddleware)
	.post("/uploads", async (c) => {
		const authorization = c.req.header("authorization");
		if (!authorization) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		const formData = await c.req.formData();
		const spaceSlugRaw = formData.get("spaceSlug");
		const sessionIdRaw = formData.get("sessionId");
		const fileRaw = formData.get("file");

		if (
			typeof spaceSlugRaw !== "string" ||
			typeof sessionIdRaw !== "string" ||
			!isUploadFile(fileRaw)
		) {
			return c.json(
				{ error: "spaceSlug, sessionId, and file are required" },
				400
			);
		}

		const spaceSlug = spaceSlugRaw.trim();
		const sessionId = sessionIdRaw.trim();
		if (!(spaceSlug && sessionId)) {
			return c.json({ error: "spaceSlug and sessionId are required" }, 400);
		}

		if (!ALLOWED_IMAGE_MIME_TYPES.has(fileRaw.type)) {
			return c.json({ error: `Unsupported image type: ${fileRaw.type}` }, 400);
		}
		if (fileRaw.size > MAX_IMAGE_SIZE_BYTES) {
			return c.json({ error: "Image exceeds 5MB limit" }, 400);
		}

		const uploadTargetResponse = await fetch(
			`${c.env.CONVEX_SITE_URL}/sandbox/upload-target`,
			{
				method: "POST",
				headers: {
					Authorization: authorization,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ spaceSlug }),
			}
		);

		if (!uploadTargetResponse.ok) {
			const detail = await uploadTargetResponse.text();
			const status =
				uploadTargetResponse.status === 401 ||
				uploadTargetResponse.status === 404 ||
				uploadTargetResponse.status === 409
					? uploadTargetResponse.status
					: 500;
			return c.json(
				{ error: detail || "Failed to resolve upload target" },
				status
			);
		}

		const target = (await uploadTargetResponse.json()) as UploadTargetResponse;
		const sdk = await SandboxAgentClient.connect({
			baseUrl: target.agentUrl,
		});

		const extension = extensionForMimeType(fileRaw.type);
		const baseName = sanitizeFileName(fileRaw.name || "image");
		const uploadName = baseName.toLowerCase().endsWith(`.${extension}`)
			? baseName
			: `${baseName}.${extension}`;
		const fileBuffer = await fileRaw.arrayBuffer();
		const fileBlob = new Blob([fileBuffer], { type: fileRaw.type });
		const upload = await sdk.writeFsFile(
			{
				path: `./uploads/${sessionId}/${Date.now()}-${uploadName}`,
			},
			fileBlob
		);
		const uri = upload.path.startsWith("file://")
			? upload.path
			: `file://${upload.path}`;

		return c.json({
			name: fileRaw.name || "image",
			mimeType: fileRaw.type,
			uri,
		});
	})
	.get("/preview", async (c) => {
		const sandboxId = c.req.query("sandboxId");
		const portStr = c.req.query("port");

		if (!(sandboxId && portStr)) {
			return c.json({ error: "sandboxId and port are required" }, 400);
		}

		const port = Number.parseInt(portStr, 10);
		if (Number.isNaN(port) || port < 1 || port > 65_535) {
			return c.json({ error: "Invalid port" }, 400);
		}

		const sandbox = await Sandbox.connect(sandboxId, {
			apiKey: c.env.E2B_API_KEY,
		});
		const url = `https://${sandbox.getHost(port)}`;

		return c.json({ url });
	});
