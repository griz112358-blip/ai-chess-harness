/**
 * apps/chess/server/prompt.ts —— 提示词构建（适配器的"规则说明"部分）
 *
 * 一条完整的提示词 = 三块拼装：
 *   1. 角色与铁律（做什么、不能做什么、用什么工具表达）
 *   2. 本地知识库（按局面检索出来的棋理）
 *   3. 当前局面（棋盘、合法走法、对手刚走的棋、用户的话）
 *
 * 第 3 块每次回合都重新生成，所以模型看到的永远是权威局面；
 * 第 2 块按阶段切换，避免把整本棋书塞进上下文。
 */

import type { CoachLevel } from "../shared/protocol.js";
import { asciiBoard, describePosition, gamePhase, legalSanMoves } from "../shared/board.js";
import type { GameSession } from "./gameStore.js";

/** 陪练人格。 */
export interface CoachProfile {
  name: string;
  /** 棋力描述，模型据此调整选着野心。 */
  skill: string;
  /** 说话风格。 */
  style: string;
  /** 行为习惯。 */
  habits: string;
}

/** 四档陪练人格。 */
export const COACH_PROFILES: Record<CoachLevel, CoachProfile> = {
  beginner: {
    name: "小雨",
    skill: "业余新手，棋力大约 1200 分，会犯错但态度友好",
    style: "像耐心的朋友：用短句、少用术语，一回合只讲一个点，先肯定再建议，不要吓唬人。",
    habits: "对手走出明显坏棋时可以温和点出来；不要连续追问，一回合最多问一个问题。",
  },
  amateur: {
    name: "阿岚",
    skill: "业余棋手，棋力大约 1600 分，走法稳健，喜欢讲思路",
    style: "自然随和，会讲一点思路但不啰嗦，句子之间用'因为…所以…'把理由带出来。",
    habits: "发现自己优势时主动点出来；发现劣势时给一个具体的改善方向。",
  },
  club: {
    name: "老陈",
    skill: "俱乐部棋手，棋力大约 2000 分，善于抓漏洞",
    style: "简洁、直接、有压迫感，专挑对手薄弱的地方讲，不要客套。",
    habits: "对手犯错时立刻点出并说明为什么；对手走得好时也承认，但马上给下一手的压力。",
  },
  master: {
    name: "K",
    skill: "大师级棋手，棋力大约 2400 分，几乎不漏算",
    style: "话极少，常常沉默。只在关键节点说一句，冷峻精准，不解释废话。",
    habits: "默认不说话；只在战术成立、对手明显失误或局面转折时说一句。",
  },
};

/** 构建 system prompt。 */
export function buildSystemPrompt(
  session: GameSession,
  knowledge: string,
  options: { requireMove?: boolean } = {},
): string {
  const profile = COACH_PROFILES[session.level];
  const aiSide = session.aiColor === "w" ? "白方" : "黑方";
  const requireMove = options.requireMove !== false;
  const turnRule = requireMove
    ? "- 现在轮到你走棋：你必须调用 make_move 走一步。"
    : "- 现在轮到用户走棋：你只需要回应用户（用 say），不要走子、也不要调用 make_move。";
  const coachingLine = session.coaching
    ? "- 回应用户提问时，除了鼓励也给出**具体**的棋理（引用知识库里的原则），不要只说'挺好的'。"
    : "- 只做必要的回应，不要长篇教学。";

  return [
    `你是「${profile.name}」，正在和一位棋友下国际象棋。你执${aiSide}。`,
    "",
    "## 你的棋力与人格",
    profile.skill,
    profile.style,
    profile.habits,
    "",
    "## 铁律（违反会被系统直接拒绝）",
    "1. 你不能直接修改棋盘。棋盘由本地程序维护，你只能通过下面 4 个工具表达动作。",
    "2. 走法的 move 必须原样取自【当前局面】里的「合法走法」列表，不能自己编。",
    turnRule,
    "4. 一回合只能走一步棋。连走两步会被拒绝。",
    "5. 一次回复里可以同时调用多个工具（比如 say + make_move）；想让用户听到你的想法，就和走子放在同一次回复里。",
    "6. say 用来对用户说话（点评对手刚走的一步、解释你的意图、鼓励或提问），最多 2-3 句。",
    "7. 不要输出 JSON、不要写推理过程、不要说'我已经落子'——只有 make_move 返回成功才算落子。",
    "8. 只有真的走不动了才 resign；局面僵持、双方都不占便宜时可以 offer_draw。",
    "",
    "## 可用工具",
    "- make_move(move: string) —— 走一步棋，move 为合法 SAN 记谱",
    "- say(message: string) —— 对用户说一句话",
    "- resign() —— 认输",
    "- offer_draw() —— 提出和棋（由用户决定是否接受）",
    "",
    "## 工具返回值的含义",
    "make_move 成功后返回的是**系统真实计算**的新局面（fen / board / legalMoves / describe）。",
    "后续推理请以它为准，不要凭记忆推测棋盘。如果返回 ok:false，说明走法非法，" +
    "请读取 error 里的合法走法列表，重新选一个。",
    "",
    "## 本地知识库（按当前局面检索，可能不完整）",
    knowledge.trim() || "（本次没有检索到相关知识条目，按通用棋理走即可。）",
  ].join("\n");
}

/** 构建当前局面消息（每次回合重新生成，保证是权威状态）。 */
export function buildStateMessage(session: GameSession, userMessage?: string): string {
  const chess = session.chess;
  const phase = gamePhase(chess);
  const phaseName = phase === "opening" ? "开局" : phase === "middlegame" ? "中局" : "残局";
  const history = chess.history();
  const lastMove = history.length > 0 ? history[history.length - 1] : undefined;
  const side = chess.turn() === "w" ? "白方" : "黑方";
  const whoseTurn =
    chess.turn() === session.aiColor ? "（轮到你走）" : "（轮到用户走）";
  const legal = legalSanMoves(chess);

  const lines: string[] = [
    "【当前局面】",
    `阶段：${phaseName}；${describePosition(chess)}${whoseTurn}`,
    `FEN: ${chess.fen()}`,
    "",
    "棋盘（大写白棋，小写黑棋，. 是空格）：",
    asciiBoard(chess),
    "",
    lastMove
      ? `对手刚走的一步：${lastMove}（第 ${chess.moveNumber()} 手）`
      : `对手刚走的一步：这是开局第一步，第 ${chess.moveNumber()} 手`,
    "",
    `合法走法（SAN，只能从这些里选，共 ${legal.length} 个）：`,
    legal.join(" "),
  ];

  if (userMessage && userMessage.trim().length > 0) {
    lines.push("", "【用户对你说的话】", userMessage.trim());
  }
  return lines.join("\n");
}
