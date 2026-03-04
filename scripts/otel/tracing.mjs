// Sandbox-level OTel auto-instrumentation.
// Loaded via NODE_OPTIONS="--import /opt/corporation/otel/tracing.mjs"
// before corp-turn-runner executes. Decoupled from the turn-runner itself.

import { context, propagation, trace } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

const axiomToken = process.env.AXIOM_API_TOKEN;
const axiomDataset = process.env.AXIOM_DATASET || "traces";

if (axiomToken) {
	const exporter = new OTLPTraceExporter({
		url: "https://api.axiom.co/v1/traces",
		headers: {
			Authorization: `Bearer ${axiomToken}`,
			"X-Axiom-Dataset": axiomDataset,
		},
	});

	const sdk = new NodeSDK({
		serviceName: "corporation-sandbox",
		spanProcessor: new BatchSpanProcessor(exporter),
		instrumentations: [
			getNodeAutoInstrumentations({
				// Only instrument fetch/http — skip fs, dns, etc. for less noise
				"@opentelemetry/instrumentation-fs": { enabled: false },
				"@opentelemetry/instrumentation-dns": { enabled: false },
				"@opentelemetry/instrumentation-net": { enabled: false },
			}),
		],
	});

	sdk.start();

	// If TRACEPARENT is set, extract it and create a root span that wraps
	// the entire process, linking sandbox spans to the parent DO trace.
	const traceparent = process.env.TRACEPARENT;
	if (traceparent) {
		const carrier = { traceparent };
		const parentCtx = propagation.extract(context.active(), carrier);
		const tracer = trace.getTracer("corporation-sandbox");
		const rootSpan = tracer.startSpan("sandbox-process", {}, parentCtx);

		// Make this the active span for the rest of the process.
		// All auto-instrumented operations will be children of this span.
		const activeCtx = trace.setSpan(parentCtx, rootSpan);
		context.setGlobalContextManager({
			active: () => activeCtx,
			with: (_ctx, fn, thisArg, ...args) => fn.call(thisArg, ...args),
			bind: (_ctx, target) => target,
			enable: () => context.setGlobalContextManager(this),
			disable: () => {
				// no-op: context manager is process-scoped
			},
		});

		// End the root span and flush on process exit.
		const cleanup = async () => {
			rootSpan.end();
			await sdk.shutdown();
		};
		process.on("beforeExit", cleanup);
		process.on("SIGTERM", async () => {
			await cleanup();
			process.exit(0);
		});
	} else {
		process.on("beforeExit", () => sdk.shutdown());
	}
} else {
	console.warn("[otel] AXIOM_API_TOKEN not set, tracing disabled");
}
