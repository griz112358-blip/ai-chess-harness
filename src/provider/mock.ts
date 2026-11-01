/**
 * provider/mock.ts —— 假模型（离线自测用）
 *
 * 作用：没有 API Key 也能把「模型 → 工具 → 本地执行 → 写回」整条链路跑通。
 * mock 返回的是 **原始 provider 响应格式**（OpenAI 兼容的 JSON），
 * 走的是和真实调用完全一样的解析路径（parseToolCalls / parseText），
 * 所以它能真实覆盖 1.6b 的字段映射逻辑，而不是绕过去。
 */

import { parseText, parseToolCalls } from "./minimax.js";
import type { ModelMessage } from "../agentState.js";
import type { CallModelFn } from "../loop.js";
import type { ModelResponse, ToolCall } from "../types.js";

/** 原始 provider 响应（OpenAI 兼容形状）。 */
export type RawResponse = Record<string, unknown>;

/** 构造一个带工具调用的原始响应。 */
export function makeToolCallResponse(
  name: string,
  args: Record<string, unknown>,
  options: { text?: string; id?: string } = {},
): RawResponse {
  return {
    id: `chatcmpl-mock-${Math.random().toString(36).slice(2, 10)}`,
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: options.text ?? "",
          tool_calls: [
            {
              id: options.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** 构造一个纯文本响应。 */
export function makeTextResponse(text: string): RawResponse {
  return {
    id: `chatcmpl-mock-${Math.random().toString(36).slice(2, 10)}`,
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
  };
}

/**
 * createMockCallModel —— 按脚本依次返回响应。
 *
 * 脚本用完之后返回最后一个响应（方便做「先非法、后合法」这种多轮修复场景）。
 */
export function createMockCallModel(script: RawResponse[]): CallModelFn {
  let index = 0;
  return async (): Promise<ModelResponse> => {
    const raw = script[Math.min(index, script.length - 1)];
    index += 1;
    if (!raw) return { text: "", toolCalls: [] };
    const response: ModelResponse = {
      text: parseText(raw),
      toolCalls: parseToolCalls(raw),
    };
    return response;
  };
}

/**
 * createSmartMockCallModel —— 从「状态消息」里读合法走法并挑一个。
 *
 * 专门给棋局用：它认得状态消息里的「合法走法」列表，
 * 因此可以让整个棋类应用在没有 API Key 的情况下端到端跑起来。
 */
export function createSmartMockCallModel(options: { preferCapture?: boolean } = {}): CallModelFn {
  return async (messages: ModelMessage[]): Promise<ModelResponse> => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const content = lastUser?.content ?? "";
    const legal = parseLegalMoves(content);
    const isWhiteTurn = /轮到白方/.test(content);
    const move = pickMove(legal, isWhiteTurn, options.preferCapture ?? true);
    const toolCalls: ToolCall[] = [];

    // 用户提了问题 → 先说一句（和真实模型一样，一次回复里 say + make_move）
    const asked = /【用户对你说的话】\s*([^\n]+)/.exec(content);
    if (asked && asked[1]) {
      toolCalls.push({
        id: `call_mock_say_${Date.now().toString(36)}`,
        name: "say",
        arguments: { message: "（mock）我先按原则走了一步，你有什么想法？" },
      });
    }

    if (move && !/轮到用户走/.test(content)) {
      toolCalls.push({
        id: `call_mock_move_${Date.now().toString(36)}`,
        name: "make_move",
        arguments: { move },
      });
    }

    if (toolCalls.length === 0) {
      return { text: "（mock）没有找到合法走法", toolCalls: [] };
    }
    return { text: "", toolCalls };
  };
}

/** 从状态消息里抽出合法走法列表。 */
export function parseLegalMoves(stateText: string): string[] {
  const match = stateText.match(/合法走法[^\n：:]*[：:]\s*([^\n]+)/);
  if (!match || !match[1]) return [];
  return match[1]
    .split(/[、,，\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 简单启发式：优先吃子，其次挑中心格，最后取第一个。 */
export function pickMove(legal: string[], isWhite: boolean, preferCapture: boolean): string | undefined {
  if (legal.length === 0) return undefined;
  if (preferCapture) {
    const capture = legal.find((m) => m.includes("x"));
    if (capture) return capture;
  }
  const center = ["d4", "d5", "e4", "e5", "c4", "c5", "f4", "f5"];
  for (const c of center) {
    const hit = legal.find((m) => m.toLowerCase() === c);
    if (hit) return hit;
  }
  return legal[0];
}
