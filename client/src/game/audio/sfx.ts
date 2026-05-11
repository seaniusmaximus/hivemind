import type { GameCommand } from '@hivemind/shared';
import { sfxr } from 'jsfxr';

/**
 * Hand-tuned jsfxr definition: square-ish drone with strong vibrato (internal FM).
 * Looped + outer tremolo in {@link playIncomingQueenWarning} reads as an alarm klaxon.
 */
const INCOMING_QUEEN_ALARM_DEF = {
  oldParams: true,
  wave_type: 0,
  p_env_attack: 0.002,
  p_env_sustain: 0.72,
  p_env_punch: 0,
  p_env_decay: 0.06,
  p_base_freq: 0.17,
  p_freq_limit: 0,
  p_freq_ramp: 0,
  p_freq_dramp: 0,
  p_vib_strength: 0.22,
  p_vib_speed: 0.45,
  p_arp_mod: 0,
  p_arp_speed: 0,
  p_duty: 0.42,
  p_duty_ramp: 0,
  p_repeat_speed: 0,
  p_pha_offset: 0,
  p_pha_ramp: 0,
  p_lpf_freq: 0.62,
  p_lpf_ramp: 0,
  p_lpf_resonance: 0.18,
  p_hpf_freq: 0.06,
  p_hpf_ramp: 0,
  sound_vol: 0.08,
  sample_size: 8,
} as const;

/** Hz — slow amplitude “alarm” pulse layered on the jsfxr loop. */
const INCOMING_QUEEN_TREMOLO_HZ = 4;

let incomingQueenAlarmRelease: (() => void) | null = null;

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

/**
 * Defender-only context: shrill droning jsfxr loop with tremolo for the incoming-queen window.
 * Call with the same duration as the toast so audio and UI line up.
 */
export function playIncomingQueenWarning(durationMs: number): void {
  void (async () => {
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      await resumeSfxContext();

      incomingQueenAlarmRelease?.();
      incomingQueenAlarmRelease = null;

      const durationSec = Math.max(0.4, durationMs / 1000);
      const sr = ctx.sampleRate;

      const params = {
        ...INCOMING_QUEEN_ALARM_DEF,
        sample_rate: sr,
        sound_vol: INCOMING_QUEEN_ALARM_DEF.sound_vol,
      };

      const src = sfxr.toWebAudio(params, ctx);
      if (!src) return;

      src.loop = true;

      const master = ctx.createGain();
      /** Overall loudness for the incoming-queen loop (jsfxr buffer is already quiet via `sound_vol`). */
      const peak = 0.09;
      const tremDepth = 0.028;
      const curveLen = Math.min(8192, Math.max(256, Math.ceil(sr * durationSec)));
      const curve = new Float32Array(curveLen);
      for (let i = 0; i < curveLen; i += 1) {
        const t = (i / (curveLen - 1)) * durationSec;
        const wobble = tremDepth * Math.sin(t * Math.PI * 2 * INCOMING_QUEEN_TREMOLO_HZ);
        curve[i] = Math.min(0.22, Math.max(0.045, peak + wobble));
      }
      const t0 = ctx.currentTime;
      master.gain.setValueCurveAtTime(curve, t0, durationSec);

      src.connect(master);
      master.connect(ctx.destination);
      src.start(t0);
      src.stop(t0 + durationSec);

      incomingQueenAlarmRelease = () => {
        try {
          src.stop(0);
          master.disconnect();
          src.disconnect();
        } catch {
          /* already stopped */
        }
        incomingQueenAlarmRelease = null;
      };

      window.setTimeout(() => {
        incomingQueenAlarmRelease?.();
      }, durationMs + 120);
    } catch {
      // WebAudio can fail in headless / tight environments — ignore.
    }
  })();
}

export function playLobbyUi(): void {
  playPreset('blipSelect', 0.35);
}

export function playGameOver(outcome: 'win' | 'lose' | 'draw'): void {
  if (outcome === 'win') playPreset('powerUp', 0.36);
  else if (outcome === 'lose') playPreset('hitHurt', 0.32);
  else playPreset('blipSelect', 0.28);
}
