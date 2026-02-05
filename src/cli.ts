#!/usr/bin/env node
import 'dotenv/config';
import { initTracing, shutdownTracing, createAmpClient } from './index.js';

async function main() {
  const prompt = process.argv[2];
  if (!prompt) {
    console.error('Usage: wrapped-amp "<prompt>"');
    process.exit(1);
  }

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const headersEnv = process.env.OTEL_EXPORTER_OTLP_HEADERS;

  if (!endpoint || !headersEnv) {
    console.error('Error: Missing required environment variables.');
    console.error(
      'Set OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS in .env or environment.',
    );
    console.error('See .env.example for details.');
    process.exit(1);
  }

  const otlpHeaders: Record<string, string> = {};
  for (const pair of headersEnv.split(',')) {
    const [key, value] = pair.split('=');
    if (key && value) otlpHeaders[key.trim()] = value.trim();
  }

  initTracing({
    serviceName: 'wrapped-amp',
    serviceVersion: '1.0.0',
    otlpEndpoint: endpoint,
    otlpHeaders,
  });

  const amp = createAmpClient();

  try {
    const result = await amp.invoke(prompt, {
      timeout: 300_000,
      onEvent: (event) => {
        if (event.type === 'assistant') {
          for (const block of event.message.content) {
            if (block.type === 'text') {
              process.stdout.write(block.text);
            }
          }
        }
      },
      onStderr: (chunk) => {
        process.stderr.write(chunk);
      },
    });

    console.log(`\n\n--- Telemetry ---`);
    console.log(`Session: ${result.sessionId}`);
    console.log(`Duration: ${result.durationMs}ms`);
    console.log(`Tokens: ${result.usage.inputTokens} in, ${result.usage.outputTokens} out`);
    console.log(`LLM calls: ${result.llmCalls.length}, Tool calls: ${result.toolCalls.length}`);

    for (const llm of result.llmCalls) {
      const duration = llm.endTime - llm.startTime;
      const internal = llm.isInternal ? ' (internal)' : '';
      console.log(
        `  - ${llm.model}${internal}: ${duration}ms, ${llm.inputTokens}in/${llm.outputTokens}out, stop=${llm.stopReason}`,
      );
    }

    process.exitCode = result.exitCode;
  } catch (error) {
    console.error('Error:', error);
    process.exitCode = 1;
  } finally {
    await shutdownTracing();
  }
}

main();
