/**
 * 配置表 —— 一切数值/文案配置由 JSON 驱动，改表不改码。
 */
import ui from '../config/ui.json';
import ai from '../config/ai.json';
import items from '../config/items.json';
import monsters from '../config/monsters.json';
import drops from '../config/drops.json';
import skills from '../config/skills.json';
import terrain from '../config/terrain.json';
import biomes from '../config/biomes.json';
import factions from '../config/factions.json';
import spawns from '../config/spawns.json';
import eventsTemplates from '../config/events-templates.json';
import npcs from '../config/npcs.json';
import realms from '../config/realms.json';
import sects from '../config/sects.json';
import quests from '../config/quests.json';
import crafting from '../config/crafting.json';
import affixes from '../config/affixes.json';
import achievements from '../config/achievements.json';
import travelEvents from '../config/travel-events.json';
import combat from '../config/combat.json';
import trials from '../config/trials.json';

export const config = {
  ui,
  ai,
  items,
  monsters,
  drops,
  skills,
  terrain,
  biomes,
  factions,
  spawns,
  eventsTemplates,
  npcs,
  realms,
  sects,
  quests,
  crafting,
  affixes,
  achievements,
  travelEvents,
  combat,
  trials,
} as const;
