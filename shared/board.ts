/**
 * apps/chess/shared/board.ts —— 棋局本地逻辑（棋盘、合法走法、走法解析）
 *
 * 这一层就是「业务侧的执行器」：
 * 模型只能通过走法记谱表达意图，能不能落子由这里说了算。
 * 所有校验都发生在这里，模型拿到的也是这里生成的结果。
 */

import { Chess } from "chess.js";
import type { GameSnapshot, PlayerColor } from "./protocol.js";

/** 棋局阶段，决定给模型检索哪部分知识库。 */
export type GamePhase = "opening" | "middlegame" | "endgame";

/** 各子力价值（用于子力差计算）。 */
const PIECE_VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** 子力差的文字描述用。 */
const PIECE_NAMES: Record<string, string> = { p: "兵", n: "马", b: "象", r: "车", q: "后", k: "王" };

/** 统计双方各兵种数量。 */
function countPieces(chess: Chess): { w: Record<string, number>; b: Record<string, number> } {
  const w: Record<string, number> = {};
  const b: Record<string, number> = {};
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell) continue;
      const bucket = cell.color === "w" ? w : b;
      bucket[cell.type] = (bucket[cell.type] ?? 0) + 1;
    }
  }
  return { w, b };
}

/**
 * describeMaterial —— 把子力差说成人话。
 *
 * 之前写的是"白方多 4 个兵"，其实是"多 4 分"（1 马 + 1 兵），
 * 模型读到这句话后专门花了好几段思考去核对，还以为程序算错了。
 */
export function describeMaterial(chess: Chess): string {
  const { w, b } = countPieces(chess);
  const diff = materialDiff(chess);
  if (diff === 0) return "子力持平";

  const richer = diff > 0 ? w : b;
  const poorer = diff > 0 ? b : w;
  const richerSide = diff > 0 ? "白方" : "黑方";
  const parts: string[] = [];
  for (const type of ["q", "r", "b", "n", "p"]) {
    const delta = (richer[type] ?? 0) - (poorer[type] ?? 0);
    if (delta > 0) parts.push(`${delta} ${PIECE_NAMES[type] ?? type}`);
  }
  if (parts.length === 0) return "子力持平";
  return `${richerSide}多 ${parts.join("、")}（共 ${Math.abs(diff)} 分）`;
}

/** 新开一局标准初始局面。 */
export function createGame(): Chess {
  return new Chess();
}

/**
 * asciiBoard —— 生成给模型看的 ASCII 棋盘。
 * 大写是白棋，小写是黑棋，空格用 "." 表示。
 */
export function asciiBoard(chess: Chess): string {
  const board = chess.board();
  const rows: string[] = [];
  for (let r = 0; r < 8; r += 1) {
    const row = board[r] ?? [];
    const cells = row.map((cell) => {
      if (!cell) return ".";
      return cell.color === "w" ? cell.type.toUpperCase() : cell.type;
    });
    rows.push(`${8 - r}  ${cells.join(" ")}`);
  }
  rows.push("   a b c d e f g h");
  return rows.join("\n");
}

/** 当前所有合法走法（SAN 记谱）。 */
export function legalSanMoves(chess: Chess): string[] {
  return chess.moves({ verbose: true }).map((m) => m.san);
}

/** 子力差（白 - 黑），用兵当单位。 */
export function materialDiff(chess: Chess): number {
  let diff = 0;
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell) continue;
      const value = PIECE_VALUES[cell.type] ?? 0;
      diff += cell.color === "w" ? value : -value;
    }
  }
  return diff;
}

/** 判断当前处于哪个阶段。 */
export function gamePhase(chess: Chess): GamePhase {
  if (chess.moveNumber() <= 10) return "opening";
  const board = chess.board();
  let queens = 0;
  let pieces = 0;
  for (const row of board) {
    for (const cell of row) {
      if (!cell) continue;
      pieces += 1;
      if (cell.type === "q") queens += 1;
    }
  }
  if (queens <= 1 || pieces <= 12) return "endgame";
  return "middlegame";
}

