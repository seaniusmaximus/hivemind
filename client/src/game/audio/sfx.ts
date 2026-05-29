import type { GameCommand } from '@hivemind/shared';
import { sfxr } from 'jsfxr';

type SfxPreset =
  | 'pickupCoin'
  | 'laserShoot'
  | 'explosion'
  | 'powerUp'
  | 'hitHurt'
  | 'jump'
  | 'blipSelect'
  | 'synth'
  | 'tone'
  | 'click'
  | 'random';

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) audioCtx = new AC();
  return audioCtx;
}

/** Resume after browser autoplay suspension (call from first user gesture). */
export async function resumeSfxContext(): Promise<void> {
  const ctx = getAudioContext();
  if (ctx?.state === 'suspended') await ctx.resume();
}

function playPreset(preset: SfxPreset, gainLinear: number, master = 0.85): void {
  void (async () => {
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      await resumeSfxContext();
      const params = sfxr.generate(preset, { sound_vol: 0.22 });
      const src = sfxr.toWebAudio(params, ctx);
      if (!src) return;
      const gain = ctx.createGain();
      gain.gain.value = Math.min(1, Math.max(0, gainLinear * master));
      src.connect(gain);
      gain.connect(ctx.destination);
      src.start(0);
    } catch {
      // WebAudio can fail in headless / tight environments — ignore.
    }
  })();
}

/** Successful local engine command — distinct presets per action. */
export function playCommandSfx(cmd: GameCommand): void {
  switch (cmd.kind) {
    case 'dispatchWorker':
      playPreset('laserShoot', 0.32);
      break;
    case 'dispatchCarpenter':
      playPreset('jump', 0.28);
      break;
    case 'dispatchQueen':
      playPreset('explosion', 0.38);
      break;
    case 'submitWords':
      playPreset('powerUp', 0.34);
      break;
    default:
      break;
  }
}

/** Defender-only: one-shot explosion when a rival queen is inbound. */
export function playIncomingQueenWarning(_durationMs?: number): void {
  playPreset('explosion', 0.42);
}

export function playLobbyUi(): void {
  playPreset('blipSelect', 0.35);
}

export function playGameOver(outcome: 'win' | 'lose' | 'draw'): void {
  if (outcome === 'win') playPreset('powerUp', 0.36);
  else if (outcome === 'lose') playPreset('hitHurt', 0.32);
  else playPreset('blipSelect', 0.28);
}
