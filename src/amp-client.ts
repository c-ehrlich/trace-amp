import { spawn, ChildProcess } from 'child_process';
import { Span, SpanStatusCode, context, trace, Context } from '@opentelemetry/api';
import { getTracer } from './tracing.js';
import { LlmProxy, LlmRequestEvent, LlmResponseEvent, LlmProxyEvent } from './llm-proxy.js';

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
export type AmpEvent = AmpSystemEvent | AmpUserEvent | AmpAssistantEvent | AmpResultEvent;

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
  model: string;
  stopReason: 'end_turn' | 'tool_use' | string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  startTime: number;
  endTime: number;
  toolCalls: string[];
  /** Whether this is an internal call (from Oracle, Task, etc.) */
  isInternal: boolean;
  /** Provider path for internal calls */
  providerPath?: string;
}

/**
 * Captured LLM call from proxy (paired request + response)
 */
interface CapturedLlmCall {
  requestId: string;
  path: string;
  model: string;
  startTime: number;
  endTime: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  } | null;
  stopReason: string | null;
  toolCalls: { name: string; id?: string }[];
  messageCount: number;
  toolCount: number;
}

/**
 * Instrumented Amp CLI client that emits OpenTelemetry traces.
 * Uses an HTTPS proxy to capture all LLM calls including internal ones.
 */
export class AmpClient {
  private readonly tracer = getTracer('amp-client');
  private proxy: LlmProxy | null = null;

