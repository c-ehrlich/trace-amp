import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor, SimpleSpanProcessor, SpanExporter } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { trace } from '@opentelemetry/api';
import { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

export interface TracingConfig {
  serviceName: string;
  serviceVersion?: string;
  /** OTLP endpoint */
  otlpEndpoint: string;
  /** OTLP headers for authentication (e.g., API keys) */
  otlpHeaders?: Record<string, string>;
}

let provider: NodeTracerProvider | null = null;

/**
 * A span processor that wraps another and suppresses connection errors
 */
class ResilientSpanProcessor implements SpanProcessor {
  constructor(private readonly inner: SpanProcessor) {}

  forceFlush(): Promise<void> {
    return this.inner.forceFlush().catch(this.handleError);
  }

  onStart(span: ReadableSpan, parentContext: unknown): void {
    (this.inner as BatchSpanProcessor).onStart(span as never, parentContext as never);
  }

  onEnd(span: ReadableSpan): void {
    this.inner.onEnd(span);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown().catch(this.handleError);
  }

  private handleError = (error: unknown): void => {
    const isConnectionError =
      (error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ||
      (error instanceof AggregateError &&
        error.errors.every((e) => (e as NodeJS.ErrnoException).code === 'ECONNREFUSED'));
    if (!isConnectionError) {
      throw error;
    }
    // Silently ignore connection errors
  };
}

export function initTracing(config: TracingConfig): void {
  if (provider) return;

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion ?? '1.0.0',
  });

  provider = new NodeTracerProvider({ resource });

  const exporter = new OTLPTraceExporter({
    url: config.otlpEndpoint,
    headers: config.otlpHeaders,
  });

  const batchProcessor = new BatchSpanProcessor(exporter);
  provider.addSpanProcessor(new ResilientSpanProcessor(batchProcessor));
  provider.register();
}

export async function shutdownTracing(): Promise<void> {
  if (provider) {
    try {
      await provider.forceFlush();
      await provider.shutdown();
    } catch (error) {
      // Ignore connection errors during shutdown (e.g., no collector running)
      const isConnectionError =
        (error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ||
        (error instanceof AggregateError &&
          error.errors.every((e) => (e as NodeJS.ErrnoException).code === 'ECONNREFUSED'));
      if (!isConnectionError) {
        throw error;
      }
    }
    provider = null;
  }
}

export function getTracer(name: string = 'amp-agent') {
  return trace.getTracer(name);
}
