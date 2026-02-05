/**
 * HTTPS MITM proxy that captures LLM API calls for instrumentation.
 *
 * Intercepts requests to ampcode.com/api/provider/* and emits structured
 * events for each request/response pair with timing, model, tokens, etc.
 */

import { Proxy } from 'http-mitm-proxy';
import { EventEmitter } from 'events';
import { gunzipSync } from 'zlib';

export interface LlmRequestEvent {
  type: 'request';
  requestId: string;
  timestamp: number;
  path: string;
  model: string | null;
  messageCount: number;
  toolCount: number;
  maxTokens: number | null;
  stream: boolean;
  reasoning?: { effort: string; summary?: string };
}

export interface LlmResponseEvent {
  type: 'response';
  requestId: string;
  timestamp: number;
  path: string;
  model: string | null;
  status: number;
  streaming: boolean;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  } | null;
  stopReason: string | null;
  toolCalls: { name: string; id?: string }[];
  durationMs: number;
}

export type LlmProxyEvent = LlmRequestEvent | LlmResponseEvent;

export interface LlmProxyOptions {
  port?: number;
  host?: string;
  sslCaDir?: string;
}

interface PendingRequest {
  model: string | null;
  path: string;
  startTime: number;
  responseChunks: Buffer[];
}

export class LlmProxy extends EventEmitter {
  private proxy: Proxy;
  private port: number;
  private pendingRequests = new Map<string, PendingRequest>();
  private requestCounter = 0;

  constructor(options: LlmProxyOptions = {}) {
    super();
    this.port = options.port ?? 0; // 0 = random available port
    this.proxy = new Proxy();

    if (options.sslCaDir) {
      this.proxy.sslCaDir = options.sslCaDir;
    }

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.proxy.onError((ctx, err) => {
      // Silently ignore connection errors - these are normal during proxy shutdown
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNREFUSED') return;
      this.emit('error', err);
    });

    this.proxy.onRequest((ctx, callback) => {
      const path = ctx.clientToProxyRequest.url ?? '';
      const host = ctx.clientToProxyRequest.headers.host ?? '';

      // Only intercept LLM provider API calls
      if (!host.includes('ampcode.com') || !path.includes('/api/provider/')) {
        return callback();
      }

      const requestId = `req-${++this.requestCounter}`;
      (ctx as any).__requestId = requestId;

      // Collect request body
      const chunks: Buffer[] = [];
      ctx.onRequestData((ctx, chunk, callback) => {
        chunks.push(chunk);
        return callback(null, chunk);
      });

      ctx.onRequestEnd((ctx, callback) => {
        const body = Buffer.concat(chunks).toString('utf-8');
        this.handleRequest(requestId, path, body);
        return callback();
      });

      // Collect response
      const responseChunks: Buffer[] = [];
      ctx.onResponseData((ctx, chunk, callback) => {
        responseChunks.push(chunk);
        return callback(null, chunk);
      });

      ctx.onResponseEnd((ctx, callback) => {
        const pending = this.pendingRequests.get(requestId);
        if (pending) {
          pending.responseChunks = responseChunks;
          const status = ctx.serverToProxyResponse?.statusCode ?? 0;
          const headers = ctx.serverToProxyResponse?.headers ?? {};
          this.handleResponse(requestId, status, headers, responseChunks);
        }
        return callback();
      });

      return callback();
    });
  }

  private handleRequest(requestId: string, path: string, body: string): void {
    const startTime = Date.now();
    let model: string | null = null;
    let messageCount = 0;
    let toolCount = 0;
    let maxTokens: number | null = null;
    let stream = false;
    let reasoning: { effort: string; summary?: string } | undefined;

    try {
      const parsed = JSON.parse(body);
      model = parsed.model ?? null;
      messageCount = parsed.messages?.length ?? 0;
      toolCount = parsed.tools?.length ?? 0;
      maxTokens = parsed.max_tokens ?? null;
      stream = parsed.stream ?? false;

      if (parsed.reasoning) {
        reasoning = {
          effort: parsed.reasoning.effort,
          summary: parsed.reasoning.summary,
        };
      }
    } catch {
      // Not JSON, ignore
    }

    this.pendingRequests.set(requestId, {
      model,
      path,
      startTime,
      responseChunks: [],
    });

    const event: LlmRequestEvent = {
      type: 'request',
      requestId,
      timestamp: startTime,
      path,
      model,
      messageCount,
      toolCount,
      maxTokens,
      stream,
      ...(reasoning && { reasoning }),
    };

    this.emit('llm', event);
  }

  private handleResponse(
    requestId: string,
    status: number,
    headers: Record<string, string | string[] | undefined>,
    chunks: Buffer[]
  ): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    this.pendingRequests.delete(requestId);
    const endTime = Date.now();

    let content = Buffer.concat(chunks);

    // Handle gzip encoding
    const encoding = headers['content-encoding'];
    if (encoding === 'gzip') {
      try {
        content = gunzipSync(content);
      } catch {
        // Ignore decompression errors
      }
    }

