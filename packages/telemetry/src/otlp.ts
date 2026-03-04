import type {
	IExportTraceServiceResponse,
	ISerializer,
} from "@opentelemetry/otlp-transformer";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer/build/src/trace/json";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

const NON_RETRYABLE_STATUS_CODES = [
	400, 401, 403, 404, 405, 410, 413, 415, 422,
];

async function fetchWithRetry(
	url: URL,
	options: Omit<RequestInit, "signal"> & { timeout?: number }
): Promise<Response> {
	const maxRetries = 3;
	let attempt = 0;
	let delayMs = 500;

	while (true) {
		attempt++;
		const controller = new AbortController();
		const timeout = options.timeout
			? setTimeout(() => controller.abort(), options.timeout)
			: undefined;

		try {
			const res = await fetch(url, {
				...options,
				signal: controller.signal,
			});

			if (res.ok) {
				return res;
			}

			if (NON_RETRYABLE_STATUS_CODES.includes(res.status)) {
				res.body?.cancel();
				throw new Error(`Non-retryable error: ${res.status} ${res.statusText}`);
			}

			res.body?.cancel();

			if (attempt >= maxRetries) {
				throw new Error(`${res.status} ${res.statusText}`);
			}
		} catch (error) {
			if (attempt >= maxRetries) {
				throw error;
			}
		} finally {
			if (timeout) {
				clearTimeout(timeout);
			}
		}

		await new Promise((resolve) => setTimeout(resolve, delayMs));
		delayMs = Math.min(delayMs * 2, 10_000);
	}
}

export type OTLPTraceExporterConfig = {
	headers?: Record<string, string>;
	serializer?: ISerializer<ReadableSpan[], IExportTraceServiceResponse>;
	timeout?: number;
	url: URL;
};

export class OTLPTraceExporter implements SpanExporter {
	readonly #pending: Set<Promise<unknown>> = new Set();
	readonly #config: OTLPTraceExporterConfig;

	constructor(config: OTLPTraceExporterConfig) {
		this.#config = config;
	}

	export(
		spans: ReadableSpan[],
		resultCallback: (result: { code: 0 | 1; error?: Error }) => void
	): void {
		const promise = this.#send(spans);
		this.#pending.add(promise);

		promise.then(() => resultCallback({ code: 0 }));
		promise.catch((error) => resultCallback({ code: 1, error }));
		promise.finally(() => this.#pending.delete(promise));
	}

	async forceFlush(): Promise<void> {
		await Promise.allSettled(Array.from(this.#pending));
	}

	async shutdown(): Promise<void> {
		await this.forceFlush();
	}

	async #send(spans: ReadableSpan[]): Promise<void> {
		const serializer = this.#config.serializer ?? JsonTraceSerializer;
		const timeout = this.#config.timeout ?? 5000;

		const bytes = serializer.serializeRequest(spans) as Uint8Array<ArrayBuffer>;
		if (!bytes) {
			return;
		}

		const res = await fetchWithRetry(this.#config.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...this.#config.headers,
			},
			body: bytes,
			timeout,
		});
		res.body?.cancel();

		if (!res.ok) {
			throw new Error(
				`Failed to send spans to OTLP endpoint: ${res.statusText}`
			);
		}
	}
}
