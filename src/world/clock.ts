/**
 * 世界时钟：现实时间 → 世界日。世界日是天道 AI 导演的节拍。
 */
import { config } from '../core/config';

export class WorldClock {
  private accumulatedMs = 0;
  day = 1;

  private get dayLengthMs(): number {
    return config.ui.dayLengthMinutes * 60 * 1000;
  }

  /** 推进时钟；跨过日边界时返回 true。 */
  tick(dtMs: number): boolean {
    this.accumulatedMs += dtMs;
    if (this.accumulatedMs >= this.dayLengthMs) {
      this.accumulatedMs -= this.dayLengthMs;
      this.day += 1;
      return true;
    }
    return false;
  }
}
