import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useMutation as useTanstackMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { nanoid } from "nanoid";
import { type FC, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ChatInput } from "@/components/chat/chat-input";
import { ChatMessages } from "@/components/chat/chat-messages";
import type {
	ComposerImageAttachment,
	PromptAttachment,
} from "@/components/chat/types";
import { useSessionEventState } from "@/hooks/use-session-event-state";
import { apiClient } from "@/lib/api-client";
import type { SpaceActor } from "@/lib/rivetkit";
import { serializeTab } from "@/lib/tab-routing";
import { usePendingMessageStore } from "@/stores/pending-message-store";

const MAX_IMAGE_COUNT = 6;
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_SIZE_BYTES = 15 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
]);

type PromptPayload = {
	text: string;
	attachments: PromptAttachment[];
};

type UploadResponse = {
	name: string;
	mimeType: string;
	uri: string;
};

function createComposerAttachment(file: File): ComposerImageAttachment {
	return {
		id: nanoid(),
		file,
		name: file.name || "image",
		mimeType: file.type,
		size: file.size,
		previewUrl: URL.createObjectURL(file),
	};
}

function revokeComposerAttachments(
	attachments: ComposerImageAttachment[]
): void {
	for (const attachment of attachments) {
		URL.revokeObjectURL(attachment.previewUrl);
	}
}

async function uploadImageAttachment(
	spaceSlug: string,
	sessionId: string,
	attachment: ComposerImageAttachment
): Promise<PromptAttachment> {
	const response = await apiClient.sandbox.uploads.$post({
		form: {
			spaceSlug,
			sessionId,
			file: attachment.file,
		},
	});
	const data = (await response.json()) as
		| UploadResponse
		| { error?: string }
		| Record<string, unknown>;

	if (!response.ok) {
		const errorMessage =
			typeof (data as { error?: unknown }).error === "string"
				? (data as { error: string }).error
				: "Failed to upload image";
		throw new Error(errorMessage);
	}

	if (
		typeof (data as { name?: unknown }).name !== "string" ||
		typeof (data as { mimeType?: unknown }).mimeType !== "string" ||
		typeof (data as { uri?: unknown }).uri !== "string"
	) {
		throw new Error("Upload response is invalid");
	}

	const uploaded = data as UploadResponse;
	return {
		name: uploaded.name,
		mimeType: uploaded.mimeType,
		uri: uploaded.uri,
	};
}

async function buildPromptPayload(
	spaceSlug: string,
	sessionId: string,
	text: string,
	images: ComposerImageAttachment[]
): Promise<PromptPayload> {
	const uploadedAttachments = await Promise.all(
		images.map((attachment) =>
			uploadImageAttachment(spaceSlug, sessionId, attachment)
		)
	);
	return {
		text,
		attachments: uploadedAttachments,
	};
}

export const SessionView: FC<{
	actor: SpaceActor;
	sessionId: string | undefined;
	spaceSlug: string | undefined;
}> = ({ actor, sessionId, spaceSlug }) => {
	if (!spaceSlug) {
		return <NewSpaceView />;
	}

	if (sessionId && actor) {
		return (
			<ConnectedSessionView
				actor={actor}
				key={sessionId}
				sessionId={sessionId}
				spaceSlug={spaceSlug}
			/>
		);
	}

	return <NewSessionView key={spaceSlug} spaceSlug={spaceSlug} />;
};