    const body = content.toString('utf-8');
    const contentType = String(headers['content-type'] ?? '');
    const isStreaming = contentType.includes('text/event-stream');

    let usage: LlmResponseEvent['usage'] = null;
    let stopReason: string | null = null;
    const toolCalls: { name: string; id?: string }[] = [];

    if (isStreaming) {
      // Parse SSE stream
      for (const line of body.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const event = JSON.parse(data);
          this.parseEventData(event, { usage, stopReason, toolCalls }, (u) => (usage = u), (s) => (stopReason = s));
        } catch {
          // Skip malformed events
        }
      }
    } else {
      // Parse JSON response
      try {
        const parsed = JSON.parse(body);
        this.parseResponseBody(parsed, { usage, stopReason, toolCalls }, (u) => (usage = u), (s) => (stopReason = s));
      } catch {
        // Not JSON
      }
    }

    const event: LlmResponseEvent = {
      type: 'response',
      requestId,
      timestamp: endTime,
      path: pending.path,
      model: pending.model,
      status,
      streaming: isStreaming,
      usage,
      stopReason,
      toolCalls,
      durationMs: endTime - pending.startTime,
    };

    this.emit('llm', event);
  }

  private parseEventData(
    event: any,
    state: { usage: LlmResponseEvent['usage']; stopReason: string | null; toolCalls: { name: string; id?: string }[] },
    setUsage: (u: LlmResponseEvent['usage']) => void,
    setStopReason: (s: string) => void
  ): void {
    // Anthropic format
    if (event.type === 'message_start') {
      const msg = event.message ?? {};
      const u = msg.usage;
      if (u) {
        setUsage({
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheCreationTokens: u.cache_creation_input_tokens,
          cacheReadTokens: u.cache_read_input_tokens,
        });
      }
    } else if (event.type === 'message_delta') {
      const u = event.usage;
      if (u && state.usage) {
        state.usage.outputTokens = u.output_tokens ?? state.usage.outputTokens;
      }
      if (event.delta?.stop_reason) {
        setStopReason(event.delta.stop_reason);
      }
    } else if (event.type === 'content_block_start') {
      const block = event.content_block;
      if (block?.type === 'tool_use') {
        state.toolCalls.push({ name: block.name, id: block.id });
      }
    }

    // OpenAI format (both chat completions and responses API)
    if (event.usage) {
      setUsage({
        inputTokens: event.usage.prompt_tokens ?? event.usage.input_tokens ?? 0,
        outputTokens: event.usage.completion_tokens ?? event.usage.output_tokens ?? 0,
      });
    }
    if (event.choices?.[0]?.finish_reason) {
      setStopReason(event.choices[0].finish_reason);
    }
    
    // OpenAI Responses API format (used by Oracle)
    if (event.type === 'response.completed' || event.type === 'response.done') {
      const response = event.response;
      if (response?.usage) {
        setUsage({
          inputTokens: response.usage.input_tokens ?? 0,
          outputTokens: response.usage.output_tokens ?? 0,
        });
      }
      if (response?.status === 'completed') {
        setStopReason('stop');
      }
    }
  }

  private parseResponseBody(
    body: any,
    state: { usage: LlmResponseEvent['usage']; stopReason: string | null; toolCalls: { name: string; id?: string }[] },
    setUsage: (u: LlmResponseEvent['usage']) => void,
    setStopReason: (s: string) => void
  ): void {
    // Anthropic format
    if (body.usage) {
      setUsage({
        inputTokens: body.usage.input_tokens ?? 0,
        outputTokens: body.usage.output_tokens ?? 0,
        cacheCreationTokens: body.usage.cache_creation_input_tokens,
        cacheReadTokens: body.usage.cache_read_input_tokens,
      });
    }
    if (body.stop_reason) {
      setStopReason(body.stop_reason);
    }
    if (body.content) {
      for (const block of body.content) {
        if (block.type === 'tool_use') {
          state.toolCalls.push({ name: block.name, id: block.id });
        }
      }
    }

    // OpenAI format
    if (body.choices?.[0]) {
      const choice = body.choices[0];
      if (choice.finish_reason) {
        setStopReason(choice.finish_reason);
      }
      if (choice.message?.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          state.toolCalls.push({ name: tc.function?.name });
        }
      }
    }
  }

  async start(): Promise<{ port: number; caPath: string }> {
    return new Promise((resolve, reject) => {
      try {
        this.proxy.listen({ port: this.port, host: '127.0.0.1' }, () => {
          // Get the actual port if we used 0
          const address = this.proxy.httpServer?.address();
          const actualPort = typeof address === 'object' && address ? address.port : this.port;
          this.port = actualPort;

          const caPath = `${this.proxy.sslCaDir}/certs/ca.pem`;

          resolve({ port: actualPort, caPath });
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.proxy.close();
      resolve();
    });
  }

  getPort(): number {
    return this.port;
  }
}
