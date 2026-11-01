/**
 * agentState.ts —— 会话状态与消息管理（任务 1.2）
 *
 * 职责边界：
 * - 这里只管「消息进、消息出、token 估算」，不碰模型调用、不碰工具执行。
 * - 内部统一用 types.ts 的 Message（带 id / createdAt 等元信息）。
 * - 送给模型前用 getMessagesForModel 转成「provider 中立」的形状，
 *   这样 1.3 的 provider 封装只需要做一次 OpenAI 风格的字段映射，
 *   不用每次都重新遍历消息数组。
 *
 * 上下文压缩（任务 2.x）也会挂在这一层：它需要读全量消息、算 token、
 * 替换掉一段历史，所以状态和估算放在一起才好改。
 */

import type {
  AssistantMessage,
  Message,
  ToolCall,
  ToolCallId,
  ToolMessage,
  ToolResult,
} from "./types.js";

/** 会话状态。目前只有一个消息数组，后面可以加 token 预算等字段。 */
export interface AgentState {
  messages: Message[];
  /** 会话级元信息，暂不参与逻辑，仅用于日志/调试。 */
  meta: {
    createdAt: number;
  };
}

/**
 * 送给模型的「provider 中立」消息形状。
 * 字段名刻意贴近 OpenAI 兼容接口，但仍然不带 provider 私有字段，
 * 由 provider 层负责最终映射。
 */
export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** assistant 消息携带的工具调用。 */
  toolCalls?: ToolCall[];
  /** tool 消息必须携带，对应 assistant 里的某个 toolCall.id。 */
  toolCallId?: ToolCallId;
}

/** 创建初始状态，可选塞一条 system 提示。 */
export function createAgentState(systemPrompt?: string): AgentState {
  const state: AgentState = {
    messages: [],
    meta: { createdAt: Date.now() },
  };
  if (systemPrompt !== undefined && systemPrompt.length > 0) {
    addMessage(state, {
      role: "system",
      content: systemPrompt,
    });
  }
  return state;
}

let idCounter = 0;

/** 生成消息 ID。同一个进程内单调递增，便于日志排序。 */
function nextMessageId(): string {
  idCounter += 1;
  return `m_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

/**
 * addMessage —— 往会话里追加一条消息。
 *
 * 传入的 message 可以是完整的 Message（含 id/createdAt），
 * 也可以只给 role + content，缺失的元信息这里补齐。
 * 返回实际存入的那条消息，方便调用方拿到生成的 id。
 */
export function addMessage(
  state: AgentState,
  message:
    | Message
    | { role: "system" | "user"; content: string }
    | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
    | { role: "tool"; content: string; toolCallId: ToolCallId; ok?: boolean },
): Message {
  const full = {
    id: nextMessageId(),
    createdAt: Date.now(),
    ...message,
  } as Message;
  state.messages.push(full);
  return full;
}

/** 便捷方法：追加一条 user 消息。 */
export function addUserMessage(state: AgentState, content: string): Message {
  return addMessage(state, { role: "user", content });
}

/**
 * 便捷方法：追加一条 assistant 消息（可带 toolCalls）。
 *
 * 注意：带 toolCalls 的 assistant 消息和对应的 tool 消息必须成对出现，
 * 不然 provider 会报错。这就是 1.6d / 1.6f 要专门验证的点。
 */
export function addAssistantMessage(
  state: AgentState,
  content: string,
  toolCalls?: ToolCall[],
): AssistantMessage {
  const msg = addMessage(state, { role: "assistant", content, toolCalls });
  return msg as AssistantMessage;
}

/**
 * 便捷方法：把一次工具执行结果写成 tool 消息。
 *
 * toolCallId 直接取自 ToolResult.toolCallId —— 不在这里做「查找匹配」
 * 的猜测，保证写回时的 id 和 assistant 发起时的是同一个字符串。
 */
export function addToolMessage(state: AgentState, result: ToolResult): ToolMessage {
  const content =
    typeof result.result === "string"
      ? result.result
      : JSON.stringify(result.result);
  const msg = addMessage(state, {
    role: "tool",
    content,
    toolCallId: result.toolCallId,
    ok: result.ok,
  });
  return msg as ToolMessage;
}

/**
 * getMessagesForModel —— 取出可以直接交给 provider 的消息列表。
 *
 * 做了三件事：
 * 1. 转成 provider 中立形状（去掉 id / createdAt 这些本地元信息）；
 * 2. tool 消息带上 toolCallId，assistant 消息带上 toolCalls；
 * 3. 空内容的 assistant 消息保留 content=""（有些 provider 不接受 undefined），
 *    但 toolCalls 为空的 assistant 消息不输出 toolCalls 字段本身。
 */
export function getMessagesForModel(state: AgentState): ModelMessage[] {
  return state.messages.map((m): ModelMessage => {
    switch (m.role) {
      case "system":
      case "user":
        return { role: m.role, content: m.content };
      case "assistant": {
        const out: ModelMessage = { role: "assistant", content: m.content };
        if (m.toolCalls && m.toolCalls.length > 0) {
          out.toolCalls = m.toolCalls;
        }
        return out;
      }
      case "tool":
        return {
          role: "tool",
          content: m.content,
          toolCallId: m.toolCallId,
        };
    }
  });
}

/** 只取消息的纯文本部分（压缩/摘要时用来估算体积）。 */
export function getMessageText(m: Message): string {
  if (m.role === "tool") return m.content;
  let text = m.content;
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    // 工具名和参数也要占上下文，不能只算 content。
    text +=
      " " +
      m.toolCalls
        .map((c) => `${c.name}(${JSON.stringify(c.arguments)})`)
        .join(" ");
  }
  return text;
}

/**
 * estimateTokens —— 粗略 token 估算：字符数 / 4。
 *
 * 故意不做真 tokenizer：MiniMax / DeepSeek / OpenAI 各家 tokenizer 不同，
 * 真精确要引依赖且随版本漂移。4 字符/token 对中英混排是常用近似，
 * 够用来做「要不要触发压缩」的阈值判断。
 *
 * 入参可以是字符串，也可以是消息数组/消息列表。
 */
export function estimateTokens(input: string | Message | readonly Message[]): number {
  let text: string;
  if (typeof input === "string") {
    text = input;
  } else if (Array.isArray(input)) {
    text = (input as readonly Message[]).map(getMessageText).join("\n");
  } else {
    text = getMessageText(input as Message);
  }
  return Math.ceil(text.length / 4);
}

/** 当前会话的估算 token 数。 */
export function estimateStateTokens(state: AgentState): number {
  return estimateTokens(state.messages);
}

/** 清空消息（保留 meta），用于「开新话题」或压缩后重置。 */
export function clearMessages(state: AgentState): void {
  state.messages = [];
}