const NewSpaceView: FC = () => {
	const navigate = useNavigate();
	const setPending = usePendingMessageStore((s) => s.setPending);
	const [message, setMessage] = useState("");
	const [images, setImages] = useState<ComposerImageAttachment[]>([]);
	const [isUploadingImage, setIsUploadingImage] = useState(false);

	const repositories = useQuery(api.repositories.list);
	const firstRepo = repositories?.[0];
	const environments = useQuery(
		api.environments.listByRepository,
		firstRepo ? { repositoryId: firstRepo._id } : "skip"
	);
	const firstEnv = environments?.[0];

	const handlePasteImages = useCallback(
		(files: File[]) => {
			setIsUploadingImage(true);
			try {
				const totalSize = images.reduce((sum, image) => sum + image.size, 0);
				let nextTotalSize = totalSize;
				let nextCount = images.length;
				const validFiles: File[] = [];

				for (const file of files) {
					if (!ALLOWED_IMAGE_MIME_TYPES.has(file.type)) {
						toast.error(`Unsupported image type: ${file.type || "unknown"}`);
						continue;
					}
					if (file.size > MAX_IMAGE_SIZE_BYTES) {
						toast.error(`Image ${file.name} exceeds 5MB`);
						continue;
					}
					if (nextCount + 1 > MAX_IMAGE_COUNT) {
						toast.error("Cannot attach more than 6 images");
						break;
					}
					if (nextTotalSize + file.size > MAX_TOTAL_IMAGE_SIZE_BYTES) {
						toast.error("Total image attachments exceed 15MB");
						break;
					}
					nextCount += 1;
					nextTotalSize += file.size;
					validFiles.push(file);
				}

				setImages((current) => [
					...current,
					...validFiles.map(createComposerAttachment),
				]);
			} catch (error) {
				console.error("Failed to process pasted image", error);
				toast.error("Failed to attach image");
			} finally {
				setIsUploadingImage(false);
			}
		},
		[images]
	);

	const handleRemoveImage = useCallback((attachmentId: string) => {
		setImages((current) => {
			const removed = current.find(
				(attachment) => attachment.id === attachmentId
			);
			if (removed) {
				URL.revokeObjectURL(removed.previewUrl);
			}
			return current.filter((attachment) => attachment.id !== attachmentId);
		});
	}, []);

	const handleSend = useCallback(() => {
		const text = message.trim();
		if (!(firstEnv && (text || images.length > 0))) {
			return;
		}

		const spaceSlug = nanoid();
		const sessionId = nanoid();
		setPending({ text, images, environmentId: firstEnv._id });
		setMessage("");
		setImages([]);

		navigate({
			to: "/space/$spaceSlug",
			params: { spaceSlug },
			search: {
				tab: serializeTab({ type: "session", id: sessionId }),
			},
		});
	}, [message, images, firstEnv, setPending, navigate]);

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-background">
			<div className="flex flex-1 flex-col items-center justify-center px-4">
				<h1 className="font-semibold text-2xl">Hello there!</h1>
				<p className="mt-1 text-muted-foreground text-xl">
					How can I help you today?
				</p>
			</div>
			<ChatInput
				attachments={images}
				canSend={
					!isUploadingImage && Boolean(message.trim() || images.length > 0)
				}
				disabled={!firstEnv}
				isUploading={isUploadingImage}
				message={message}
				onMessageChange={setMessage}
				onPasteImages={handlePasteImages}
				onRemoveAttachment={handleRemoveImage}
				onSendMessage={handleSend}
				placeholder="Send a message..."
			/>
		</div>
	);
};

