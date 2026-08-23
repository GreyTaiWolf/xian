/**
 * AI 客户端：OpenAI 兼容接口（开发期经 Vite 代理 /api → DeepSeek）。
 * 超时 / 重试 / JSON 提取 —— 天道 AI 的所有调用都经由这里。
 */
import { config } from '../core/config';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** 要求模型输出 JSON（DeepSeek 支持 json_object 模式） */
  json?: boolean;
  timeoutMs?: number;
  retries?: number;
}

export class AiError extends Error {}

export async function chat(
  apiKey: string,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  if (!apiKey) throw new AiError('未填写 API Key');
  const timeoutMs = opts.timeoutMs ?? config.ai.timeoutMs;
  const retries = opts.retries ?? config.ai.maxRetries;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const body: Record<string, unknown> = {
        model: config.ai.model,
        messages,
        temperature: opts.temperature ?? config.ai.temperature,
        max_tokens: opts.maxTokens ?? 1024,
        stream: false,
      };
      if (opts.json) body.response_format = { type: 'json_object' };
      const res = await fetch('/api/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new AiError(`API HTTP ${res.status}`);
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content ?? '';
      if (!content.trim()) throw new AiError('API 返回空内容');
      return content;
    } catch (e) {
      lastErr = e;
      if (attempt >= retries) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new AiError(lastErr instanceof Error ? lastErr.message : '调用失败');
}

/** 从模型输出中提取 JSON（容错：剥离代码围栏、截取首个平衡对象）。 */
export function extractJson(text: string): unknown {
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = t.indexOf('{');
  if (start < 0) throw new AiError('输出中不含 JSON 对象');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(t.slice(start, i + 1));
    }
  }
  throw new AiError('JSON 对象不完整');
}