/** 走法记谱归一化：去掉修饰符，把 "0-0" 修成 "O-O"。 */
export function normalizeNotation(raw: string): string {
  let text = raw.trim().replace(/\s+/g, "");
  text = text.replace(/[!?+#]/g, "");
  text = text.replace(/=/g, "");
  if (/^0-0-0$/i.test(text)) text = "O-O-O";
  else if (/^0-0$/i.test(text)) text = "O-O";
  else if (/^o-o-o$/i.test(text)) text = "O-O-O";
  else if (/^o-o$/i.test(text)) text = "O-O";
  return text;
}

/** 走法解析结果。 */
export type MoveApplyResult =
  | { ok: true; san: string; captured?: string }
  | { ok: false; error: string; legal: string[] };

/**
 * applyNotation —— 把模型给的走法记谱落到棋盘上。
 *
 * 接受：SAN（Nf3 / exd5 / O-O / e8=Q）、UCI（g1f3 / e7e8q）、from-to（e2-e4）。
 * 找不到合法对应时返回错误 + 当前合法走法，让模型自己纠正。
 */
export function applyNotation(chess: Chess, raw: string): MoveApplyResult {
  const notation = normalizeNotation(raw);
  const legal = chess.moves({ verbose: true });
  const legalSan = legal.map((m) => m.san);

  if (notation.length === 0) {
    return { ok: false, error: "走法为空。", legal: legalSan };
  }

  // 1) SAN 精确匹配（忽略大小写）
  const sanMatch = legal.find((m) => normalizeNotation(m.san).toLowerCase() === notation.toLowerCase());
  if (sanMatch) {
    const move = chess.move(sanMatch.san);
    return { ok: true, san: move.san, captured: move.captured };
  }

  // 2) UCI 匹配，例如 g1f3、e7e8q
  const uci = notation.toLowerCase();
  if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promo = uci[4];
    const uciMatch = legal.find(
      (m) => m.from === from && m.to === to && (promo ? m.promotion === promo : true),
    );
    if (uciMatch) {
      const move = chess.move(uciMatch.san);
      return { ok: true, san: move.san, captured: move.captured };
    }
  }

  // 3) 兜底：交给 chess.js 宽松解析（strict: false）
  try {
    const move = chess.move(notation);
    if (move) return { ok: true, san: move.san, captured: move.captured };
  } catch {
    // 落到下面的错误分支
  }

  return {
    ok: false,
    error: `「${raw.trim()}」不是当前局面的合法走法。`,
    legal: legalSan,
  };
}

/**
 * pickSimpleMove —— 兜底走法。
 *
 * 模型连续多轮不肯落子时，本地挑一步"不会错"的棋，避免对局卡死。
 *
 * 之前的版本是"优先吃子"，结果挑中过最烂的一手（后去吃兵，还被兵反吃）。
 * 现在按子力收益筛：
 * 1. 先剔除"送子"的走法（吃子价值低于送出棋子的价值）；
 * 2. 剩下能赚子的走法里，挑吃的目标最便宜的那种；
 * 3. 都不会赚子就挑中心兵 / 中心格；
 * 4. 最后退到第一个合法走法。
 * 这步会明确标注是系统代走，不会冒充模型的选择。
 */
export function pickSimpleMove(chess: Chess): string | undefined {
  const legal = chess.moves({ verbose: true });
  if (legal.length === 0) return undefined;

  const value = (type?: string): number => (type ? (PIECE_VALUES[type] ?? 0) : 0);
  const scored = legal.map((move) => {
    const gain = value(move.captured) - value(move.piece);
    return { move, gain };
  });

  // 1) 不亏子的走法（gain >= 0）
  const safe = scored.filter((s) => s.gain >= 0);
  const pool = safe.length > 0 ? safe : scored;

  // 2) 能赚子就赚子，且优先吃便宜的（吃兵 > 吃马 > 吃车 > 吃后）
  const gains = pool.filter((s) => s.gain > 0);
  if (gains.length > 0) {
    gains.sort((a, b) => value(a.move.captured) - value(b.move.captured));
    const best = gains[0]!;
    return best.move.san;
  }

  // 3) 推中心兵
  const center = ["d4", "d5", "e4", "e5", "c4", "c5", "f4", "f5"];
  for (const square of center) {
    const hit = pool.find((s) => s.move.san.toLowerCase() === square);
    if (hit) return hit.move.san;
  }

  // 4) 走兵 / 第一个合法走法
  const pawn = pool.find((s) => s.move.piece === "p");
  return (pawn ?? pool[0])?.move.san;
}

/** 棋局结束状态。 */
export function gameOutcome(chess: Chess): { over: boolean; result: string | null; reason: string | null } {
  if (!chess.isGameOver()) return { over: false, result: null, reason: null };
  let reason = "unknown";
  if (chess.isCheckmate()) reason = "checkmate";
  else if (chess.isStalemate()) reason = "stalemate";
  else if (chess.isInsufficientMaterial()) reason = "insufficient_material";
  else if (chess.isThreefoldRepetition()) reason = "threefold_repetition";
  else if (chess.isDrawByFiftyMoves()) reason = "fifty_move_rule";
  else reason = "draw";

  let result: string | null;
  if (reason === "checkmate") result = chess.turn() === "w" ? "0-1" : "1-0";
  else result = "1/2-1/2";
  return { over: true, result, reason };
}

/** 构造前端需要的快照。 */
export function buildSnapshot(
  chess: Chess,
  options: {
    gameId: string;
    userColor: PlayerColor;
    drawOffer?: { by: PlayerColor } | null;
    extraReason?: string | null;
    extraResult?: string | null;
  },
): GameSnapshot {
  const outcome = gameOutcome(chess);
  const history = chess.history({ verbose: true });
  const last = history.length > 0 ? history[history.length - 1] : undefined;

  let pgn = "";
  try {
    chess.setHeader("Event", "AI 陪练对局");
    chess.setHeader("Site", "harness-dev/chess");
    chess.setHeader("Date", new Date().toISOString().slice(0, 10).replace(/-/g, "."));
    pgn = chess.pgn();
  } catch {
    pgn = history.map((m) => m.san).join(" ");
  }

  return {
    gameId: options.gameId,
    fen: chess.fen(),
    turn: chess.turn(),
    userColor: options.userColor,
    lastMove: last ? { from: last.from, to: last.to } : null,
    check: chess.isCheck(),
    gameOver: outcome.over || Boolean(options.extraResult),
    result: options.extraResult ?? outcome.result,
    reason: options.extraReason ?? outcome.reason,
    moveNumber: chess.moveNumber(),
    sanHistory: history.map((m) => m.san),
    pgn,
    drawOffer: options.drawOffer ?? null,
  };
}

/** 给模型看的一句话局面描述。 */
export function describePosition(chess: Chess): string {
  const side = chess.turn() === "w" ? "白方" : "黑方";
  const parts = [`轮到${side}走棋`, describeMaterial(chess)];
  if (chess.isCheck()) parts.push("当前一方被将军（必须应将）");
  return parts.join("，");
}