const NewSessionView: FC<{ spaceSlug: string }> = ({ spaceSlug }) => {
	const navigate = useNavigate();
	const setPending = usePendingMessageStore((s) => s.setPending);
	const [message, setMessage] = useState("");
	const [images, setImages] = useState<ComposerImageAttachment[]>([]);
	const [isUploadingImage, setIsUploadingImage] = useState(false);

	const handlePasteImages = useCallback(
		(files: File[]) => {
			setIsUploadingImage(true);
			try {
				const totalSize = images.reduce((sum, image) => sum + image.size, 0);
				let nextTotalSize = totalSize;
				let nextCount = images.length;
				const validFiles: File[] = [];

				for (const file of files) {
					if (!ALLOWED_IMAGE_MIME_TYPES.has(file.type)) {
						toast.error(`Unsupported image type: ${file.type || "unknown"}`);
						continue;
					}
					if (file.size > MAX_IMAGE_SIZE_BYTES) {
						toast.error(`Image ${file.name} exceeds 5MB`);
						continue;
					}
					if (nextCount + 1 > MAX_IMAGE_COUNT) {
						toast.error("Cannot attach more than 6 images");
						break;
					}
					if (nextTotalSize + file.size > MAX_TOTAL_IMAGE_SIZE_BYTES) {
						toast.error("Total image attachments exceed 15MB");
						break;
					}
					nextCount += 1;
					nextTotalSize += file.size;
					validFiles.push(file);
				}

				setImages((current) => [
					...current,
					...validFiles.map(createComposerAttachment),
				]);
			} catch (error) {
				console.error("Failed to process pasted image", error);
				toast.error("Failed to attach image");
			} finally {
				setIsUploadingImage(false);
			}
		},
		[images]
	);

	const handleRemoveImage = useCallback((attachmentId: string) => {
		setImages((current) => {
			const removed = current.find(
				(attachment) => attachment.id === attachmentId
			);
			if (removed) {
				URL.revokeObjectURL(removed.previewUrl);
			}
			return current.filter((attachment) => attachment.id !== attachmentId);
		});
	}, []);

	const handleSend = useCallback(() => {
		const text = message.trim();
		if (!(text || images.length > 0)) {
			return;
		}

		const sessionId = nanoid();
		setPending({ text, images, spaceSlug });
		setMessage("");
		setImages([]);

		navigate({
			to: "/space/$spaceSlug",
			params: { spaceSlug },
			search: {
				tab: serializeTab({ type: "session", id: sessionId }),
			},
		});
	}, [message, images, setPending, spaceSlug, navigate]);

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-background">
			<div className="flex flex-1 flex-col items-center justify-center px-4">
				<h1 className="font-semibold text-2xl">Hello there!</h1>
				<p className="mt-1 text-muted-foreground text-xl">
					How can I help you today?
				</p>
			</div>
			<ChatInput
				attachments={images}
				canSend={
					!isUploadingImage && Boolean(message.trim() || images.length > 0)
				}
				disabled={false}
				isUploading={isUploadingImage}
				message={message}
				onMessageChange={setMessage}
				onPasteImages={handlePasteImages}
				onRemoveAttachment={handleRemoveImage}
				onSendMessage={handleSend}
				placeholder="Send a message..."
			/>
		</div>
	);
};

