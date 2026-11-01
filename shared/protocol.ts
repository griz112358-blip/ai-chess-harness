/**
 * apps/chess/shared/protocol.ts —— 前后端共享的协议类型
 *
 * 前端不自己算棋，只消费服务端下发的快照；服务端是唯一权威。
 * 这一条边界很重要：适配器的价值就在于「本地逻辑是唯一事实来源」。
 */

export type PlayerColor = "w" | "b";

/** 一次对局的快照：前端渲染棋盘的全部依据。 */
export interface GameSnapshot {
  gameId: string;
  /** 标准 FEN，前端用它在本地建 chess.js 实例做渲染和高亮。 */
  fen: string;
  /** 现在轮到谁走。 */
  turn: PlayerColor;
  /** 用户执子颜色。 */
  userColor: PlayerColor;
  /** 上一步走法（用于棋盘高亮）。 */
  lastMove: { from: string; to: string } | null;
  /** 当前是否被将军。 */
  check: boolean;
  /** 对局是否结束。 */
  gameOver: boolean;
  /** 结果："1-0" / "0-1" / "1/2-1/2"，未结束为 null。 */
  result: string | null;
  /** 结束原因：checkmate / stalemate / resign / draw_agreed / insufficient_material ... */
  reason: string | null;
  /** 当前回合数（第几手）。 */
  moveNumber: number;
  /** 全部走子记谱（SAN）。 */
  sanHistory: string[];
  /** PGN 导出串。 */
  pgn: string;
  /** 待处理的和棋提议。 */
  drawOffer: { by: PlayerColor } | null;
}

/** 服务端 → 前端的流式事件（走 SSE）。 */
export type ServerEvent =
  | { type: "status"; text: string }
  | { type: "chat"; role: "user" | "ai" | "system"; text: string }
  | { type: "chat_delta"; text: string }
  | { type: "board"; snapshot: GameSnapshot }
  | { type: "model_call"; step: number; toolNames: string[] }
  | { type: "model_text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; name: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; name: string; ok: boolean; summary: string }
  | { type: "draw_offer"; by: PlayerColor }
  | { type: "error"; message: string; hint?: string }
  | { type: "done" };

/** 前端 → 服务端的请求体。 */
export interface MoveRequest {
  from: string;
  to: string;
  promotion?: "q" | "r" | "b" | "n";
}

export interface ChatRequest {
  message: string;
}

/** 陪练水平档位。 */
export type CoachLevel = "beginner" | "amateur" | "club" | "master";

/** 前端保存的设置。 */
export interface AppSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  level: CoachLevel;
  userColor: PlayerColor;
  /** 是否让 AI 在回复里附带教学点评。 */
  coaching: boolean;
  /** 显式关闭模型思考（更快）。 */
  disableThinking: boolean;
  /** 温度。 */
  temperature: number;
}
