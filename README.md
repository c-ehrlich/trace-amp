# trace-amp

OpenTelemetry instrumentation for [Amp](https://ampcode.com) CLI.

![Amp trace in Axiom](https://github-production-user-asset-6210df.s3.amazonaws.com/8353666/545447024-800a9a84-7251-462b-b1bd-9b6ab9dcd24c.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAVCODYLSA53PQK4ZA%2F20260205%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260205T081953Z&X-Amz-Expires=300&X-Amz-Signature=1e910a5938446c4f51e7f9e72c0a84241992a9d4c502a28ac733693452735209&X-Amz-SignedHeaders=host)

Fully vibe coded, use at your own risk.

## Installation

```bash
npm install -g trace-amp
```

## Usage

Set the required environment variables:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://api.axiom.co/v1/traces"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer your-api-token,X-Axiom-Dataset=your-dataset"
```

Then run:

```bash
trace-amp "ask the oracle to add 2+2"
```

Or use `npx` without installing globally:

```bash
npx trace-amp "ask the oracle to add 2+2"
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
