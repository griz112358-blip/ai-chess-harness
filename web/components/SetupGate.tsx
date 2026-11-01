/**
 * apps/chess/web/components/SetupGate.tsx —— API Key 设置门
 *
 * 首次进入必须先配置 Key：这是"本地业务"和"大模型"之间唯一需要人工提供的凭据。
 * Key 存在浏览器本地，每次请求随请求头发给本地后端。
 */

import { useState } from "react";
import type { AppSettings, CoachLevel, PlayerColor } from "../../shared/protocol";
import { getJson } from "../lib/api";

interface SetupGateProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  onStart: () => void;
  /** 从设置面板打开时可以关闭。 */
  onClose?: () => void;
  /** 后端是否处于 mock 模式（无需 Key）。 */
  mockMode?: boolean;
}

const BASE_URLS = [
  { value: "https://api.minimax.io/v1", label: "国际站 api.minimax.io" },
  { value: "https://api.minimaxi.com/v1", label: "国内站 api.minimaxi.com" },
];

const LEVELS: Array<{ value: CoachLevel; label: string }> = [
  { value: "beginner", label: "新手陪练（约 1200）" },
  { value: "amateur", label: "业余陪练（约 1600）" },
  { value: "club", label: "俱乐部棋手（约 2000）" },
  { value: "master", label: "大师级（约 2400）" },
];

const MODEL_SUGGESTIONS = [
  "MiniMax-M3",
  "MiniMax-M2.7",
  "MiniMax-M2.7-highspeed",
  "MiniMax-M2.5",
  "MiniMax-M2.1",
  "MiniMax-M2",
];

export function SetupGate(props: SetupGateProps) {
  const { settings, onChange, onStart, onClose, mockMode } = props;
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [models, setModels] = useState<string[]>([]);

  const patch = (partial: Partial<AppSettings>): void => {
    onChange({ ...settings, ...partial });
  };

  const testConnection = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/key/test", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-minimax-key": settings.apiKey },
        body: JSON.stringify({ baseUrl: settings.baseUrl, model: settings.model }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        latencyMs?: number;
        error?: string;
        hint?: string;
        modelCount?: number;
      };
      if (json.ok) {
        setTestResult({
          ok: true,
          text: `连接成功${typeof json.latencyMs === "number" ? `（${json.latencyMs}ms）` : ""}${
            json.modelCount ? `，账号可见 ${json.modelCount} 个模型` : ""
          }`,
        });
      } else {
        setTestResult({ ok: false, text: json.hint ?? json.error ?? "连接失败" });
      }
    } catch (error) {
      setTestResult({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  };

  const loadModels = async (): Promise<void> => {
    try {
      const json = await getJson<{ models: string[] }>("/api/models", {
        "x-minimax-key": settings.apiKey,
      });
      setModels(json.models ?? []);
      if (json.models?.length) {
        setTestResult({ ok: true, text: `拉到 ${json.models.length} 个可用模型` });
      }
    } catch (error) {
      setTestResult({ ok: false, text: error instanceof Error ? error.message : String(error) });
    }
  };

  const ready = mockMode === true || settings.apiKey.trim().length > 0;

  return (
    <div className="setup-overlay">
      <div className="setup-card">
        <h1>AI 国际象棋陪练</h1>
        <p className="setup-sub">
          这是一个「大模型 + 本地业务」的适配器 Demo：模型只负责理解和决策，
          棋盘、规则、胜负判定全部由本地代码执行。先填一个 MiniMax 的 API Key。
        </p>

        <label className="field">
          <span>API Key</span>
          <div className="key-row">
            <input
              type={showKey ? "text" : "password"}
              value={settings.apiKey}
              placeholder="sk-... 或开放平台生成的 Key"
              onChange={(e) => patch({ apiKey: e.target.value.trim() })}
              autoComplete="off"
            />
            <button type="button" className="ghost" onClick={() => setShowKey(!showKey)}>
              {showKey ? "隐藏" : "显示"}
            </button>
          </div>
        </label>

        <div className="field-row">
          <label className="field">
            <span>接入区域</span>
            <select
              value={settings.baseUrl}
              onChange={(e) => patch({ baseUrl: e.target.value })}
            >
              {BASE_URLS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
              {!BASE_URLS.some((option) => option.value === settings.baseUrl) ? (
                <option value={settings.baseUrl}>{settings.baseUrl}</option>
              ) : null}
            </select>
          </label>

          <label className="field">
            <span>模型</span>
            <div className="key-row">
              <input
                value={settings.model}
                list="model-options"
                onChange={(e) => patch({ model: e.target.value.trim() })}
              />
              <datalist id="model-options">
                {MODEL_SUGGESTIONS.map((name) => (
                  <option key={name} value={name} />
                ))}
                {models.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <button type="button" className="ghost" onClick={loadModels} disabled={!settings.apiKey}>
                拉取
              </button>
            </div>
          </label>
        </div>

        <div className="field-row">
          <label className="field">
            <span>陪练水平</span>
            <select
              value={settings.level}
              onChange={(e) => patch({ level: e.target.value as CoachLevel })}
            >
              {LEVELS.map((level) => (
                <option key={level.value} value={level.value}>
                  {level.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>你执子</span>
            <select
              value={settings.userColor}
              onChange={(e) => patch({ userColor: e.target.value as PlayerColor })}
            >
              <option value="w">白方（先行）</option>
              <option value="b">黑方（后行）</option>
            </select>
          </label>
        </div>

        <div className="field-row">
          <label className="check">
            <input
              type="checkbox"
              checked={settings.coaching}
              onChange={(e) => patch({ coaching: e.target.checked })}
            />
            <span>输出教学点评</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.disableThinking}
              onChange={(e) => patch({ disableThinking: e.target.checked })}
            />
            <span>关闭模型思考（响应更快）</span>
          </label>
        </div>

        {testResult ? (
          <p className={`test-result ${testResult.ok ? "ok" : "fail"}`}>{testResult.text}</p>
        ) : null}

        <div className="setup-actions">
          <button type="button" className="ghost" onClick={testConnection} disabled={testing || !settings.apiKey}>
            {testing ? "测试中…" : "测试连接"}
          </button>
          <button type="button" className="primary" onClick={onStart} disabled={!ready}>
            {mockMode ? "进入（Mock 模式）" : "开始对局"}
          </button>
          {onClose ? (
            <button type="button" className="ghost" onClick={onClose}>
              关闭
            </button>
          ) : null}
        </div>

        {mockMode ? (
          <p className="mock-tip">
            后端当前是 <b>Mock 模式</b>：用假的模型走棋，用来验证整条链路，不需要 Key。
          </p>
        ) : null}
      </div>
    </div>
  );
}
