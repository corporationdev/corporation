import { ArrowUpIcon, SquareIcon } from "lucide-react";
import { useCallback, useRef } from "react";
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
}: {
	message: string;
	onMessageChange: (value: string) => void;
	onSendMessage: () => void;
	onStop?: () => void;
	isRunning?: boolean;
	placeholder: string;
	disabled: boolean;
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
			<div className="flex items-end gap-2 rounded-2xl border border-input bg-background px-4 py-2 shadow-sm transition-shadow focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
				<Textarea
					className="max-h-48 min-h-[2.5rem]"
					disabled={disabled}
					onChange={handleChange}
					onKeyDown={handleKeyDown}
					placeholder={placeholder}
					ref={textareaRef}
					rows={1}
					value={message}
				/>
				{isRunning && onStop ? (
					<Button
						className="mb-1 size-8 shrink-0 rounded-full"
						onClick={onStop}
						size="icon"
						variant="destructive"
					>
						<SquareIcon className="size-3" />
						<span className="sr-only">Stop</span>
					</Button>
				) : (
					<Button
						className="mb-1 size-8 shrink-0 rounded-full"
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
	);
}
