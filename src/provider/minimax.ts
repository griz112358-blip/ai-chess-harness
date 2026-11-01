/**
 * provider/minimax.ts —— MiniMax 模型接入（任务 1.3 / 1.6b）
 *
 * 职责边界：
 * - 这里只做「一次模型调用」：把 provider 中立的消息/工具定义映射成
 *   MiniMax 的 OpenAI 兼容格式，发请求，再把返回结构抹平成 types.ts 的 ModelResponse。
 * - 不管会话状态（agentState.ts）、不管工具执行（loop.ts）。
 * - 不猜字段名：请求体与响应结构都按 OpenAI 兼容约定写，
 *   并且对 MiniMax 特有的 base_resp 错误码做了单独处理（HTTP 200 也可能是业务失败）。
 *
 * 接口地址（官方文档）：
 * - 国际站 https://api.minimax.io/v1
 * - 国内站 https://api.minimaxi.com/v1
 * 端点 POST {baseUrl}/chat/completions
 */

import type { ModelMessage } from "../agentState.js";
import type { ModelResponse, ModelUsage, Tool, ToolCall, ToolTable } from "../types.js";

/** MiniMax 调用配置。 */
export interface MiniMaxConfig {
  /** 开放平台 API Key。 */
  apiKey: string;
  /** OpenAI 兼容入口根地址，不要带 /chat/completions。 */
  baseUrl: string;
  /** 模型名，例如 MiniMax-M3 / MiniMax-M2.7。 */
  model: string;
  /** 采样温度。 */
  temperature?: number;
  /** 输出 token 上限（OpenAI 兼容接口用 max_completion_tokens）。 */
  maxTokens?: number;
  /** 单次请求超时（毫秒）。 */
  timeoutMs?: number;
  /**
   * 思考模式：
   * - "disabled"：显式关闭模型内部思考（响应更快，适合陪聊/陪练）
   * - "enabled"：显式开启
   * - undefined：不发送该字段，用平台默认
   */
  thinking?: "enabled" | "disabled";
}

/** 内部用的 OpenAI 兼容 wire 结构。 */
interface WireTool {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/** MiniMax 返回的业务错误。HTTP 200 也可能带 base_resp.status_code != 0。 */
export class MiniMaxError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly hint?: string;

  constructor(message: string, opts: { status: number; code?: number; hint?: string } = { status: 0 }) {
    super(message);
    this.name = "MiniMaxError";
    this.status = opts.status;
    this.code = opts.code;
    this.hint = opts.hint;
  }
}

/** 已知错误码 → 中文提示。 */
const ERROR_HINTS: Record<number, string> = {
  1001: "请求超时，可以稍后重试或调大超时时间。",
  1002: "触发了频率限制（限流），稍等几秒再试。",
  1004: "API Key 无效，请检查 Key 是否填错、是否与所选区域一致。",
  1008: "账户余额不足，请到开放平台充值。",
  1039: "上下文超出模型上限，试试把对话历史缩短。",
  2013: "请求参数不被接受，通常是模型名或 baseUrl 写错了。",
  2049: "鉴权失败：API Key 无效或已过期。",
  2056: "Token Plan / Code Plan 的用量窗口已用尽，等窗口刷新或升级套餐。",
};

/** 常用模型名，给前端做下拉提示用。 */
export const KNOWN_MODELS = [
  "MiniMax-M3",
  "MiniMax-M2.7",
  "MiniMax-M2.7-highspeed",
  "MiniMax-M2.5",
  "MiniMax-M2.1",
  "MiniMax-M2",
] as const;

/* ------------------------------------------------------------------ *
 * 消息 / 工具映射
 * ------------------------------------------------------------------ */

/** 把 provider 中立消息映射成 OpenAI 兼容消息。 */
export function toWireMessages(messages: ModelMessage[]): WireMessage[] {
  return messages.map((m): WireMessage => {
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
    }
    return { role: m.role, content: m.content };
  });
}

/** 把工具表映射成 OpenAI 兼容 tools 声明。 */
export function toWireTools(tools: ToolTable): WireTool[] {
  return Object.values(tools).map((t: Tool) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/* ------------------------------------------------------------------ *
 * 响应解析（任务 1.6b：各家字段差异在这里被抹平）
 * ------------------------------------------------------------------ */

/** 解析工具参数：provider 给的可能是 JSON 字符串，也可能已经是对象。 */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    return {};
  } catch {
    // 容忍模型输出裸字符串：例如 "e4"
    return { value: trimmed };
  }
}

