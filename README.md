# trace-amp

OpenTelemetry instrumentation for [Amp](https://ampcode.com) CLI.

## Setup

```bash
cp .env.example .env
# Edit .env with your Axiom API token and dataset
```

## Quick Start (Development)

```bash
pnpm wrapped-amp "ask the oracle to add 2+2"
```

## Build & Run Binary

```bash
pnpm build
node dist/cli.js "ask the oracle to add 2+2"
```

## TypeScript Usage

### Standalone (new OTel setup)

```typescript
import { initTracing, shutdownTracing, createAmpClient } from 'instrument-amp';

initTracing({
  serviceName: 'my-amp-agent',
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
});

const amp = createAmpClient();
const result = await amp.invoke('What files are in this directory?');

console.log(result.finalResult);

await shutdownTracing();
```

### With existing OTel setup

If you already have OpenTelemetry configured, skip `initTracing()` - spans will automatically use your existing provider. Pass `parentContext` to nest Amp spans under an existing trace:

```typescript
import { trace, context } from '@opentelemetry/api';
import { createAmpClient } from 'instrument-amp';

const amp = createAmpClient();

// Option 1: Amp spans nest under the current active span automatically
await amp.invoke('prompt');

// Option 2: Explicit parent context (e.g., from incoming request)
const parentContext = trace.setSpanContext(context.active(), {
  traceId: requestTraceId,
  spanId: requestSpanId,
  traceFlags: 1,
});
await amp.invoke('prompt', { parentContext });
```
