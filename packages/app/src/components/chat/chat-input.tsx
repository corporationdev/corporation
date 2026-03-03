import { ArrowUpIcon, XIcon } from "lucide-react";
import { useCallback, useRef } from "react";
import type { ComposerImageAttachment } from "@/components/chat/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function ChatInput({
	message,
	attachments,
	onMessageChange,
	onPasteImages,
	onRemoveAttachment,
	onSendMessage,
	placeholder,
	disabled,
	canSend,
	isUploading,
}: {
	message: string;
	attachments: ComposerImageAttachment[];
	onMessageChange: (value: string) => void;
	onPasteImages: (files: File[]) => void | Promise<void>;
	onRemoveAttachment: (attachmentId: string) => void;
	onSendMessage: () => void;
	placeholder: string;
	disabled: boolean;
	canSend: boolean;
	isUploading: boolean;
}) {
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const adjustHeight = useCallback(() => {
		const textarea = textareaRef.current;
		if (!textarea) {
			return;
		}
		textarea.style.height = "auto";
		textarea.style.height = `${textarea.scrollHeight}px`;
	}, []);

	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			onMessageChange(e.target.value);
			adjustHeight();
		},
		[onMessageChange, adjustHeight]
	);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (event.key === "Enter" && !event.shiftKey && canSend) {
				event.preventDefault();
				onSendMessage();
			}
		},
		[canSend, onSendMessage]
	);

	const handlePaste = useCallback(
		(event: React.ClipboardEvent<HTMLTextAreaElement>) => {
			const imageFiles = Array.from(event.clipboardData.items)
				.filter(
					(item) => item.kind === "file" && item.type.startsWith("image/")
				)
				.map((item) => item.getAsFile())
				.filter((file): file is File => file !== null);
			if (imageFiles.length === 0) {
				return;
			}
			event.preventDefault();
			const maybePromise = onPasteImages(imageFiles);
			if (maybePromise instanceof Promise) {
				maybePromise.catch((error) => {
					console.error("Failed to process pasted image", error);
				});
			}
		},
		[onPasteImages]
	);

	return (
		<div className="sticky bottom-0 mx-auto w-full max-w-[44rem] px-4 pb-4">
			<div className="rounded-2xl border border-input bg-background px-4 py-2 shadow-sm transition-shadow focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
				{attachments.length > 0 && (
					<div className="mb-2 flex gap-2 overflow-x-auto pb-1">
						{attachments.map((attachment) => (
							<div className="relative shrink-0" key={attachment.id}>
								<img
									alt={attachment.name}
									className="h-16 w-16 rounded-md border object-cover"
									height={64}
									src={attachment.previewUrl}
									width={64}
								/>
								<button
									aria-label={`Remove ${attachment.name}`}
									className="absolute -top-1 -right-1 rounded-full border bg-background p-0.5 text-muted-foreground hover:text-foreground"
									onClick={() => onRemoveAttachment(attachment.id)}
									type="button"
								>
									<XIcon className="size-3" />
								</button>
							</div>
						))}
					</div>
				)}
				<div className="flex items-end gap-2">
					<Textarea
						className="max-h-48 min-h-[2.5rem]"
						disabled={disabled}
						onChange={handleChange}
						onKeyDown={handleKeyDown}
						onPaste={handlePaste}
						placeholder={placeholder}
						ref={textareaRef}
						rows={1}
						value={message}
					/>
					<Button
						className="mb-1 size-8 shrink-0 rounded-full"
						disabled={disabled || !canSend}
						onClick={onSendMessage}
						size="icon"
					>
						<ArrowUpIcon className="size-4" />
						<span className="sr-only">Send message</span>
					</Button>
				</div>
				{isUploading && (
					<div className="mt-1 text-muted-foreground text-xs">
						Uploading image...
					</div>
				)}
			</div>
		</div>
	);
}
