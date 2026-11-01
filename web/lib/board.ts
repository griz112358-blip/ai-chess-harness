/**
 * apps/chess/web/lib/board.ts —— 前端棋盘渲染辅助
 *
 * 前端用 chess.js 从服务端下发的 FEN 还原棋盘，只用于显示和高亮，
 * 不参与任何规则判定（规则判定全在服务端）。
 */

import { Chess } from "chess.js";

/** 棋盘文件与行号。 */
export const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
export const RANKS = [8, 7, 6, 5, 4, 3, 2, 1] as const;

/** 棋子字符（Unicode 图形）。 */
const GLYPHS: Record<string, Record<string, string>> = {
  w: { k: "♔", q: "♕", r: "♖", b: "♗", n: "♘", p: "♙" },
  b: { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" },
};

/** 一个格子的棋子。 */
export interface PieceInfo {
  type: string;
  color: "w" | "b";
  glyph: string;
}

/** 一条合法走法。 */
export interface LegalMoveInfo {
  from: string;
  to: string;
  promotion?: string;
}

/** 从 FEN 建棋局。 */
export function boardFromFen(fen: string): Chess {
  try {
    return new Chess(fen);
  } catch {
    return new Chess();
  }
}

/** 取每个格子的棋子。 */
export function pieceMap(chess: Chess): Record<string, PieceInfo> {
  const map: Record<string, PieceInfo> = {};
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell) continue;
      map[cell.square] = {
        type: cell.type,
        color: cell.color,
        glyph: GLYPHS[cell.color]?.[cell.type] ?? "?",
      };
    }
  }
  return map;
}

/** 当前所有合法走法。 */
export function legalMoveList(chess: Chess): LegalMoveInfo[] {
  return chess.moves({ verbose: true }).map((m) => ({
    from: m.from,
    to: m.to,
    ...(m.promotion ? { promotion: m.promotion } : {}),
  }));
}

/** 找出被将军的王在哪。 */
export function checkedKingSquare(chess: Chess): string | null {
  if (!chess.isCheck()) return null;
  const board = chess.board();
  for (const row of board) {
    for (const cell of row) {
      if (cell && cell.type === "k" && cell.color === chess.turn()) return cell.square;
    }
  }
  return null;
}
