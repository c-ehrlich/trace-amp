# instrument-amp

OpenTelemetry instrumentation for [Amp](https://ampcode.com) CLI.

## Install

```bash
npm install
npm run build
```

## Usage

```typescript
import { initTracing, shutdownTracing, createAmpClient } from './dist/index.js';

// Initialize tracing
initTracing({
  serviceName: 'my-amp-agent',
  otlpEndpoint: 'https://api.axiom.co/v1/traces',
});

const amp = createAmpClient();

const result = await amp.invoke('What files are in this directory?', {
  timeout: 60_000,
});

console.log(result.finalResult);

// Flush traces before exit
await shutdownTracing();
```

## Sending to Axiom

Set these environment variables:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=https://api.axiom.co/v1/traces
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <your-api-token>,X-Axiom-Dataset=<dataset>"
```

Or pass the endpoint directly:

```typescript
initTracing({
  serviceName: 'my-amp-agent',
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
});
```

## Spans

| Span | Description |
|------|-------------|
| `gen_ai.capability` | Root span for the Amp invocation |
| `chat <model>` | LLM calls (e.g., `chat claude-opus-4-5-20251101`, `chat gpt-5.2`) |
| `execute_tool <name>` | Tool executions (e.g., `execute_tool Read`, `execute_tool oracle`) |

## Example

```bash
npm run dev
```
