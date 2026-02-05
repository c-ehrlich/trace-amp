import { spawn, ChildProcess } from 'child_process';
import { readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Span, SpanStatusCode, context, trace, Context } from '@opentelemetry/api';
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
 * Internal LLM call extracted from debug logs (Oracle, etc.)
 * These are scraped from log files since they're not in stream-json
 */
export interface InternalLlmCall {
  model: string;
  toolName: string;  // which tool made this call (oracle, finder, etc.)
  task?: string;
  reasoningEffort?: string;
  messageCount?: number;
  toolCount?: number;
  toolCallCount?: number;
}

/**
 * Debug log info extracted via BAD_HACK
 */
interface DebugLogInfo {
  mainModel: string | null;
  internalCalls: InternalLlmCall[];
}

/** Internal result from spawnAmp including the log file path for BAD_HACK parsing */
interface SpawnAmpResult extends AmpResult {
  logFile: string;
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

        // BAD HACK: Parse debug logs for model name and internal LLM calls (Oracle, etc.)
        const debugInfo = await this.BAD_HACK__parseDebugLog(result.logFile);
        const modelName = debugInfo.mainModel ?? 'claude';

        // Capture the active context while we're inside startActiveSpan
        const parentContext = context.active();

        // Create child spans for each LLM call and tool call
        this.createLlmCallSpans(result.llmCalls, result.events, modelName, parentContext);
        this.createToolCallSpans(result.toolCalls, parentContext);

        if (debugInfo.internalCalls.length > 0) {
          this.BAD_HACK__createInternalLlmCallSpans(debugInfo.internalCalls, result.toolCalls, parentContext);
        }

        // Return without the logFile property (it's internal)
        const { logFile: _, ...publicResult } = result;
        return publicResult;
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

