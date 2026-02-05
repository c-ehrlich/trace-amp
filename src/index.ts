export { AmpClient, createAmpClient } from './amp-client.js';
export type {
  AmpInvokeOptions,
  AmpResult,
  AmpEvent,
  AmpSystemEvent,
  AmpUserEvent,
  AmpAssistantEvent,
  AmpResultEvent,
  AmpContentBlock,
  AmpUsage,
  ToolCallInfo,
  LlmCallInfo,
} from './amp-client.js';
export { initTracing, shutdownTracing, getTracer } from './tracing.js';
export type { TracingConfig } from './tracing.js';

// Re-export Context type for parentContext option
export type { Context } from '@opentelemetry/api';
