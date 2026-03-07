import type * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
	return (
		<textarea
			className={cn(
				"w-full min-w-0 resize-none rounded-md border-none bg-transparent px-0 py-2 text-sm outline-none placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
				className
			)}
			data-slot="textarea"
			{...props}
		/>
	);
}

export { Textarea };