  private createLlmCallSpans(llmCalls: LlmCallInfo[], events: AmpEvent[], modelName: string, parentContext: Context): void {

    // Extract assistant events to get prompts and completions
    const assistantEvents = events.filter((e): e is AmpAssistantEvent => e.type === 'assistant');

    for (let i = 0; i < llmCalls.length; i++) {
      const llm = llmCalls[i];
      const assistantEvent = assistantEvents[i];

      const llmSpan = this.tracer.startSpan(
        `chat ${modelName}`,
        { startTime: llm.startTime },
        parentContext
      );
      llmSpan.setAttribute('gen_ai.step.index', llm.index);
      llmSpan.setAttribute('gen_ai.request.model', modelName);
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

  private createToolCallSpans(toolCalls: ToolCallInfo[], parentContext: Context): void {
    for (const tool of toolCalls) {
      const toolSpan = this.tracer.startSpan(
        `execute_tool ${tool.name}`,
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
  ): Promise<SpawnAmpResult> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const logFile = join(tmpdir(), `amp-debug-${randomUUID()}.log`);
      const args = ['-x', '--stream-json', '--log-level', 'debug', '--log-file', logFile];

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
          logFile,
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

  /**
   * BAD HACK: Parse debug log file to extract internal LLM calls from tools like Oracle.
   * 
   * This is necessary because Amp's --stream-json doesn't expose internal LLM calls
   * made by subagents (Oracle, Task, Librarian, etc.). We scrape the debug log file
   * to get partial visibility into these calls.
   * 
   * Limitations:
   * - No precise timing (we fake it by spacing calls evenly within parent tool span)
   * - No token counts
   * - No prompt/completion content
   * - Fragile: depends on log format which may change
   */
  private async BAD_HACK__parseDebugLog(
    logFile: string
  ): Promise<DebugLogInfo> {
    const result: DebugLogInfo = {
      mainModel: null,
      internalCalls: [],
    };

    try {
      const content = await readFile(logFile, 'utf-8');
      const lines = content.split('\n').filter(Boolean);

      let currentToolName = 'unknown';

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);

          // Extract the main model from inference start
          if (entry.message === 'runInferenceAndUpdateThread: starting inference' && entry.selectedModel) {
            // selectedModel is like "anthropic/claude-opus-4-5-20251101"
            result.mainModel = entry.selectedModel.replace('anthropic/', '');
          }

          // Track which tool is being invoked
          if (entry.message === 'Oracle starting consultation:') {
            currentToolName = 'oracle';
            result.internalCalls.push({
              model: entry.model ?? 'gpt-5.2',
              toolName: currentToolName,
              task: entry.task,
              reasoningEffort: entry.reasoningEffort,
            });
          }

          // OpenAI scaffold requests (Oracle uses this)
          if (entry.message === 'OpenAI scaffold making request:') {
            // Update the last call with additional info
            const lastCall = result.internalCalls[result.internalCalls.length - 1];
            if (lastCall && lastCall.toolName === currentToolName) {
              lastCall.messageCount = entry.messageCount;
              lastCall.toolCount = entry.toolCount;
            }
          }

          // OpenAI scaffold completion
          if (entry.message === 'OpenAI scaffold completed:') {
            const lastCall = result.internalCalls[result.internalCalls.length - 1];
            if (lastCall && lastCall.toolName === currentToolName) {
              lastCall.toolCallCount = entry.toolCallCount;
            }
          }

          // Could add more patterns here for Task, Librarian, finder, etc.

        } catch {
          // Not valid JSON, skip
        }
      }
    } catch (error) {
      // Log file doesn't exist or can't be read - that's fine
    }

    // Clean up the log file
    try {
      await unlink(logFile);
    } catch {
      // Ignore cleanup errors
    }

    return result;
  }

  /**
   * BAD HACK: Create spans for internal LLM calls extracted from debug logs.
   * 
   * Since we don't have actual timing, we space the calls evenly within the
   * parent tool span's duration.
   */
  private BAD_HACK__createInternalLlmCallSpans(
    internalCalls: InternalLlmCall[],
    toolCalls: ToolCallInfo[],
    parentContext: Context
  ): void {

    // Group internal calls by their parent tool
    const callsByTool = new Map<string, InternalLlmCall[]>();
    for (const call of internalCalls) {
      const existing = callsByTool.get(call.toolName) ?? [];
      existing.push(call);
      callsByTool.set(call.toolName, existing);
    }

    // For each tool that has internal calls, space them evenly within the tool's duration
    for (const tool of toolCalls) {
      const toolNameLower = tool.name.toLowerCase();
      const internalForTool = callsByTool.get(toolNameLower);

      if (!internalForTool || internalForTool.length === 0) continue;

      const toolStart = tool.startTime;
      const toolEnd = tool.endTime ?? Date.now();
      const toolDuration = toolEnd - toolStart;

      // Space calls evenly, leaving some margin at start and end
      const margin = toolDuration * 0.1; // 10% margin
      const availableDuration = toolDuration - 2 * margin;
      const callDuration = availableDuration / internalForTool.length;

      for (let i = 0; i < internalForTool.length; i++) {
        const call = internalForTool[i];
        const fakeStartTime = toolStart + margin + i * callDuration;
        const fakeEndTime = fakeStartTime + callDuration * 0.9; // 90% of slot

        const internalSpan = this.tracer.startSpan(
          `chat ${call.model}`,
          { startTime: fakeStartTime },
          parentContext
        );

        internalSpan.setAttribute('gen_ai.request.model', call.model);
        internalSpan.setAttribute('gen_ai.system', call.toolName);
        internalSpan.setAttribute('gen_ai.internal', true); // Mark as scraped from logs

        if (call.task) {
          internalSpan.setAttribute('gen_ai.prompt', this.truncate(call.task, 4000));
        }
        if (call.reasoningEffort) {
          internalSpan.setAttribute('gen_ai.reasoning_effort', call.reasoningEffort);
        }
        if (call.messageCount !== undefined) {
          internalSpan.setAttribute('gen_ai.message_count', call.messageCount);
        }
        if (call.toolCount !== undefined) {
          internalSpan.setAttribute('gen_ai.available_tools', call.toolCount);
        }
        if (call.toolCallCount !== undefined) {
          internalSpan.setAttribute('gen_ai.tool_calls_made', call.toolCallCount);
        }

        internalSpan.setStatus({ code: SpanStatusCode.OK });
        internalSpan.end(fakeEndTime);
      }
    }
  }
}

/**
 * Convenience function to create an instrumented Amp client
 */
export function createAmpClient(): AmpClient {
  return new AmpClient();
}