const ConnectedSessionView: FC<{
	sessionId: string;
	spaceSlug: string;
	actor: SpaceActor;
}> = ({ sessionId, spaceSlug, actor }) => {
	const [message, setMessage] = useState("");
	const [images, setImages] = useState<ComposerImageAttachment[]>([]);
	const [isUploadingImage, setIsUploadingImage] = useState(false);
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const consumePending = usePendingMessageStore((s) => s.consumePending);
	const ensureSpace = useMutation(api.spaces.ensure);
	const space = useQuery(api.spaces.getBySlug, { slug: spaceSlug });

	const pendingDraftRef = useRef<{
		text: string;
		images: ComposerImageAttachment[];
	} | null>(null);

	const initMutation = useTanstackMutation({
		mutationFn: async (pending: {
			text: string;
			images: ComposerImageAttachment[];
			environmentId?: Id<"environments">;
		}) => {
			await ensureSpace({
				slug: spaceSlug,
				environmentId: pending.environmentId,
			});
			pendingDraftRef.current = {
				text: pending.text,
				images: pending.images,
			};
		},
		onError: (error) => {
			toast.error("Failed to start chat");
			console.error("initMutation failed", error);
		},
	});

	useEffect(() => {
		if (initMutation.isPending || initMutation.isSuccess) {
			return;
		}

		const consumed = consumePending();
		if (!consumed) {
			return;
		}

		initMutation.mutate(consumed);
	}, [
		consumePending,
		initMutation.isPending,
		initMutation.isSuccess,
		initMutation.mutate,
	]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: initMutation.isSuccess is intentionally included to re-trigger this effect when the mutation completes, since it sets pendingDraftRef (a ref that doesn't cause re-renders on its own).
	useEffect(() => {
		if (actor.connStatus !== "connected" || !actor.connection) {
			return;
		}

		if (!space?.agentUrl) {
			return;
		}

		const pendingDraft = pendingDraftRef.current;
		if (!pendingDraft) {
			return;
		}
		pendingDraftRef.current = null;

		const conn = actor.connection;
		(async () => {
			setIsUploadingImage(pendingDraft.images.length > 0);
			try {
				const prompt = await buildPromptPayload(
					spaceSlug,
					sessionId,
					pendingDraft.text,
					pendingDraft.images
				);
				await conn.sendPrompt(sessionId, prompt);
				revokeComposerAttachments(pendingDraft.images);
			} catch (error) {
				console.error("Failed to send pending message", error);
				setMessage((current) => (current ? current : pendingDraft.text));
				setImages((current) =>
					current.length > 0 ? current : pendingDraft.images
				);
				toast.error("Failed to send pending message");
			} finally {
				setIsUploadingImage(false);
			}
		})();
	}, [
		actor.connStatus,
		actor.connection,
		sessionId,
		space?.agentUrl,
		initMutation.isSuccess,
		spaceSlug,
	]);

	const sessionState = useSessionEventState({ sessionId, actor });

	const handlePasteImages = useCallback(
		(files: File[]) => {
			setIsUploadingImage(true);
			try {
				const totalSize = images.reduce((sum, image) => sum + image.size, 0);
				let nextTotalSize = totalSize;
				let nextCount = images.length;
				const validFiles: File[] = [];

				for (const file of files) {
					if (!ALLOWED_IMAGE_MIME_TYPES.has(file.type)) {
						toast.error(`Unsupported image type: ${file.type || "unknown"}`);
						continue;
					}
					if (file.size > MAX_IMAGE_SIZE_BYTES) {
						toast.error(`Image ${file.name} exceeds 5MB`);
						continue;
					}
					if (nextCount + 1 > MAX_IMAGE_COUNT) {
						toast.error("Cannot attach more than 6 images");
						break;
					}
					if (nextTotalSize + file.size > MAX_TOTAL_IMAGE_SIZE_BYTES) {
						toast.error("Total image attachments exceed 15MB");
						break;
					}
					nextCount += 1;
					nextTotalSize += file.size;
					validFiles.push(file);
				}

				setImages((current) => [
					...current,
					...validFiles.map(createComposerAttachment),
				]);
			} catch (error) {
				console.error("Failed to process pasted image", error);
				toast.error("Failed to attach image");
			} finally {
				setIsUploadingImage(false);
			}
		},
		[images]
	);

	const handleRemoveImage = useCallback((attachmentId: string) => {
		setImages((current) => {
			const removed = current.find(
				(attachment) => attachment.id === attachmentId
			);
			if (removed) {
				URL.revokeObjectURL(removed.previewUrl);
			}
			return current.filter((attachment) => attachment.id !== attachmentId);
		});
	}, []);

	const handleSend = useCallback(async () => {
		const text = message.trim();
		if (!(text || images.length > 0)) {
			return;
		}

		const outboundImages = images;
		setMessage("");
		setImages([]);
		setIsUploadingImage(outboundImages.length > 0);

		try {
			await ensureSpace({ slug: spaceSlug });

			const conn = actor.connection;
			if (!conn) {
				throw new Error("Actor connection is unavailable");
			}

			const prompt = await buildPromptPayload(
				spaceSlug,
				sessionId,
				text,
				outboundImages
			);
			await conn.sendPrompt(sessionId, prompt);
			revokeComposerAttachments(outboundImages);
		} catch (error) {
			console.error("Failed to send message", { error, sessionId });
			setMessage((current) => (current ? current : text));
			setImages((current) => (current.length > 0 ? current : outboundImages));
			toast.error("Failed to send message");
		} finally {
			setIsUploadingImage(false);
		}
	}, [message, images, ensureSpace, spaceSlug, actor.connection, sessionId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally scroll when entries change
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [sessionState.entries]);

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-background">
			{sessionState.entries.length === 0 ? (
				<div className="flex flex-1 flex-col items-center justify-center px-4">
					<h1 className="font-semibold text-2xl">Ready to Chat</h1>
					<p className="mt-1 text-muted-foreground">
						Send a message to start a conversation.
					</p>
				</div>
			) : (
				<ChatMessages
					entries={sessionState.entries}
					isThinking={sessionState.isRunning}
					messagesEndRef={messagesEndRef}
				/>
			)}
			<ChatInput
				attachments={images}
				canSend={
					!isUploadingImage && Boolean(message.trim() || images.length > 0)
				}
				disabled={actor.connStatus !== "connected" || !actor.connection}
				isUploading={isUploadingImage}
				message={message}
				onMessageChange={setMessage}
				onPasteImages={handlePasteImages}
				onRemoveAttachment={handleRemoveImage}
				onSendMessage={handleSend}
				placeholder="Send a message..."
			/>
		</div>
	);
};
