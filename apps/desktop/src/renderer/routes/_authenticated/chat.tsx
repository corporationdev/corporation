import { createFileRoute } from "@tanstack/react-router";

import { Thread } from "@/components/assistant-ui/thread";
import { ChatLayout } from "@/components/chat-layout";

export const Route = createFileRoute("/_authenticated/chat")({
	component: ChatRoute,
});

function ChatRoute() {
	return (
		<ChatLayout>
			<Thread />
		</ChatLayout>
	);
}
