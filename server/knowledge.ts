/**
 * apps/chess/server/knowledge.ts —— 本地知识库：加载 + 按局面检索
 *
 * 这是适配器里"本地业务信息 / 知识库"那一环：
 * 知识以 markdown 放在项目里，运行时按阶段和用户问题挑相关段落注入提示词，
 * 不是每次把整库塞给模型（既费 token 又稀释重点）。
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GamePhase } from "../shared/board.js";

/** 一个知识小节。 */
export interface KnowledgeSection {
  /** 来源文件名。 */
  source: string;
  /** 小节标题（不含标签）。 */
  title: string;
  /** 标签，来自标题里的方括号。 */
  tags: string[];
  /** 正文。 */
  body: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = join(here, "..", "knowledge");

/** 读取知识库目录下的所有 markdown，按 `##` 切成小节。 */
export function loadKnowledge(dir: string = KNOWLEDGE_DIR): KnowledgeSection[] {
  const sections: KnowledgeSection[] = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return sections;
  }
  for (const file of files) {
    const raw = readFileSync(join(dir, file), "utf8");
    // 去掉一级标题前言
    const body = raw.replace(/^#\s+.*$/m, "");
    const chunks = body.split(/^##\s+/m).slice(1);
    for (const chunk of chunks) {
      const lines = chunk.split("\n");
      const rawTitle = (lines[0] ?? "").trim();
      if (!rawTitle) continue;
      const tags = [...rawTitle.matchAll(/\[([^\]]+)\]/g)].map((m) => (m[1] ?? "").trim());
      const title = rawTitle.replace(/\[[^\]]*\]/g, "").trim();
      const text = lines.slice(1).join("\n").trim();
      sections.push({ source: file, title, tags, body: text });
    }
  }
  return sections;
}

/** 用户问题 → 关键词 → 想额外召回的标签。 */
const KEYWORD_TAGS: Array<{ keywords: string[]; tag: string }> = [
  { keywords: ["开局", "先手", "第一步", "怎么开", "出子"], tag: "开局" },
  { keywords: ["残局", "单车", "马兵", "王兵", "兵", "兑换", "兑子"], tag: "残局" },
  { keywords: ["战术", "杀", "将军", "陷阱", "攻击", "组合", "双将"], tag: "战术" },
  { keywords: ["思路", "为什么", "点评", "讲解", "建议", "复盘"], tag: "原则" },
];

/** 阶段 → 该阶段默认带上的标签。 */
const PHASE_TAGS: Record<GamePhase, string[]> = {
  opening: ["开局"],
  middlegame: ["原则", "战术"],
  endgame: ["残局"],
};

/**
 * selectKnowledge —— 按局面阶段 + 用户问题挑知识，拼成一段可注入的文本。
 *
 * 规则：
 * - 标了「核心」的小节每回合都带（这是稳定输出的底座）；
 * - 当前阶段对应标签的小节带上；
 * - 用户提问命中的标签额外带上；
 * - 总长度有上限，防止提示词无限膨胀。
 */
export function selectKnowledge(
  sections: KnowledgeSection[],
  options: { phase: GamePhase; userMessage?: string; maxChars?: number },
): string {
  const maxChars = options.maxChars ?? 2400;
  const message = (options.userMessage ?? "").toLowerCase();
  const phaseTags = PHASE_TAGS[options.phase] ?? [];
  const keywordTags = KEYWORD_TAGS.filter((k) =>
    k.keywords.some((word) => message.includes(word.toLowerCase())),
  ).map((k) => k.tag);

  const scored = sections
    .map((section) => {
      let score = 0;
      const reasons: string[] = [];
      if (section.tags.includes("核心")) {
        score += 100;
        reasons.push("核心");
      }
      if (section.tags.some((t) => phaseTags.includes(t))) {
        score += 50;
        reasons.push(options.phase);
      }
      for (const tag of keywordTags) {
        if (section.tags.includes(tag)) {
          score += 30;
          reasons.push(tag);
        }
      }
      return { section, score, reasons };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const picked: string[] = [];
  let used = 0;
  for (const { section } of scored) {
    const block = `## ${section.title}\n${section.body}`;
    if (used + block.length > maxChars) continue;
    picked.push(block);
    used += block.length;
    if (used >= maxChars) break;
  }
  return picked.join("\n\n");
}
