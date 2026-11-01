/**
 * loop.ts —— 通用工具调用循环（任务 1.6a ~ 1.6e）
 *
 * 这一层是「适配器」的核心骨架，和具体业务无关：
 *   调模型 → 解析工具调用 → 本地执行 → 结果写回消息 → 再调模型 → 直到模型不再要工具
 *
 * 业务侧只需要提供两样东西：
 * 1. 一张工具表（ToolTable）：声明动作 + 本地实现，本地实现返回什么就等于业务执行了什么；
 * 2. 一个 callModel 函数：把 provider 中立的消息交给模型，返回归一化后的 ModelResponse。
 *
 * 关键设计：
 * - 工具抛异常不会炸掉循环，统一包成 ok:false 的 ToolResult，模型能看到错误并自行纠正；
 * - 工具执行结果由本地代码生成并回填，模型无法伪造「已经落子」这类事实；
 * - 最大轮数保护，防止模型死循环。
 */

import { addAssistantMessage, addToolMessage, getMessagesForModel } from "./agentState.js";
import type { AgentState, ModelMessage } from "./agentState.js";
import type { ModelResponse, ToolCall, ToolResult, ToolTable } from "./types.js";

/** 循环过程中抛给上层的事件，可直接转成日志 / SSE。 */
export type LoopEvent =
  | { type: "model_call"; step: number; messageCount: number; toolNames: string[] }
  | { type: "model_text"; step: number; delta: string }
  | { type: "model_reasoning"; step: number; delta: string }
  | { type: "model_text_done"; step: number; text: string }
  | { type: "tool_call"; step: number; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; step: number; id: string; name: string; ok: boolean; summary: string }
  | { type: "error"; step: number; message: string }
  | { type: "done"; step: number };

/** 模型调用函数（provider 无关）。 */
export type CallModelFn = (messages: ModelMessage[], tools: ToolTable) => Promise<ModelResponse>;

/** 循环入参。 */
export interface RunLoopOptions {
  /** 会话状态：循环会把 assistant / tool 消息写回去。 */
  state: AgentState;
  /** 工具表。 */
  tools: ToolTable;
  /** 模型调用。 */
  callModel: CallModelFn;
  /** 最大轮数保护，默认 6。 */
  maxSteps?: number;
  /** 事件回调。 */
  onEvent?: (event: LoopEvent) => void;
  /** 每轮工具执行后问一次：返回 true 则提前结束循环。 */
  shouldStop?: (state: AgentState) => boolean;
}

/** 循环结果。 */
export interface LoopOutcome {
  /** 最后一轮模型输出的文字（可能为空）。 */
  text: string;
  /** 实际跑了几轮。 */
  steps: number;
  /** 是否因为到达最大轮数而停下。 */
  hitMaxSteps: boolean;
}

/**
 * executeToolCall —— 执行一次工具调用（任务 1.6c）。
 *
 * 三种失败都返回 ok:false 的 ToolResult，不让循环崩掉：
 * 1. 工具不存在；
 * 2. 工具内部抛异常；
 * 3. 工具正常返回但业务上失败（返回对象里带 ok:false）——这时保留原对象，
 *    模型能拿到结构化信息（比如"哪些走法是合法的"），而不是一句干巴巴的报错。
 */
export async function executeToolCall(call: ToolCall, tools: ToolTable): Promise<ToolResult> {
  const tool = tools[call.name];
  if (!tool) {
    const available = Object.keys(tools).join(", ");
    return {
      toolCallId: call.id,
      name: call.name,
      ok: false,
      result: `未知工具「${call.name}」。可用工具：${available}。请改用其中的一个。`,
    };
  }
  try {
    const result = await tool.execute(call.arguments);
    const businessFailed =
      typeof result === "object" &&
      result !== null &&
      (result as Record<string, unknown>)["ok"] === false;
    return {
      toolCallId: call.id,
      name: call.name,
      ok: !businessFailed,
      result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      toolCallId: call.id,
      name: call.name,
      ok: false,
      result: `工具「${call.name}」执行失败：${message}`,
    };
  }
}

/** 把工具结果压成一行摘要，给日志用。 */
export function summarizeResult(result: ToolResult): string {
  const raw = typeof result.result === "string" ? result.result : JSON.stringify(result.result);
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > 220 ? `${oneLine.slice(0, 220)}…` : oneLine;
}

/**
 * runAgentLoop —— 跑一次「模型 + 工具」闭环。
 *
 * 每一轮：
 * 1. 把当前消息列表交给模型；
 * 2. 模型给了工具调用 → 逐个执行 → 结果写成 tool 消息写回（toolCallId 严格对齐）；
 * 3. 模型没给工具调用 → 说明它说完了，退出。
 */
export async function runAgentLoop(options: RunLoopOptions): Promise<LoopOutcome> {
  const { state, tools, callModel, onEvent } = options;
  const maxSteps = options.maxSteps ?? 6;
  let step = 0;
  let lastText = "";
  let hitMaxSteps = false;

  while (step < maxSteps) {
    step += 1;
    const messages = getMessagesForModel(state);
    onEvent?.({
      type: "model_call",
      step,
      messageCount: messages.length,
      toolNames: Object.keys(tools),
    });

    let response: ModelResponse;
    try {
      response = await callModel(messages, tools);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onEvent?.({ type: "error", step, message });
      throw error;
    }

    if (response.reasoning) {
      onEvent?.({ type: "model_reasoning", step, delta: response.reasoning });
    }
    if (response.text) {
      lastText = response.text;
      onEvent?.({ type: "model_text_done", step, text: response.text });
    }

    // assistant 消息必须带上 toolCalls，tool 消息再按 id 回填——id 对不上 provider 会直接报错。
    addAssistantMessage(state, response.text, response.toolCalls);

    if (response.toolCalls.length === 0) {
      onEvent?.({ type: "done", step });
      return { text: response.text, steps: step, hitMaxSteps: false };
    }

    for (const call of response.toolCalls) {
      onEvent?.({
        type: "tool_call",
        step,
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      });
      const result = await executeToolCall(call, tools);
      onEvent?.({
        type: "tool_result",
        step,
        id: result.toolCallId,
        name: result.name,
        ok: result.ok,
        summary: summarizeResult(result),
      });
      addToolMessage(state, result);
    }

    if (options.shouldStop?.(state)) {
      onEvent?.({ type: "done", step });
      return { text: lastText, steps: step, hitMaxSteps: false };
    }
  }

  hitMaxSteps = true;
  onEvent?.({ type: "done", step });
  return { text: lastText, steps: step, hitMaxSteps: true };
}
