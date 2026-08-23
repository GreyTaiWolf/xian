/**
 * NPC 对话：性格卡 + 上下文 → 按需调用（每次一回合，不常驻）。
 */
import { config } from '../core/config';
import { AiError, chat } from './client';

export async function talkToNpc(apiKey: string, npcId: string, context: string): Promise<string> {
  const npc = config.npcs.npcs.find((n) => n.id === npcId);
  if (!npc) throw new AiError('未知 NPC');
  const raw = await chat(
    apiKey,
    [
      {
        role: 'system',
        content: `${npc.persona}\n你的名字：${npc.name}，身份：${npc.title}。回答不超过三句话，不要输出 JSON。`,
      },
      { role: 'user', content: context },
    ],
    { maxTokens: 300, temperature: 0.85 },
  );
  return raw.trim().slice(0, 200);
}
