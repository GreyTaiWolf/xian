/**
 * 音效：Web Audio 实时合成，零素材。
 * 首次用户手势时创建 AudioContext；音量跟随设置（sfxVolume，0 即静音）。
 */
export type SfxName =
  | 'hit'
  | 'crit'
  | 'hurt'
  | 'pickup'
  | 'lootRare'
  | 'levelUp'
  | 'break'
  | 'fail'
  | 'death'
  | 'skill'
  | 'realm'
  | 'boss'
  | 'achievement'
  | 'ui';

class Sfx {
  private ctx: AudioContext | null = null;
  private volume = 0.85;

  constructor() {
    // 首次手势时解锁 AudioContext（浏览器自动播放策略）
    const unlock = (): void => {
      const ctx = this.init();
      if (ctx && ctx.state === 'suspended') void ctx.resume();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v / 100));
  }

  play(name: SfxName): void {
    if (this.volume <= 0.001) return;
    const ctx = this.init();
    if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume();
    const T = (freq: number, dur: number, type: OscillatorType, vol: number, slideTo?: number, delay = 0): void => {
      const t0 = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(Math.max(30, freq), t0);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol * this.volume, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.06);
    };
    switch (name) {
      case 'hit': T(180, 0.08, 'square', 0.14); break;
      case 'crit': T(900, 0.12, 'square', 0.18); T(1400, 0.1, 'sine', 0.1, undefined, 0.02); break;
      case 'hurt': T(130, 0.16, 'sawtooth', 0.14, 85); break;
      case 'pickup': T(660, 0.07, 'sine', 0.12); T(880, 0.1, 'sine', 0.12, undefined, 0.06); break;
      case 'lootRare': T(523, 0.09, 'sine', 0.12); T(659, 0.09, 'sine', 0.12, undefined, 0.08); T(784, 0.14, 'sine', 0.13, undefined, 0.16); break;
      case 'levelUp': T(300, 0.28, 'sawtooth', 0.14, 900); break;
      case 'break': T(392, 0.5, 'sine', 0.13); T(523, 0.5, 'sine', 0.11, undefined, 0.05); T(659, 0.55, 'sine', 0.1, undefined, 0.1); break;
      case 'fail': T(220, 0.5, 'sawtooth', 0.12, 90); break;
      case 'death': T(170, 0.6, 'sawtooth', 0.12, 55); break;
      case 'skill': T(240, 0.22, 'sawtooth', 0.12, 640); break;
      case 'realm': T(120, 0.8, 'sine', 0.13, 55); break;
      case 'boss': T(98, 0.9, 'sine', 0.15); T(147, 0.9, 'sine', 0.1, undefined, 0.1); break;
      case 'achievement': T(784, 0.16, 'sine', 0.13); T(1175, 0.24, 'sine', 0.13, undefined, 0.12); break;
      case 'ui': T(440, 0.05, 'sine', 0.08); break;
    }
  }

  private init(): AudioContext | null {
    if (this.ctx) return this.ctx;
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      this.ctx = AC ? new AC() : null;
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }
}

export const sfx = new Sfx();
