import type {
	RuntimeAvailableCommand,
	RuntimeMessage,
	RuntimeMessagePart,
	RuntimePermissionRequest,
	RuntimeSession,
	RuntimeSessionConfigOption,
	RuntimeTodo,
	RuntimeUsage,
} from "./runtime-types";

export type RuntimeEvent =
	| {
			type: "session.created";
			session: RuntimeSession;
	  }
	| {
			type: "session.updated";
			session: RuntimeSession;
	  }
	| {
			type: "session.status";
			sessionId: string;
			status: "idle" | "busy";
	  }
	| {
			type: "session.idle";
			sessionId: string;
	  }
	| {
			type: "session.error";
			sessionId: string;
			error: string;
	  }
	| {
			type: "session.mode.updated";
			sessionId: string;
			modeId: string;
	  }
	| {
			type: "session.config.updated";
			sessionId: string;
			configOptions: RuntimeSessionConfigOption[];
	  }
	| {
			type: "session.info.updated";
			sessionId: string;
			title?: string;
			updatedAt?: string;
	  }
	| {
			type: "session.available_commands.updated";
			sessionId: string;
			commands: RuntimeAvailableCommand[];
	  }
	| {
			type: "message.updated";
			message: RuntimeMessage;
	  }
	| {
			type: "message.part.updated";
			part: RuntimeMessagePart;
	  }
	| {
			type: "message.part.delta";
			sessionId: string;
			messageId: string;
			partId: string;
			field: "text";
			delta: string;
	  }
	| {
			type: "permission.requested";
			request: RuntimePermissionRequest;
	  }
	| {
			type: "permission.responded";
			requestId: string;
			sessionId: string;
			reply: "once" | "always" | "reject";
	  }
	| {
			type: "todo.updated";
			sessionId: string;
			todos: RuntimeTodo[];
	  }
	| {
			type: "usage.updated";
			sessionId: string;
			usage: RuntimeUsage;
	  };
