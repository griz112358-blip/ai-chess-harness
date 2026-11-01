/**
 * apps/chess/web/components/ChessBoard.tsx —— 棋盘
 *
 * 交互：点自己的子 → 高亮可走格子 → 点目标落子。
 * 升变时在目标格上弹四选一。
 * 被将军的王格会标红。
 */

import { useMemo, useState } from "react";
import type { PlayerColor } from "../../shared/protocol";
import { boardFromFen, checkedKingSquare, FILES, legalMoveList, pieceMap, RANKS } from "../lib/board";

interface ChessBoardProps {
  fen: string;
  orientation: PlayerColor;
  lastMove: { from: string; to: string } | null;
  /** 用户是否可以操作（轮到自己走且对局没结束）。 */
  interactive: boolean;
  busy: boolean;
  onMove: (from: string, to: string, promotion?: string) => void;
}

const PROMOTION_PIECES: Array<{ value: string; label: string }> = [
  { value: "q", label: "后" },
  { value: "r", label: "车" },
  { value: "b", label: "象" },
  { value: "n", label: "马" },
];

export function ChessBoard(props: ChessBoardProps) {
  const { fen, orientation, lastMove, interactive, busy, onMove } = props;
  const [selected, setSelected] = useState<string | null>(null);
  const [promotionAt, setPromotionAt] = useState<{ from: string; to: string } | null>(null);

  const chess = useMemo(() => boardFromFen(fen), [fen]);
  const pieces = useMemo(() => pieceMap(chess), [chess]);
  const legal = useMemo(() => legalMoveList(chess), [chess]);
  const checkSquare = useMemo(() => checkedKingSquare(chess), [chess]);

  // CSS grid 是行优先填充：外层循环走行（rank），内层循环走列（file）
  const files = orientation === "w" ? FILES : [...FILES].reverse();
  const ranks = RANKS;

  const targetsFrom = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const move of legal) {
      const set = map.get(move.from) ?? new Set<string>();
      set.add(move.to);
      map.set(move.from, set);
    }
    return map;
  }, [legal]);

  const promotionMoves = useMemo(
    () => legal.filter((m) => m.from === selected && m.promotion),
    [legal, selected],
  );

  const handleSquareClick = (square: string): void => {
    if (!interactive || busy) return;
    const piece = pieces[square];
    const userTurn = chess.turn() === orientation;

    if (selected) {
      const targets = targetsFrom.get(selected);
      if (targets?.has(square)) {
        const needsPromotion = promotionMoves.some((m) => m.to === square);
        if (needsPromotion) {
          setPromotionAt({ from: selected, to: square });
          setSelected(null);
          return;
        }
        onMove(selected, square);
        setSelected(null);
        return;
      }
    }

    if (piece && piece.color === orientation && userTurn) {
      setSelected(square);
      return;
    }
    setSelected(null);
  };

  const choosePromotion = (value: string): void => {
    if (!promotionAt) return;
    onMove(promotionAt.from, promotionAt.to, value);
    setPromotionAt(null);
  };

  return (
    <div className={`board-wrap ${orientation}`}>
      <div className="board">
        {ranks.map((rank) =>
          files.map((file) => {
            const square = `${file}${rank}`;
            const piece = pieces[square];
            const isLight = (FILES.indexOf(file) + RANKS.indexOf(rank as never)) % 2 === 1;
            const isSelected = selected === square;
            const isTarget = selected ? targetsFrom.get(selected)?.has(square) === true : false;
            const isLast =
              lastMove !== null && (lastMove.from === square || lastMove.to === square);
            const isCheck = checkSquare === square;
            return (
              <div
                key={square}
                className={[
                  "square",
                  isLight ? "light" : "dark",
                  isSelected ? "selected" : "",
                  isLast ? "last" : "",
                  isCheck ? "check" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => handleSquareClick(square)}
              >
                {piece ? (
                  <span className={`piece ${piece.color}`}>{piece.glyph}</span>
                ) : null}
                {isTarget ? <span className={`target ${piece ? "capture" : ""}`} /> : null}
                {promotionAt?.to === square ? (
                  <div className="promotion">
                    {PROMOTION_PIECES.map((p) => (
                      <button key={p.value} type="button" onClick={() => choosePromotion(p.value)}>
                        {p.label}
                      </button>
                    ))}
                  </div>
                ) : null}
                <span className="coord">
                  {rank === 1 ? file : ""}
                  {file === (orientation === "w" ? "h" : "a") ? rank : ""}
                </span>
              </div>
            );
          }),
        )}
      </div>
    </div>
  );
}
