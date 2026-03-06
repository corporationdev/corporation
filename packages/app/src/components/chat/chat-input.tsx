import { ArrowUpIcon, SquareIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function ChatInput({
	message,
	onMessageChange,
	onSendMessage,
	onStop,
	isRunning = false,
	placeholder,
	disabled,
	footer,
}: {
	message: string;
	onMessageChange: (value: string) => void;
	onSendMessage: () => void;
	onStop?: () => void;
	isRunning?: boolean;
	placeholder: string;
	disabled: boolean;
	footer?: ReactNode;
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

	useEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea) {
			return;
		}

		if (message.length === 0) {
			textarea.style.height = "";
			return;
		}

		adjustHeight();
	}, [message, adjustHeight]);

	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			onMessageChange(e.target.value);
			adjustHeight();
		},
		[onMessageChange, adjustHeight]
	);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				if (isRunning && onStop) {
					onStop();
					return;
				}
				onSendMessage();
			}
		},
		[isRunning, onSendMessage, onStop]
	);

	return (
		<div className="sticky bottom-0 mx-auto w-full max-w-[44rem] px-4 pb-4">
			<div className="flex flex-col rounded-2xl border border-input bg-background shadow-sm transition-shadow focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
				<div className="flex items-end gap-2 px-4 pt-3 pb-1">
					<Textarea
						className="max-h-48 min-h-[4.5rem]"
						disabled={disabled}
						onChange={handleChange}
						onKeyDown={handleKeyDown}
						placeholder={placeholder}
						ref={textareaRef}
						rows={3}
						value={message}
					/>
				</div>
				<div className="flex items-center justify-between px-4 pb-3">
					<div className="flex items-center">{footer}</div>
					{isRunning && onStop ? (
						<Button
							className="size-8 shrink-0 rounded-full"
							onClick={onStop}
							size="icon"
							variant="destructive"
						>
							<SquareIcon className="size-3" />
							<span className="sr-only">Stop</span>
						</Button>
					) : (
						<Button
							className="size-8 shrink-0 rounded-full"
							disabled={disabled || !message.trim()}
							onClick={onSendMessage}
							size="icon"
						>
							<ArrowUpIcon className="size-4" />
							<span className="sr-only">Send message</span>
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}