/**
 * 从任意 provider 响应里抽出工具调用，统一成 ToolCall。
 * 同时兼容 OpenAI 的 tool_calls 和 Anthropic 风格的 content 块。
 */
export function parseToolCalls(response: unknown): ToolCall[] {
  const root = response as {
    choices?: Array<{
      message?: {
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: unknown };
        }>;
        content?: unknown;
      };
    }>;
  };
  const calls = root?.choices?.[0]?.message?.tool_calls ?? [];
  const out: ToolCall[] = [];
  calls.forEach((c, index) => {
    const name = c?.function?.name;
    if (!name) return;
    out.push({
      id: c.id ?? `call_${index}_${Date.now().toString(36)}`,
      name,
      arguments: parseToolArguments(c.function?.arguments),
    });
  });
  return out;
}

/** 抽文字内容。 */
export function parseText(response: unknown): string {
  const root = response as {
    choices?: Array<{ message?: { content?: unknown }; delta?: { content?: unknown } }>;
  };
  const content = root?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // 有些模型返回内容块数组
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        const p = part as { text?: unknown; type?: unknown };
        return typeof p.text === "string" ? p.text : "";
      })
      .join("");
  }
  return "";
}

/** 抽思考内容（M2 系列常见 reasoning_content）。 */
export function parseReasoning(response: unknown): string | undefined {
  const root = response as {
    choices?: Array<{ message?: { reasoning_content?: unknown; reasoning_details?: unknown } }>;
  };
  const msg = root?.choices?.[0]?.message;
  const rc = msg?.reasoning_content;
  if (typeof rc === "string" && rc.length > 0) return rc;
  const details = msg?.reasoning_details;
  if (Array.isArray(details)) {
    const text = details
      .map((d) => {
        const item = d as { text?: unknown };
        return typeof item.text === "string" ? item.text : "";
      })
      .join("");
    if (text.length > 0) return text;
  }
  return undefined;
}

/** 抽 token 用量。 */
export function parseUsage(response: unknown): ModelUsage | undefined {
  const root = response as { usage?: Record<string, unknown> };
  const usage = root?.usage;
  if (!usage) return undefined;
  const out: ModelUsage = {};
  if (typeof usage.prompt_tokens === "number") out.promptTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === "number") out.completionTokens = usage.completion_tokens;
  if (typeof usage.total_tokens === "number") out.totalTokens = usage.total_tokens;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 检查 MiniMax 的业务错误。
 * MiniMax 会在响应体里放 base_resp.status_code，HTTP 200 时它才代表真正的失败原因。
 */
export function assertBusinessOk(response: unknown, status: number): void {
  const root = response as {
    base_resp?: { status_code?: number; status_msg?: string };
    error?: { code?: number | string; message?: string };
  };
  const baseCode = root?.base_resp?.status_code;
  const errCode = root?.error?.code;
  const code =
    typeof baseCode === "number" && baseCode !== 0
      ? baseCode
      : typeof errCode === "number"
        ? errCode
        : undefined;
  if (code === undefined) return;
  const message =
    root?.base_resp?.status_msg ??
    root?.error?.message ??
    `MiniMax 返回错误码 ${code}`;
  throw new MiniMaxError(message, {
    status,
    code,
    hint: ERROR_HINTS[code],
  });
}

/* ------------------------------------------------------------------ *
 * 请求
 * ------------------------------------------------------------------ */

function buildRequestBody(
  config: MiniMaxConfig,
  messages: ModelMessage[],
  tools: ToolTable,
  stream: boolean,
  includeUsage = true,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: toWireMessages(messages),
    stream,
  };
  if (Object.keys(tools).length > 0) {
    body.tools = toWireTools(tools);
    body.tool_choice = "auto";
  }
  if (typeof config.temperature === "number") body.temperature = config.temperature;
  if (typeof config.maxTokens === "number") body.max_completion_tokens = config.maxTokens;
  if (config.thinking) body.thinking = { type: config.thinking };
  if (stream && includeUsage) {
    // 流式默认不返回 token 用量，显式打开（MiniMax 支持，末尾会带完整 usage）
    body.stream_options = { include_usage: true };
  }
  return body;
}

