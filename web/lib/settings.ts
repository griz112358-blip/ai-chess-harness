/**
 * apps/chess/web/lib/settings.ts —— 设置的本地存储
 *
 * API Key 默认只存在浏览器 localStorage（用户自己的机器），
 * 每次请求随 x-minimax-key 头发给本地后端，不落到服务器磁盘。
 */

import type { AppSettings } from "../../shared/protocol";

const STORAGE_KEY = "harness-chess-settings";

/** 默认设置。 */
export const DEFAULT_SETTINGS: AppSettings = {
  apiKey: "",
  baseUrl: "https://api.minimax.io/v1",
  model: "MiniMax-M3",
  level: "amateur",
  userColor: "w",
  coaching: true,
  disableThinking: true,
  temperature: 0.7,
};

/** 读取本地设置。 */
export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** 保存本地设置。 */
export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* 隐私模式下可能写不了，忽略 */
  }
}

/** 是否已经配置了 Key。 */
export function hasApiKey(settings: AppSettings): boolean {
  return settings.apiKey.trim().length > 0;
}
