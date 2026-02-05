import { spawn, ChildProcess } from 'child_process';
import { Span, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { getTracer } from './tracing.js';

export interface AmpInvokeOptions {
  /** Working directory for the amp process */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Callback for each parsed event */
  onEvent?: (event: AmpEvent) => void;
  /** Callback for raw stdout chunks */
  onStdout?: (chunk: string) => void;
  /** Callback for stderr chunks */
  onStderr?: (chunk: string) => void;
}

export interface AmpResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  sessionId: string | null;
  events: AmpEvent[];
  toolCalls: ToolCallInfo[];
  llmCalls: LlmCallInfo[];
  usage: AmpUsage;
  finalResult: string | null;
}

export interface AmpUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

// Amp stream-json event types
export type AmpEvent =
  | AmpSystemEvent
  | AmpUserEvent
  | AmpAssistantEvent
  | AmpResultEvent;

export interface AmpSystemEvent {
  type: 'system';
  subtype: 'init';
  cwd: string;
  session_id: string;
  tools: string[];
  mcp_servers: string[];
}

export interface AmpUserEvent {
  type: 'user';
  message: {
    role: 'user';
    content: AmpContentBlock[];
  };
  parent_tool_use_id: string | null;
  session_id: string;
}

export interface AmpAssistantEvent {
  type: 'assistant';
  message: {
    type: 'message';
    role: 'assistant';
    content: AmpContentBlock[];
    stop_reason: 'end_turn' | 'tool_use';
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
      max_tokens: number;
      service_tier: string;
    };
  };
  parent_tool_use_id: string | null;
  session_id: string;
}

export interface AmpResultEvent {
  type: 'result';
  subtype: 'success' | 'error';
  duration_ms: number;
  is_error: boolean;
  num_turns: number;
  result: string;
  session_id: string;
}

export type AmpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean };

export interface ToolCallInfo {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  startTime: number;
  endTime?: number;
}

export interface LlmCallInfo {
  index: number;
  stopReason: 'end_turn' | 'tool_use';
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  startTime: number;
  endTime: number;
  toolCalls: string[];  // tool names called in this turn
}

/**
 * Instrumented Amp CLI client that emits OpenTelemetry traces
 */
export class AmpClient {
  private readonly tracer = getTracer('amp-client');