function endpoint(config: MiniMaxConfig): string {
  return `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

/**
 * 把网络层异常翻译成人话。
 * 最常见的是 baseUrl 写错导致 DNS 解析失败，原生报错只有 "fetch failed"。
 */
function wrapNetworkError(error: unknown): unknown {
  if (error instanceof MiniMaxError) return error;
  if (error instanceof TypeError && /fetch failed|network/i.test(error.message)) {
    return new MiniMaxError(`网络请求失败：${error.message}`, {
      status: 0,
      hint:
        "检查 baseUrl（国际站 https://api.minimax.io/v1，国内站 https://api.minimaxi.com/v1）" +
        "以及本机网络是否能连通该地址。",
    });
  }
  return error;
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text) as {
        base_resp?: { status_code?: number; status_msg?: string };
        error?: { code?: number | string; message?: string };
        message?: string;
      };
      const code =
        typeof json.base_resp?.status_code === "number"
          ? json.base_resp.status_code
          : typeof json.error?.code === "number"
            ? json.error.code
            : extractCodeFromText(json.base_resp?.status_msg ?? json.error?.message ?? json.message);
      const message =
        json.base_resp?.status_msg ??
        json.error?.message ??
        json.message ??
        text.slice(0, 500);
      return JSON.stringify({ code, message });
    } catch {
      return text.slice(0, 500);
    }
  } catch {
    return "";
  }
}

/** 从错误文本里挖出错误码，例如 "invalid api key (2049)" → 2049。 */
function extractCodeFromText(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const match = /\((\d{3,4})\)/.exec(text);
  if (match?.[1]) {
    const code = Number(match[1]);
    if (Number.isFinite(code)) return code;
  }
  return undefined;
}

/** 从错误体里挖出错误码。 */
function extractCode(rawBody: string): number | undefined {
  try {
    const json = JSON.parse(rawBody) as { code?: number; message?: string };
    if (typeof json.code === "number") return json.code;
    return extractCodeFromText(json.message);
  } catch {
    return extractCodeFromText(rawBody);
  }
}

/** HTTP 状态码 → 兜底提示。 */
function httpHint(status: number): string | undefined {
  if (status === 401 || status === 403) {
    return "API Key 无效或没有权限：请检查 Key、接入区域（国际站/国内站）是否匹配。";
  }
  if (status === 404) return "接口地址不对：检查 baseUrl（应为 https://api.minimax.io/v1 或 api.minimaxi.com/v1）。";
  if (status === 429) return "触发限流，稍等几秒再试。";
  if (status >= 500) return "MiniMax 服务端异常，稍后重试。";
  return undefined;
}

/* ------------------------------------------------------------------ *
 * 公开 API
 * ------------------------------------------------------------------ */

/** 非流式调用：一次请求拿完整响应。 */
export async function callModel(
  config: MiniMaxConfig,
  messages: ModelMessage[],
  tools: ToolTable = {},
  opts: { signal?: AbortSignal } = {},
): Promise<ModelResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 90_000);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    let res: Response;
    try {
      res = await fetch(endpoint(config), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(buildRequestBody(config, messages, tools, false)),
        signal: controller.signal,
      });
    } catch (error) {
      throw wrapNetworkError(error);
    }

    if (!res.ok) {
      const raw = await readErrorBody(res);
      const code = extractCode(raw);
      throw new MiniMaxError(
        `MiniMax 请求失败（HTTP ${res.status}）：${raw || res.statusText}`,
        {
          status: res.status,
          code,
          hint: (code !== undefined ? ERROR_HINTS[code] : undefined) ?? httpHint(res.status),
        },
      );
    }

    const json: unknown = await res.json();
    assertBusinessOk(json, res.status);

    const response: ModelResponse = {
      text: parseText(json),
      toolCalls: parseToolCalls(json),
    };
    const reasoning = parseReasoning(json);
    if (reasoning) response.reasoning = reasoning;
    const usage = parseUsage(json);
    if (usage) response.usage = usage;
    return response;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** 流式过程中的增量事件。 */
export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> };

/**
 * 流式调用。
 *
 * 回调 onEvent 用于把增量文本推给前端；工具调用在流结束后统一给���。
 * 工具调用增量按 index 累加（OpenAI 兼容协议：id / name 只在第一段出现，
 * arguments 分多段追加）。
 */
export async function callModelStream(
  config: MiniMaxConfig,
  messages: ModelMessage[],
  tools: ToolTable = {},
  opts: {
    signal?: AbortSignal;
    onEvent?: (event: StreamEvent) => void;
  } = {},
): Promise<ModelResponse> {
  try {
    return await streamOnce(config, messages, tools, opts, true);
  } catch (error) {
    // 某些网关不认 stream_options.include_usage → 去掉它再试一次（少一个 token 统计而已）
    if (error instanceof MiniMaxError && error.code === 2013) {
      return await streamOnce(config, messages, tools, opts, false);
    }
    throw error;
  }
}

/** 单次流式调用（includeUsage 开关）。 */
async function streamOnce(
  config: MiniMaxConfig,
  messages: ModelMessage[],
  tools: ToolTable,
  opts: {
    signal?: AbortSignal;
    onEvent?: (event: StreamEvent) => void;
  },
  includeUsage: boolean,
): Promise<ModelResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 90_000);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    let res: Response;
    try {
      res = await fetch(endpoint(config), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(buildRequestBody(config, messages, tools, true, includeUsage)),
        signal: controller.signal,
      });
    } catch (error) {
      throw wrapNetworkError(error);
    }

    if (!res.ok) {
      const raw = await readErrorBody(res);
      const code = extractCode(raw);
      throw new MiniMaxError(
        `MiniMax 请求失败（HTTP ${res.status}）：${raw || res.statusText}`,
        {
          status: res.status,
          code,
          hint: (code !== undefined ? ERROR_HINTS[code] : undefined) ?? httpHint(res.status),
        },
      );
    }
    if (!res.body) {
      // 某些网关不返回流，退回非流式
      return callModel(config, messages, tools, { signal: opts.signal });
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let reasoning = "";
    let usage: ModelUsage | undefined;
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();

    const handleChunk = (json: unknown): void => {
      assertBusinessOk(json, res.status);
      const root = json as {
        choices?: Array<{
          delta?: {
            content?: unknown;
            reasoning_content?: unknown;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: unknown };
            }>;
          };
        }>;
        usage?: Record<string, unknown>;
      };
      const delta = root.choices?.[0]?.delta;
      if (delta) {
        if (typeof delta.content === "string" && delta.content.length > 0) {
          text += delta.content;
          opts.onEvent?.({ type: "text", delta: delta.content });
        }
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
          reasoning += delta.reasoning_content;
          opts.onEvent?.({ type: "reasoning", delta: delta.reasoning_content });
        }
        for (const tc of delta.tool_calls ?? []) {
          const index = typeof tc.index === "number" ? tc.index : 0;
          const acc = toolAcc.get(index) ?? { id: "", name: "", args: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (typeof tc.function?.arguments === "string") acc.args += tc.function.arguments;
          toolAcc.set(index, acc);
        }
      }
      const u = parseUsage(json);
      if (u) usage = u;
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          handleChunk(JSON.parse(payload));
        } catch {
          // 忽略无法解析的增量（心跳等）
        }
      }
    }

    const toolCalls: ToolCall[] = [];
    for (const [index, acc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
      if (!acc.name) continue;
      toolCalls.push({
        id: acc.id || `call_${index}_${Date.now().toString(36)}`,
        name: acc.name,
        arguments: parseToolArguments(acc.args),
      });
    }
    for (const call of toolCalls) {
      opts.onEvent?.({ type: "tool_call", id: call.id, name: call.name, arguments: call.arguments });
    }

    const response: ModelResponse = { text, toolCalls };
    if (reasoning.length > 0) response.reasoning = reasoning;
    if (usage) response.usage = usage;
    return response;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** 拉取账号下可用的模型列表（GET /v1/models）。 */
export async function listModels(
  config: Pick<MiniMaxConfig, "apiKey" | "baseUrl">,
  opts: { signal?: AbortSignal } = {},
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let res: Response;
    try {
      res = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/models`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal: controller.signal,
      });
    } catch (error) {
      throw wrapNetworkError(error);
    }
    if (!res.ok) {
      const raw = await readErrorBody(res);
      throw new MiniMaxError(`拉取模型列表失败（HTTP ${res.status}）：${raw}`, { status: res.status });
    }
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    return (json.data ?? []).map((m) => m.id ?? "").filter((id) => id.length > 0);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