  async invoke(prompt: string, options: AmpInvokeOptions = {}): Promise<AmpResult> {
    // Start proxy to capture LLM calls
    this.proxy = new LlmProxy();
    const capturedCalls: CapturedLlmCall[] = [];
    const pendingRequests = new Map<string, LlmRequestEvent>();

    this.proxy.on('llm', (event: LlmProxyEvent) => {
      if (event.type === 'request') {
        pendingRequests.set(event.requestId, event);
      } else {
        const req = pendingRequests.get(event.requestId);
        if (req) {
          pendingRequests.delete(event.requestId);
          capturedCalls.push({
            requestId: event.requestId,
            path: event.path,
            model: event.model ?? req.model ?? 'unknown',
            startTime: req.timestamp,
            endTime: event.timestamp,
            usage: event.usage,
            stopReason: event.stopReason,
            toolCalls: event.toolCalls,
            messageCount: req.messageCount,
            toolCount: req.toolCount,
          });
        }
      }
    });

    const { port, caPath } = await this.proxy.start();

    return this.tracer.startActiveSpan('amp', async (span: Span) => {
      try {
        span.setAttribute('gen_ai.capability.name', 'amp');
        span.setAttribute('gen_ai.input.messages', this.truncate(prompt, 4000));
        span.setAttribute('gen_ai.provider.name', 'amp');

        const result = await this.spawnAmp(prompt, options, port, caPath);

        span.setAttribute('gen_ai.conversation.id', result.sessionId ?? 'unknown');
        span.setAttribute('gen_ai.usage.input_tokens', result.usage.inputTokens);
        span.setAttribute('gen_ai.usage.output_tokens', result.usage.outputTokens);
        span.setAttribute('gen_ai.usage.cache_read_tokens', result.usage.cacheReadInputTokens);
        span.setAttribute('gen_ai.usage.cache_creation_tokens', result.usage.cacheCreationInputTokens);
        span.setAttribute('amp.exit_code', result.exitCode);

        if (result.finalResult) {
          span.setAttribute('gen_ai.output.messages', this.truncate(result.finalResult, 4000));
        }

        if (result.exitCode !== 0 || result.events.some((e) => e.type === 'result' && e.is_error)) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `Exit code ${result.exitCode}: ${this.truncate(result.stderr, 500)}`,
          });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        // Enrich result with captured LLM calls
        const enrichedLlmCalls = this.enrichLlmCalls(result.llmCalls, capturedCalls);

        const parentContext = trace.setSpan(context.active(), span);

        // Create child spans for LLM calls (including internal ones from proxy)
        this.createLlmCallSpans(enrichedLlmCalls, result.events, parentContext);
        this.createToolCallSpans(result.toolCalls, parentContext);

        return { ...result, llmCalls: enrichedLlmCalls };
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        throw error;
      } finally {
        span.end();
        await this.proxy?.stop();
        this.proxy = null;
      }
    });
  }

  /**
   * Enrich LLM calls from stream-json with data from proxy captures.
   * Also adds internal LLM calls that weren't visible in stream-json.
   */
  private enrichLlmCalls(streamCalls: LlmCallInfo[], capturedCalls: CapturedLlmCall[]): LlmCallInfo[] {
    const result: LlmCallInfo[] = [];

    // Match stream calls with captured calls by approximate timing
    // The main agent calls go to /api/provider/anthropic/v1/messages
    const mainCalls = capturedCalls.filter((c) => c.path.includes('/anthropic/'));
    const internalCalls = capturedCalls.filter((c) => !c.path.includes('/anthropic/'));

    // For main calls, merge with stream data to get full picture
    for (let i = 0; i < streamCalls.length; i++) {
      const streamCall = streamCalls[i];
      // Find matching captured call by timing (within a reasonable window)
      const matchedCapture = mainCalls.find(
        (c) =>
          Math.abs(c.startTime - streamCall.startTime) < 2000 && Math.abs(c.endTime - streamCall.endTime) < 2000
      );

      result.push({
        ...streamCall,
        model: matchedCapture?.model ?? streamCall.model ?? 'claude',
        startTime: matchedCapture?.startTime ?? streamCall.startTime,
        endTime: matchedCapture?.endTime ?? streamCall.endTime,
        isInternal: false,
      });
    }

    // Add internal calls (Oracle, Task, etc.) with real timing and data
    for (const captured of internalCalls) {
      const provider = captured.path.includes('/openai/') ? 'openai' : 'anthropic';
      result.push({
        index: result.length,
        model: captured.model,
        stopReason: captured.stopReason ?? 'unknown',
        inputTokens: captured.usage?.inputTokens ?? 0,
        outputTokens: captured.usage?.outputTokens ?? 0,
        cacheCreationInputTokens: captured.usage?.cacheCreationTokens ?? 0,
        cacheReadInputTokens: captured.usage?.cacheReadTokens ?? 0,
        startTime: captured.startTime,
        endTime: captured.endTime,
        toolCalls: captured.toolCalls.map((t) => t.name),
        isInternal: true,
        providerPath: captured.path,
      });
    }

    // Sort by start time
    result.sort((a, b) => a.startTime - b.startTime);

    return result;
  }

  private createLlmCallSpans(llmCalls: LlmCallInfo[], events: AmpEvent[], parentContext: Context): void {
    const conversationMessages: Array<{ role: string; content: AmpContentBlock[] }> = [];
    let assistantEventIndex = 0;
    const assistantEvents = events.filter((e): e is AmpAssistantEvent => e.type === 'assistant');

    for (let i = 0; i < llmCalls.length; i++) {
      const llm = llmCalls[i];

      // Build conversation history for non-internal calls
      if (!llm.isInternal && i === 0) {
        for (const event of events) {
          if (event.type === 'user') {
            conversationMessages.push({ role: 'user', content: event.message.content });
          } else if (event.type === 'assistant') {
            break;
          }
        }
      }

      const spanName = llm.isInternal ? `chat ${llm.model} (internal)` : `chat ${llm.model}`;

      const llmSpan = this.tracer.startSpan(spanName, { startTime: llm.startTime }, parentContext);
      llmSpan.setAttribute('gen_ai.operation.name', 'chat');
      llmSpan.setAttribute('gen_ai.step.index', llm.index);
      llmSpan.setAttribute('gen_ai.request.model', llm.model);
      llmSpan.setAttribute('gen_ai.usage.input_tokens', llm.inputTokens);
      llmSpan.setAttribute('gen_ai.usage.output_tokens', llm.outputTokens);
      llmSpan.setAttribute('gen_ai.usage.cache_read_tokens', llm.cacheReadInputTokens);
      llmSpan.setAttribute('gen_ai.usage.cache_creation_tokens', llm.cacheCreationInputTokens);
      llmSpan.setAttribute('gen_ai.internal', llm.isInternal);

      if (llm.providerPath) {
        llmSpan.setAttribute('gen_ai.provider_path', llm.providerPath);
      }

      const finishReason = llm.stopReason === 'tool_use' ? 'tool-calls' : 'stop';
      llmSpan.setAttribute('gen_ai.response.finish_reasons', finishReason);

      if (!llm.isInternal && conversationMessages.length > 0) {
        const input = JSON.stringify(conversationMessages);
        llmSpan.setAttribute('gen_ai.input.messages', this.truncate(input, 4000));
      }

      if (!llm.isInternal) {
        const assistantEvent = assistantEvents[assistantEventIndex++];
        if (assistantEvent) {
          const completion = JSON.stringify(assistantEvent.message.content);
          llmSpan.setAttribute('gen_ai.output.messages', this.truncate(completion, 4000));

          // Add assistant message to conversation for next iteration
          conversationMessages.push({ role: 'assistant', content: assistantEvent.message.content });
        }
      }

      llmSpan.setStatus({ code: SpanStatusCode.OK });
      llmSpan.end(llm.endTime);
    }
  }

  private createToolCallSpans(toolCalls: ToolCallInfo[], parentContext: Context): void {
    for (const tool of toolCalls) {
      const toolSpan = this.tracer.startSpan(`execute_tool ${tool.name}`, { startTime: tool.startTime }, parentContext);

      toolSpan.setAttribute('gen_ai.operation.name', 'execute_tool');
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
    proxyPort: number,
    caCertPath: string
  ): Promise<AmpResult> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const args = ['-x', '--stream-json'];

      const proc: ChildProcess = spawn('amp', args, {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...options.env,
          // Route traffic through our proxy
          HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
          NODE_EXTRA_CA_CERTS: caCertPath,
        },
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
            llmCallStartTime = Date.now();
          }

          if (event.type === 'user') {
            llmCallStartTime = Date.now();

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

            usage.inputTokens += u.input_tokens;
            usage.outputTokens += u.output_tokens;
            usage.cacheCreationInputTokens += u.cache_creation_input_tokens;
            usage.cacheReadInputTokens += u.cache_read_input_tokens;

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

            llmCalls.push({
              index: llmCallIndex++,
              model: 'claude', // Will be enriched by proxy data
              stopReason: event.message.stop_reason,
              inputTokens: u.input_tokens,
              outputTokens: u.output_tokens,
              cacheCreationInputTokens: u.cache_creation_input_tokens,
              cacheReadInputTokens: u.cache_read_input_tokens,
              startTime: llmCallStartTime ?? startTime,
              endTime: now,
              toolCalls: toolCallNames,
              isInternal: false,
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

        if (lineBuffer.trim()) {
          processLine(lineBuffer);
        }

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

      proc.stdin?.write(prompt);
      proc.stdin?.end();
    });
  }

  private truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.slice(0, maxLength) + '... [truncated]';
  }
}

export function createAmpClient(): AmpClient {
  return new AmpClient();
}