  /**
   * Invoke the Amp CLI with a prompt and collect telemetry.
   * Uses --stream-json to get structured output.
   */
  async invoke(prompt: string, options: AmpInvokeOptions = {}): Promise<AmpResult> {
    return this.tracer.startActiveSpan('gen_ai.capability', async (span: Span) => {
      try {
        span.setAttribute('gen_ai.capability.name', 'amp');
        span.setAttribute('gen_ai.prompt', this.truncate(prompt, 4000));
        span.setAttribute('gen_ai.system', 'amp');

        const result = await this.spawnAmp(prompt, options, span);

        span.setAttribute('gen_ai.session.id', result.sessionId ?? 'unknown');
        span.setAttribute('gen_ai.usage.input_tokens', result.usage.inputTokens);
        span.setAttribute('gen_ai.usage.output_tokens', result.usage.outputTokens);
        span.setAttribute('gen_ai.usage.cache_read_tokens', result.usage.cacheReadInputTokens);
        span.setAttribute('gen_ai.usage.cache_creation_tokens', result.usage.cacheCreationInputTokens);
        span.setAttribute('amp.exit_code', result.exitCode);

        if (result.finalResult) {
          span.setAttribute('gen_ai.completion', this.truncate(result.finalResult, 4000));
        }

        if (result.exitCode !== 0 || result.events.some(e => e.type === 'result' && e.is_error)) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `Exit code ${result.exitCode}: ${this.truncate(result.stderr, 500)}`,
          });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        // Create child spans for each LLM call and tool call
        this.createLlmCallSpans(result.llmCalls, result.events, span);
        this.createToolCallSpans(result.toolCalls, span);

        return result;
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private createLlmCallSpans(llmCalls: LlmCallInfo[], events: AmpEvent[], parentSpan: Span): void {
    const parentContext = trace.setSpan(context.active(), parentSpan);

    // Extract assistant events to get prompts and completions
    const assistantEvents = events.filter((e): e is AmpAssistantEvent => e.type === 'assistant');

    for (let i = 0; i < llmCalls.length; i++) {
      const llm = llmCalls[i];
      const assistantEvent = assistantEvents[i];

      const llmSpan = this.tracer.startSpan(
        'gen_ai.step',
        { startTime: llm.startTime },
        parentContext
      );

      llmSpan.setAttribute('gen_ai.step.name', `llm_call_${llm.index}`);
      llmSpan.setAttribute('gen_ai.step.index', llm.index);
      llmSpan.setAttribute('gen_ai.request.model', 'claude'); // Amp uses Claude
      llmSpan.setAttribute('gen_ai.usage.input_tokens', llm.inputTokens);
      llmSpan.setAttribute('gen_ai.usage.output_tokens', llm.outputTokens);
      llmSpan.setAttribute('gen_ai.usage.cache_read_tokens', llm.cacheReadInputTokens);
      llmSpan.setAttribute('gen_ai.usage.cache_creation_tokens', llm.cacheCreationInputTokens);

      // Map stop reason to gen_ai finish reason
      const finishReason = llm.stopReason === 'tool_use' ? 'tool-calls' : 'stop';
      llmSpan.setAttribute('gen_ai.response.finish_reasons', finishReason);

      // Add completion content from the assistant event
      if (assistantEvent) {
        const completion = JSON.stringify(assistantEvent.message.content);
        llmSpan.setAttribute('gen_ai.completion', this.truncate(completion, 4000));
      }

      llmSpan.setStatus({ code: SpanStatusCode.OK });
      llmSpan.end(llm.endTime);
    }
  }

  private createToolCallSpans(toolCalls: ToolCallInfo[], parentSpan: Span): void {
    const parentContext = trace.setSpan(context.active(), parentSpan);

    for (const tool of toolCalls) {
      const toolSpan = this.tracer.startSpan(
        'gen_ai.tool',
        { startTime: tool.startTime },
        parentContext
      );

      toolSpan.setAttribute('gen_ai.tool.name', tool.name);
      toolSpan.setAttribute('gen_ai.tool.arguments', JSON.stringify(tool.input).slice(0, 4000));

      if (tool.result !== undefined) {
        toolSpan.setAttribute('gen_ai.tool.message', this.truncate(tool.result, 4000));
      }

      if (tool.isError) {
        toolSpan.setStatus({ code: SpanStatusCode.ERROR });
      } else {
        toolSpan.setStatus({ code: SpanStatusCode.OK });
      }

      toolSpan.end(tool.endTime ?? Date.now());
    }
  }

  private spawnAmp(
    prompt: string,
    options: AmpInvokeOptions,
    parentSpan: Span
  ): Promise<AmpResult> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const args = ['-x', '--stream-json'];

      const proc: ChildProcess = spawn('amp', args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timeout: NodeJS.Timeout | undefined;
      let lineBuffer = '';

      const events: AmpEvent[] = [];
      const toolCalls: ToolCallInfo[] = [];
      const llmCalls: LlmCallInfo[] = [];
      const pendingToolCalls = new Map<string, ToolCallInfo>();
      let sessionId: string | null = null;
      let finalResult: string | null = null;
      let llmCallStartTime: number | null = null;
      let llmCallIndex = 0;
      const usage: AmpUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      };

      if (options.timeout) {
        timeout = setTimeout(() => {
          proc.kill('SIGTERM');
          reject(new Error(`Amp process timed out after ${options.timeout}ms`));
        }, options.timeout);
      }

      const processLine = (line: string) => {
        if (!line.trim()) return;

        try {
          const event = JSON.parse(line) as AmpEvent;
          events.push(event);
          options.onEvent?.(event);

          if (event.type === 'system' && event.subtype === 'init') {
            sessionId = event.session_id;
            // LLM call starts after system init
            llmCallStartTime = Date.now();
          }

          if (event.type === 'user') {
            // User message (prompt or tool result) starts an LLM call
            llmCallStartTime = Date.now();

            // Match tool results to pending tool calls
            for (const block of event.message.content) {
              if (block.type === 'tool_result') {
                const pending = pendingToolCalls.get(block.tool_use_id);
                if (pending) {
                  pending.endTime = Date.now();
                  pending.result = block.content;
                  pending.isError = block.is_error;
                  toolCalls.push(pending);
                  pendingToolCalls.delete(block.tool_use_id);
                }
              }
            }
          }

          if (event.type === 'assistant') {
            const now = Date.now();
            const u = event.message.usage;

            // Accumulate total usage
            usage.inputTokens += u.input_tokens;
            usage.outputTokens += u.output_tokens;
            usage.cacheCreationInputTokens += u.cache_creation_input_tokens;
            usage.cacheReadInputTokens += u.cache_read_input_tokens;

            // Collect tool call names from this response
            const toolCallNames: string[] = [];
            for (const block of event.message.content) {
              if (block.type === 'tool_use') {
                toolCallNames.push(block.name);
                const toolCall: ToolCallInfo = {
                  id: block.id,
                  name: block.name,
                  input: block.input,
                  startTime: now,
                };
                pendingToolCalls.set(block.id, toolCall);
              }
            }

            // Record LLM call
            llmCalls.push({
              index: llmCallIndex++,
              stopReason: event.message.stop_reason,
              inputTokens: u.input_tokens,
              outputTokens: u.output_tokens,
              cacheCreationInputTokens: u.cache_creation_input_tokens,
              cacheReadInputTokens: u.cache_read_input_tokens,
              startTime: llmCallStartTime ?? startTime,
              endTime: now,
              toolCalls: toolCallNames,
            });
          }

          if (event.type === 'result') {
            finalResult = event.result;
          }
        } catch {
          // Not valid JSON, ignore
        }
      };

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        options.onStdout?.(text);

        // Parse JSON lines
        lineBuffer += text;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          processLine(line);
        }
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        options.onStderr?.(text);
      });

      proc.on('error', (error) => {
        if (timeout) clearTimeout(timeout);
        reject(error);
      });

      proc.on('close', (code) => {
        if (timeout) clearTimeout(timeout);

        // Process any remaining buffer
        if (lineBuffer.trim()) {
          processLine(lineBuffer);
        }

        // Close any pending tool calls that didn't get results
        for (const pending of pendingToolCalls.values()) {
          pending.endTime = Date.now();
          toolCalls.push(pending);
        }

        resolve({
          stdout,
          stderr,
          exitCode: code ?? 0,
          durationMs: Date.now() - startTime,
          sessionId,
          events,
          toolCalls,
          llmCalls,
          usage,
          finalResult,
        });
      });

      // Send prompt to stdin
      proc.stdin?.write(prompt);
      proc.stdin?.end();
    });
  }

  private truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.slice(0, maxLength) + '... [truncated]';
  }
}

/**
 * Convenience function to create an instrumented Amp client
 */
export function createAmpClient(): AmpClient {
  return new AmpClient();
}
