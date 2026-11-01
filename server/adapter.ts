/**
 * apps/chess/server/adapter.ts —— 适配器核心：把「模型」接到「棋局」上
 *
 * 这一层做的事情，正好对应你说的那套适配器思路：
 *   1. 收集本地业务信息（棋盘、合法走法、轮到谁）
 *   2. 拼上知识库（按局面检索）和规则说明（system prompt）
 *   3. 交给模型，让它按约定的操作方式表达意图
 *   4. 本地执行工具，把执行结果回填给模型
 *   5. 模型没走子 / 走错 → 纠偏后重试（自修复回路）
 *
 * 关键点：模型永远拿不到"自己已经做了什么"的幻觉，
 * 因为它看到的所有局面信息都来自本地代码的执行结果。
 */

import { addAssistantMessage, addUserMessage, createAgentState } from "../src/agentState.js";
import { runAgentLoop } from "../src/loop.js";
import type { CallModelFn } from "../src/loop.js";
import type { LoopEvent } from "../src/loop.js";
import { callModelStream } from "../src/provider/minimax.js";
import type { MiniMaxConfig } from "../src/provider/minimax.js";
import { createSmartMockCallModel } from "../src/provider/mock.js";
import type { ModelResponse, ToolTable } from "../src/types.js";
import { applyNotation, buildSnapshot, gameOutcome, gamePhase, pickSimpleMove } from "../shared/board.js";
import type { GameSnapshot, ServerEvent } from "../shared/protocol.js";
import { loadKnowledge, selectKnowledge } from "./knowledge.js";
import { pushChat, type GameSession } from "./gameStore.js";
import { buildStateMessage, buildSystemPrompt } from "./prompt.js";
import { createChessTools } from "./tools.js";

/** 知识库在进程启动时加载一次即可。 */
const KNOWLEDGE = loadKnowledge();

/** 一回合的运行参数。 */
export interface TurnOptions {
  /** 模型接入配置（API Key / baseUrl / 模型名等）。 */
  config: MiniMaxConfig;
  /** 用户这一轮说的话（可空）。 */
  userMessage?: string;
  /** 事件下发。 */
  emit: (event: ServerEvent) => void;
  /** 强制使用 mock 模型（离线自测）。 */
  mock?: boolean;
  /**
   * 自定义模型调用（测试钩子）。
   * 传了就用它，不走 provider —— 用来复现"模型只回文字不调工具"这类行为。
   */
  callModel?: CallModelFn;
  /**
   * 这一回合是否必须落子。
   * true（默认）：轮到 AI 走棋，必须 make_move，没走成就纠偏重试。
   * false：轮到用户走棋，AI 只需要回应（say），不许走子。
   */
  requireMove?: boolean;
}

/** 回合结果。 */
export interface TurnResult {
  /** AI 是否落子了。 */
  moved: boolean;
  /** AI 说的话。 */
  said: string[];
  /** 调了几次模型。 */
  rounds: number;
}

/** 给前端下发权威快照。 */
export function snapshotOf(session: GameSession): GameSnapshot {
  return buildSnapshot(session.chess, {
    gameId: session.id,
    userColor: session.userColor,
    drawOffer: session.drawOffer,
    extraResult: session.result,
    extraReason: session.reason,
  });
}

/**
 * runAITurn —— 执行 AI 的一个完整回合。
 *
 * 内层是「模型 → 工具 → 执行 → 回填」循环（harness 的 loop.ts）；
 * 外层套一层「没走子就纠偏重试」的保护。
 */
