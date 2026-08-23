/**
 * 世界种子卡：开局由 AI 为种子世界命名并书写开篇（解读模式）。
 * 失败时静默降级（保留默认名与开篇，不影响游戏）。
 */
import { AiError, chat, extractJson } from './client';

export interface SeedCard {
  name: string;
  backstory: string;
}

export async function generateSeedCard(apiKey: string, seed: number): Promise<SeedCard> {
  const raw = await chat(
    apiKey,
    [
      {
        role: 'system',
        content:
          '你是天道，负责为新开辟的修真世界命名并书写开篇。输出严格 JSON：{"name":"2~5字世界名","backstory":"40字内的开篇史"}',
      },
      {
        role: 'user',
        content: `世界种子：${seed}。这是一片灰度几何风格的修真大陆，有霜落城、青云剑宗与血煞魔教。请为此界命名并写下编年史第一章。`,
      },
    ],
    { json: true, maxTokens: 300, temperature: 0.9 },
  );
  const data = extractJson(raw) as { name?: unknown; backstory?: unknown };
  const name = typeof data.name === 'string' ? data.name.trim().slice(0, 6) : '';
  const backstory = typeof data.backstory === 'string' ? data.backstory.trim().slice(0, 80) : '';
  if (!name && !backstory) throw new AiError('种子卡为空');
  return { name, backstory };
}
