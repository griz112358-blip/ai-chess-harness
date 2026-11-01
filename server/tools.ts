/**
 * apps/chess/server/tools.ts —— 棋类工具表（模型的"操作方式"）
 *
 * 这一层就是「约定好的操作方式」的落地：
 * 模型只有 4 个动作可用，每个动作都由本地代码执行并返回事实。
 * 模型说"我走了 e4"，真正落子的是这里的 applyNotation；
 * 模型说"我将军了"，如果局面不支持，工具会拒绝并要求重选。
 *
 * 工具返回值一律是可序列化对象，且**只包含本地计算出的事实**，
 * 模型无法通过返回值虚构"我已经做了什么"。
 */

import type { Tool, ToolTable } from "../src/types.js";
import {
  applyNotation,
  asciiBoard,
  describePosition,
  gameOutcome,
  legalSanMoves,
} from "../shared/board.js";
import type { GameSession } from "./gameStore.js";

/** 工具返回给模型的统一结构。 */
interface ToolPayload {
  ok: boolean;
  [key: string]: unknown;
}

/** 生成绑定到某个会话的工具表。 */
export function createChessTools(session: GameSession): ToolTable {
  const makeMove: Tool = {
    name: "make_move",
    description:
      "走一步棋。move 必须是当前局面「合法走法」列表里原样出现的 SAN 记谱（例如 Nf3、exd5、O-O、e8=Q）。" +
      "走完后系统会返回更新后的局面，请以返回内容为准，不要凭记忆继续判断。",
    parameters: {
      type: "object",
      properties: {
        move: {
          type: "string",
          description: "一个合法走法的 SAN 记谱，例如 'Nf3'、'exd5'、'O-O'",
        },
      },
      required: ["move"],
    },
    execute: (args: Record<string, unknown>): ToolPayload => {
      const raw = String(args["move"] ?? "").trim();

      if (session.gameOver) {
        return { ok: false, error: "对局已经结束，不能再走子。" };
      }
      if (session.chess.turn() !== session.aiColor) {
        const side = session.chess.turn() === "w" ? "白方" : "黑方";
        return { ok: false, error: `现在轮到${side}走棋，还没轮到你走。` };
      }
      if (session.aiMoved) {
        return { ok: false, error: "你这一步已经走过了，一步棋只能走一次。" };
      }

      const result = applyNotation(session.chess, raw);
      if (!result.ok) {
        const legal = result.legal;
        const preview = legal.slice(0, 40).join(" ");
        return {
          ok: false,
          error: `${result.error} 当前合法走法只有：${preview}${legal.length > 40 ? " …" : ""}`,
          legalMoves: legal,
        };
      }

      session.aiMoved = true;
      const outcome = gameOutcome(session.chess);
      if (outcome.over) {
        session.gameOver = true;
        session.result = outcome.result;
        session.reason = outcome.reason;
      }

      return {
        ok: true,
        san: result.san,
        captured: result.captured ?? null,
        fen: session.chess.fen(),
        board: asciiBoard(session.chess),
        describe: describePosition(session.chess),
        legalMoves: legalSanMoves(session.chess),
        gameOver: outcome.over,
        result: outcome.result,
        reason: outcome.reason,
      };
    },
  };

  const say: Tool = {
    name: "say",
    description:
      "对用户说一句话：点评对手刚走的棋、解释你的意图、鼓励或提问。最多 2-3 句，中文口语化，不要复述棋盘。",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "要说的话，中文，2-3 句以内" },
      },
      required: ["message"],
    },
    execute: (args: Record<string, unknown>): ToolPayload => {
      const message = String(args["message"] ?? "").trim();
      if (message.length === 0) {
        return { ok: false, error: "message 不能为空。" };
      }
      return { ok: true, delivered: true, chars: message.length };
    },
  };

  const resign: Tool = {
    name: "resign",
    description: "认输。局面已经无法挽回、或者你被彻底将死时才用。",
    parameters: { type: "object", properties: {}, required: [] },
    execute: (): ToolPayload => {
      if (session.gameOver) {
        return { ok: false, error: "对局已经结束。" };
      }
      session.gameOver = true;
      session.reason = "resign";
      session.result = session.aiColor === "w" ? "0-1" : "1-0";
      return { ok: true, gameOver: true, result: session.result, reason: "resign" };
    },
  };

  const offerDraw: Tool = {
    name: "offer_draw",
    description: "提出和棋。局面僵持、双方都不占便宜时用；用户会看到提示并决定是否接受。",
    parameters: { type: "object", properties: {}, required: [] },
    execute: (): ToolPayload => {
      if (session.gameOver) {
        return { ok: false, error: "对局已经结束。" };
      }
      session.drawOffer = { by: session.aiColor };
      return { ok: true, pending: true, message: "已向用户提出和棋，等待对方确认。" };
    },
  };

  return {
    make_move: makeMove,
    say: say,
    resign: resign,
    offer_draw: offerDraw,
  };
}

/** 工具名清单，用于提示词和日志。 */
export const CHESS_TOOL_NAMES = ["make_move", "say", "resign", "offer_draw"] as const;
