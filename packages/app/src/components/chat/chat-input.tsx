import { ArrowUpIcon } from "lucide-react";
import { useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";

export function ChatInput({
	message,
	onMessageChange,
	onSendMessage,
	placeholder,
	disabled,
}: {
	message: string;
	onMessageChange: (value: string) => void;
	onSendMessage: () => void;
	placeholder: string;
	disabled: boolean;
}) {
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				onSendMessage();
			}
		},
		[onSendMessage]
	);

	return (
		<div className="sticky bottom-0 mx-auto w-full max-w-[44rem] px-4 pb-4">
			<div className="flex items-end gap-2 rounded-2xl border border-input bg-background px-4 py-2 shadow-sm transition-shadow focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
				<textarea
					className="max-h-32 min-h-10 w-full resize-none bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground"
					disabled={disabled}
					onChange={(e) => onMessageChange(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder={placeholder}
					ref={textareaRef}
					rows={1}
					value={message}
				/>
				<Button
					className="mb-1 size-8 shrink-0 rounded-full"
					disabled={disabled || !message.trim()}
					onClick={onSendMessage}
					size="icon"
				>
					<ArrowUpIcon className="size-4" />
					<span className="sr-only">Send message</span>
				</Button>
			</div>
		</div>
	);
}
