import {
	type Context,
	context,
	propagation,
	type Span,
	SpanKind,
	type SpanOptions,
	type Tracer,
	trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	CompositePropagator,
	W3CBaggagePropagator,
	W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
	BasicTracerProvider,
	BatchSpanProcessor,
	type BufferConfig,
} from "@opentelemetry/sdk-trace-base";
import {
	ATTR_SERVICE_NAME,
	ATTR_TELEMETRY_SDK_LANGUAGE,
} from "@opentelemetry/semantic-conventions";
import { OTLPTraceExporter } from "./otlp";

export type Carrier = {
	baggage?: string;
	traceparent?: string;
	tracestate?: string;
};

const BUFFER_CONFIG: BufferConfig = {
	scheduledDelayMillis: 3000,
	exportTimeoutMillis: 15_000,
	maxExportBatchSize: 1024,
	maxQueueSize: 1024 * 4,
};

export type TelemetryConfig = {
	axiomApiToken: string;
	axiomDataset: string;
	serviceName: string;
};

let traceProvider: BasicTracerProvider | null = null;

export function init(config: TelemetryConfig): void {
	if (traceProvider) {
		return;
	}

	const resource = resourceFromAttributes({
		[ATTR_SERVICE_NAME]: config.serviceName,
		[ATTR_TELEMETRY_SDK_LANGUAGE]: "js",
		"cloud.platform": "cloudflare.workers",
		"cloud.provider": "cloudflare",
	});

	context.setGlobalContextManager(new AsyncLocalStorageContextManager());
	propagation.setGlobalPropagator(
		new CompositePropagator({
			propagators: [
				new W3CTraceContextPropagator(),
				new W3CBaggagePropagator(),
			],
		})
	);

	traceProvider = new BasicTracerProvider({
		resource,
		spanProcessors: [
			new BatchSpanProcessor(
				new OTLPTraceExporter({
					url: new URL("https://api.axiom.co/v1/traces"),
					headers: {
						Authorization: `Bearer ${config.axiomApiToken}`,
						"X-Axiom-Dataset": config.axiomDataset,
					},
				}),
				BUFFER_CONFIG
			),
		],
	});
	trace.setGlobalTracerProvider(traceProvider);
}

export function tracer(name = "corporation"): Tracer {
	return trace.getTracer(name);
}

export function activeSpan(): Span | undefined {
	return trace.getActiveSpan();
}

/** Inject active context into a carrier for cross-boundary propagation. */
export function propagate(): Carrier {
	const output: Carrier = {};
	propagation.inject(context.active(), output);
	return output;
}

/** Extract trace context from a carrier into an OTel Context. */
export function extract(input: Carrier): Context {
	return propagation.extract(context.active(), input);
}

/** Force-flush all pending spans. */
export async function flush(): Promise<void> {
	await traceProvider?.forceFlush().catch((error) => {
		console.warn("Failed to flush telemetry", { error });
	});
}

export type WrapRPCOptions = SpanOptions & {
	carrier?: Carrier;
	flush?: boolean;
	waitUntil?: (promise: Promise<unknown>) => void;
};

/**
 * Wrap an RPC-style operation in a span with optional carrier extraction and flush.
 * Follows Sauna's wrapRPC pattern.
 */
export function wrapRPC<O>(
	name: string,
	options: WrapRPCOptions,
	fn: (span: Span) => Promise<O>
): Promise<O> {
	const {
		carrier,
		flush: shouldFlush = true,
		waitUntil,
		...spanOptions
	} = options;

	const spanContext = carrier ? extract(carrier) : context.active();

	return tracer().startActiveSpan(
		name,
		{ kind: SpanKind.SERVER, ...spanOptions },
		spanContext,
		async (span) => {
			try {
				return await fn(span);
			} finally {
				span.end();
				if (shouldFlush && waitUntil) {
					waitUntil(flush());
				}
			}
		}
	);
}

export type WrapFetchOptions = SpanOptions & {
	flush?: boolean;
	waitUntil?: (promise: Promise<unknown>) => void;
};

/**
 * Wrap an incoming fetch request in a span, extracting trace context from headers.
 */
export function wrapFetch(
	request: Request,
	options: WrapFetchOptions,
	fn: (span: Span) => Promise<Response>
): Promise<Response> {
	const carrier: Carrier = {
		traceparent: request.headers.get("traceparent") ?? undefined,
		tracestate: request.headers.get("tracestate") ?? undefined,
		baggage: request.headers.get("baggage") ?? undefined,
	};

	return wrapRPC("http.request", { ...options, carrier }, async (span) => {
		const url = new URL(request.url);
		span.setAttribute("http.request.method", request.method);
		span.setAttribute("url.path", url.pathname);

		const response = await fn(span);
		span.setAttribute("http.response.status_code", response.status);
		return response;
	});
}