export async function runAITurn(session: GameSession, options: TurnOptions): Promise<TurnResult> {
  const { emit, config } = options;

  if (session.gameOver) {
    emit({ type: "status", text: "对局已结束" });
    return { moved: false, said: [], rounds: 0 };
  }

  // 1) 组装上下文：规则说明 + 知识库 + 对话记忆 + 当前局面
  const requireMove = options.requireMove !== false;
  const phase = gamePhase(session.chess);
  const knowledge = selectKnowledge(KNOWLEDGE, { phase, userMessage: options.userMessage });
  const systemPrompt = buildSystemPrompt(session, knowledge, { requireMove });

  const state = createAgentState(systemPrompt);
  for (const entry of session.chat) {
    if (entry.role === "user") addUserMessage(state, entry.text);
    else addAssistantMessage(state, entry.text);
  }
  addUserMessage(state, buildStateMessage(session, options.userMessage));

  const tools: ToolTable = createChessTools(session);
  /** tool_callId → say 的内容，用来在工具成功后立刻把话送到前端。 */
  const sayByCallId = new Map<string, string>();
  const said: string[] = [];
  let rounds = 0;

  const callModel = async (
    messages: Parameters<typeof callModelStream>[1],
    toolTable: ToolTable,
  ): Promise<ModelResponse> => {
    rounds += 1;
    if (options.callModel) {
      return options.callModel(messages, toolTable);
    }
    if (options.mock) {
      const mock = createSmartMockCallModel();
      const response = await mock(messages, toolTable);
      if (response.text) emit({ type: "model_text", text: response.text });
      return response;
    }
    return callModelStream(config, messages, toolTable, {
      onEvent: (event) => {
        if (event.type === "text") emit({ type: "model_text", text: event.delta });
        if (event.type === "reasoning") emit({ type: "reasoning", text: event.delta });
      },
    });
  };

  const onLoopEvent = (event: LoopEvent): void => {
    switch (event.type) {
      case "model_call":
        emit({ type: "model_call", step: event.step, toolNames: event.toolNames });
        break;
      case "model_text_done":
        emit({ type: "model_text", text: event.text });
        break;
      case "model_reasoning":
        emit({ type: "reasoning", text: event.delta });
        break;
      case "tool_call": {
        emit({ type: "tool_call", name: event.name, arguments: event.arguments });
        // say 的内容在执行之前就拿到了（执行失败时会被丢弃）
        if (event.name === "say") {
          const message = String(event.arguments["message"] ?? "").trim();
          if (message.length > 0) sayByCallId.set(event.id, message);
        }
        break;
      }
      case "tool_result": {
        emit({ type: "tool_result", name: event.name, ok: event.ok, summary: event.summary });
        // say 成功 → 立刻把这句话送到前端，不用等整个回合结束
        if (event.name === "say" && event.ok) {
          const message = sayByCallId.get(event.id);
          if (message) {
            sayByCallId.delete(event.id);
            said.push(message);
            pushChat(session, "assistant", message);
            emit({ type: "chat", role: "ai", text: message });
          }
        }
        break;
      }
      case "error":
        emit({ type: "error", message: event.message });
        break;
      default:
        break;
    }
  };

  // 2) 主循环 + 自修复：模型没走子就纠偏重来，最多 3 次
  //    （requireMove=false 时不纠偏——那时轮到用户走，AI 只需要说话）
  const maxAttempts = requireMove ? 3 : 1;
  let lastText = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const outcome = await runAgentLoop({
      state,
      tools,
      callModel,
      onEvent: onLoopEvent,
      maxSteps: 6,
      // AI 落子（或认输）就算这一回合完成，不再让它重复走子
      shouldStop: () => session.aiMoved || session.gameOver,
    });
    lastText = outcome.text;
    if (!requireMove || session.aiMoved || session.gameOver) break;
    if (attempt < maxAttempts) {
      emit({
        type: "status",
        text: `模型这一轮没有走子（第 ${attempt} 次），正在纠偏重试……`,
      });
      addUserMessage(
        state,
        "纠正：你还没有走棋。现在轮到你，必须调用 make_move，从【当前局面】的合法走法列表里走一步棋；" +
          "不要用文字描述你的走法。想说话就同时调用 say。",
      );
    }
  }

  // 3) 模型用自然语言回答（而不是调 say）时，这段文字就是它要说的话
  if (said.length === 0 && lastText.trim().length > 0) {
    pushChat(session, "assistant", lastText.trim());
    emit({ type: "chat", role: "ai", text: lastText.trim() });
  }

  // 4) 兜底：纠偏多次后模型仍未落子 → 本地代走一步，避免卡死
  //    （这一步会明确告诉用户"这是系统代走"，不冒充模型）
  if (requireMove && !session.aiMoved && !session.gameOver) {
    const fallback = pickSimpleMove(session.chess);
    if (fallback) {
      const applied = applyNotation(session.chess, fallback);
      if (applied.ok) {
        session.aiMoved = true;
        const outcome = gameOutcome(session.chess);
        if (outcome.over) {
          session.gameOver = true;
          session.result = outcome.result;
          session.reason = outcome.reason;
        }
        emit({
          type: "status",
          text: `模型连续 ${maxAttempts} 轮没有落子，系统代走一步 ${applied.san}。`,
        });
        const message = `（我这回合没能给出走法，系统先代走了一步 ${applied.san}，这步只是兜底，不代表我的想法。）`;
        pushChat(session, "assistant", message);
        emit({ type: "chat", role: "ai", text: message });
      }
    }
  }

  return { moved: session.aiMoved, said, rounds };
}
