/**
 * 核心类型定义（任务 1.1）
 *
 * 设计要点：
 * - Message 用 discriminated union，以 `role` 为判别字段，
 *   这样 "assistant 消息携带 toolCalls" / "tool 消息携带 toolCallId"
 *   能在类型层面被精确表达，访问不需要类型断言。
 * - ToolCall.arguments 是已解析的对象（不是 JSON 字符串），
 *   provider 层负责把各家不同格式统一到这里（见任务 1.6b）。
 */

/** 工具调用 ID。assistant 侧发起，tool 侧回填，必须严格一致。 */
export type ToolCallId = string;

/** 消息角色。 */
export type Role = "system" | "user" | "assistant" | "tool";

/** 模型发起的一次工具调用。 */
export interface ToolCall {
  /** 与本轮 assistant 消息内唯一的调用 ID。 */
  id: ToolCallId;
  /** 工具名，对应 Tool.name。 */
  name: string;
  /** 已解析的参数对象。 */
  arguments: Record<string, unknown>;
}

/** 工具执行结果。 */
export interface ToolResult {
  /** 与被调用的 ToolCall.id 对应。 */
  toolCallId: ToolCallId;
  /** 工具名，便于排查。 */
  name: string;
  /** 是否执行成功。失败时 result 通常是错误描述。 */
  ok: boolean;
  /** 返回给模型的内容（字符串或可序列化对象）。 */
  result: string | Record<string, unknown>;
}

/** 基础消息字段。 */
interface MessageBase {
  /** 消息唯一 ID，便于去重与写回定位。 */
  id: string;
  /** 创建时间戳（毫秒）。 */
  createdAt: number;
}

/** system / user 消息：纯文本。 */
export interface TextMessage extends MessageBase {
  role: "system" | "user";
  content: string;
}

/** assistant 消息：可以只回文本，也可以回文本 + 工具调用。 */
export interface AssistantMessage extends MessageBase {
  role: "assistant";
  content: string;
  /** 本轮请求的工具调用列表，可为空。 */
  toolCalls?: ToolCall[];
}

/** tool 消息：工具执行结果，必须带上它对应的 toolCallId。 */
export interface ToolMessage extends MessageBase {
  role: "tool";
  content: string;
  /** 对应 assistant 消息中某个 ToolCall.id。 */
  toolCallId: ToolCallId;
  /** 便于过滤，执行失败时标记。 */
  ok: boolean;
}

/** 消息联合类型。 */
export type Message = TextMessage | AssistantMessage | ToolMessage;

/**
 * provider 归一化后的模型响应（任务 1.6b）。
 *
 * 各家 provider 返回结构差异很大（tool_calls / function.arguments 是字符串还是对象、
 * 思考内容放在 reasoning_content 还是 reasoning_details……），
 * provider 层负责把这些差异全部抹平，上层循环只认这一种形状。
 */
export interface ModelResponse {
  /** 模型的文字输出。纯工具调用型响应里可能是空字符串。 */
  text: string;
  /** 结构化工具调用，arguments 已解析成对象。 */
  toolCalls: ToolCall[];
  /** 推理模型的思考内容（可选，只用于日志展示，不进上下文）。 */
  reasoning?: string;
  /** token 用量（可选）。 */
  usage?: ModelUsage;
}

/** token 用量。字段按 OpenAI 兼容命名，缺失就不填。 */
export interface ModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/**
 * JSON Schema 描述的参数定义（简化的子集，够 provider 声明使用）。
 */
export interface ToolParameters {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

/**
 * 工具定义：声明 + 实现。
 */
export interface Tool<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  /** 工具唯一名，模型通过它发起调用。 */
  name: string;
  /** 给模型看的用途说明。 */
  description: string;
  /** 参数 schema。 */
  parameters: ToolParameters;
  /** 执行实现。抛出的异常由上层包装成错误 ToolResult。 */
  execute(args: TArgs): Promise<string | Record<string, unknown>> | string | Record<string, unknown>;
}

/** 工具表：name -> Tool。 */
export type ToolTable = Record<string, Tool>;
