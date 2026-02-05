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
