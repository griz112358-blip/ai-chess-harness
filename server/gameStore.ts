/**
 * apps/chess/server/gameStore.ts —— 对局会话（服务端唯一权威）
 *
 * 前端不持有权威状态：所有走法先由这里校验、执行，再把结果快照下发给前端。
 * 这正是适配器模式的关键——模型说的不算，本地执行的结果才算。
 */

import { Chess } from "chess.js";
import { createGame } from "../shared/board.js";
import type { CoachLevel, PlayerColor } from "../shared/protocol.js";

/** 一条对话记忆。 */
export interface ChatEntry {
  role: "user" | "assistant";
  text: string;
  /** 记录这条消息时的回合数（ply），用于悔棋时裁剪上下文。 */
  plyAt: number;
}

/** 一次对局会话。 */
export interface GameSession {
  id: string;
  /** 棋局实例（权威状态）。 */
  chess: Chess;
  /** 用户执子颜色。 */
  userColor: PlayerColor;
  /** AI 执子颜色。 */
  aiColor: PlayerColor;
  /** 陪练水平。 */
  level: CoachLevel;
  /** 是否输出教学点评。 */
  coaching: boolean;
  /** 对话记忆（不含工具轨迹，避免上下文膨胀）。 */
  chat: ChatEntry[];
  /** AI 本回合是否已经落子（防止连走两步）。 */
  aiMoved: boolean;
  /** 是否已经结束。 */
  gameOver: boolean;
  /** 结束结果。 */
  result: string | null;
  /** 结束原因。 */
  reason: string | null;
  /** 待确认的和棋提议。 */
  drawOffer: { by: PlayerColor } | null;
  createdAt: number;
  /** 是否已经创建过 AI 的第一条消息（避免开局重复寒暄）。 */
  greeted: boolean;
}

/** 会话表。 */
const sessions = new Map<string, GameSession>();

let counter = 0;

function nextId(): string {
  counter += 1;
  return `g_${Date.now().toString(36)}_${counter.toString(36)}`;
}

/** 新建一局。 */
export function createSession(options: {
  userColor?: PlayerColor;
  level?: CoachLevel;
  coaching?: boolean;
}): GameSession {
  const userColor = options.userColor ?? "w";
  const session: GameSession = {
    id: nextId(),
    chess: createGame(),
    userColor,
    aiColor: userColor === "w" ? "b" : "w",
    level: options.level ?? "amateur",
    coaching: options.coaching ?? true,
    chat: [],
    aiMoved: false,
    gameOver: false,
    result: null,
    reason: null,
    drawOffer: null,
    createdAt: Date.now(),
    greeted: false,
  };
  sessions.set(session.id, session);
  return session;
}

/** 取会话。 */
export function getSession(id: string): GameSession | undefined {
  return sessions.get(id);
}

/** 删会话。 */
export function dropSession(id: string): void {
  sessions.delete(id);
}

/** 追加一条对话记忆。 */
export function pushChat(session: GameSession, role: "user" | "assistant", text: string): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  session.chat.push({ role, text: trimmed, plyAt: session.chess.history().length });
  // 对话记忆只留最近 12 条，防止上下文无限增长
  if (session.chat.length > 12) session.chat.splice(0, session.chat.length - 12);
}

/**
 * 悔棋：撤销最近 n 个半回合。
 * 用 chess.js 自己的 undo，保证历史、FEN、重复局面计数都正确。
 */
export function undoPlies(session: GameSession, count = 1): number {
  let undone = 0;
  for (let i = 0; i < count; i += 1) {
    if (session.chess.history().length === 0) break;
    session.chess.undo();
    undone += 1;
  }
  if (undone > 0) {
    const ply = session.chess.history().length;
    session.chat = session.chat.filter((entry) => entry.plyAt <= ply);
    session.aiMoved = false;
    session.gameOver = false;
    session.result = null;
    session.reason = null;
    session.drawOffer = null;
  }
  return undone;
}
