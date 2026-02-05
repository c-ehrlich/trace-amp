import { initTracing, shutdownTracing, createAmpClient } from './index.js';

async function main() {
  // Initialize OpenTelemetry tracing
  initTracing({
    serviceName: 'my-amp-agent',
    serviceVersion: '1.0.0',
    // Point to your OTLP collector (Jaeger, Axiom, etc.)
    otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318/v1/traces',
  });

  const amp = createAmpClient();

  try {
    // Example: Invoke with Oracle to test internal LLM call extraction
    console.log('Invoking Amp with Oracle...\n');
    const result = await amp.invoke('Use the oracle to tell me what 2+2 is', {
      timeout: 60_000,
      onEvent: (event) => {
        if (event.type === 'assistant') {
          for (const block of event.message.content) {
            if (block.type === 'text') {
              console.log('Assistant:', block.text);
            } else if (block.type === 'tool_use') {
              console.log(`Tool call: ${block.name}`);
            }
          }
        }
      },
    });

    console.log('\n--- Summary ---');
    console.log(`Session ID: ${result.sessionId}`);
    console.log(`Exit code: ${result.exitCode}`);
    console.log(`Duration: ${result.durationMs}ms`);
    console.log(`LLM calls: ${result.llmCalls.length}`);
    for (const llm of result.llmCalls) {
      console.log(
        `  [${llm.index}] ${llm.stopReason} - ${llm.endTime - llm.startTime}ms, ${llm.inputTokens}+${llm.outputTokens} tokens${llm.toolCalls.length ? ` → ${llm.toolCalls.join(', ')}` : ''}`,
      );
    }
    console.log(`Tool calls: ${result.toolCalls.length}`);
    for (const tool of result.toolCalls) {
      console.log(`  - ${tool.name} (${tool.endTime! - tool.startTime}ms)`);
    }
    console.log(`Total tokens: ${result.usage.inputTokens} in, ${result.usage.outputTokens} out`);
    console.log(
      `Cache: ${result.usage.cacheReadInputTokens} read, ${result.usage.cacheCreationInputTokens} created`,
    );
    console.log(`Result: ${result.finalResult}`);
    console.log('\n(Internal LLM calls from Oracle are captured as gen_ai.step.internal spans)');
  } catch (error) {
    console.error('Error:', error);
  } finally {
    // Ensure spans are flushed before exit
    await shutdownTracing();
  }
}

main();
