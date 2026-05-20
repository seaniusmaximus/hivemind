/**
 * Hook for the "hold to dispatch" gesture. The user must press-and-hold a
 * hex for {@link HOLD_DURATION_MS} milliseconds to trigger the action — a
 * deliberate, queue-free replacement for the previous tab-and-tap workflow.
 *
 * The hook returns:
 *   - `hold`: the currently held hex (or null) and a 0..1 progress value
 *     suitable for driving a progress border.
 *   - `rejection`: a transient marker set when an attempted hold was refused
 *     pre-flight (e.g. not enough honey). Carries a monotonically-increasing
 *     `token` so consumers can re-key visual flashes and replay the
 *     animation when the same hex is rejected twice in a row.
 *   - `start(h)`: begin (or restart) a hold on the given hex. Falls back to
 *     a rejection flash when the optional `canStart` predicate returns false.
 *   - `cancel(h?)`: abort the active hold. With no argument: always cancels.
 *     With a hex: only cancels if that hex matches the active hold (useful
 *     for `onPointerLeave` so leaving an unrelated hex doesn't kill the hold).
 *     The rejection flash is timer-driven and intentionally unaffected.
 *
 * Cancellation also wires global `pointerup`/`pointercancel` listeners so
 * lifting the pointer anywhere on the page reliably aborts mid-hold.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { hexEquals, WORKER_HOLD_MS, type Hex } from '@hivemind/shared';

export const HOLD_DURATION_MS = WORKER_HOLD_MS;

const holdSecondsValue = HOLD_DURATION_MS / 1000;
/** Copy for subtitles / hints — avoids showing "0s" when the hold is sub-second. */
export const HOLD_HINT_SECONDS = Number.isInteger(holdSecondsValue)
  ? String(holdSecondsValue)
  : holdSecondsValue.toFixed(1);

/** How long the red rejection flash plays for before clearing itself. */
export const REJECT_FLASH_MS = 600;

export interface HoldState {
  readonly hex: Hex | null;
  readonly progress: number;
}

export interface RejectionState {
  readonly hex: Hex;
  /** Bumps on every rejection so React re-renders the flash even when the
   *  same hex is rejected twice in a row. */
  readonly token: number;
}

export interface UseHoldToDispatchOptions {
  /** Pre-flight gate. If provided and returns false for a hex, `start` will
   *  emit a rejection instead of beginning the hold. */
  readonly canStart?: (h: Hex) => boolean;
  readonly durationMs?: number;
}

export interface UseHoldToDispatch {
  readonly hold: HoldState;
  readonly rejection: RejectionState | null;
  readonly start: (h: Hex) => void;
  readonly cancel: (h?: Hex) => void;
}

export const useHoldToDispatch = (
  onComplete: (h: Hex) => void,
  options: UseHoldToDispatchOptions = {},
): UseHoldToDispatch => {
  const [hold, setHold] = useState<HoldState>({ hex: null, progress: 0 });
  const [rejection, setRejection] = useState<RejectionState | null>(null);

  const activeHex = useRef<Hex | null>(null);
  const startedAt = useRef(0);
  const rafRef = useRef(0);
  const completed = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const canStartRef = useRef(options.canStart);
  canStartRef.current = options.canStart;

  const rejectTimerRef = useRef<number | null>(null);
  const rejectTokenRef = useRef(0);

  const durationMs = options.durationMs ?? HOLD_DURATION_MS;

  const reset = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    activeHex.current = null;
    completed.current = false;
    setHold({ hex: null, progress: 0 });
  }, []);

  const triggerRejection = useCallback((h: Hex) => {
    rejectTokenRef.current += 1;
    const token = rejectTokenRef.current;
    setRejection({ hex: h, token });
    if (rejectTimerRef.current !== null) {
      window.clearTimeout(rejectTimerRef.current);
    }
    rejectTimerRef.current = window.setTimeout(() => {
      // Don't clobber a fresher rejection that arrived during the timeout.
      setRejection((current) => (current && current.token === token ? null : current));
      rejectTimerRef.current = null;
    }, REJECT_FLASH_MS);
  }, []);

  const start = useCallback(
    (h: Hex) => {
      if (canStartRef.current && !canStartRef.current(h)) {
        triggerRejection(h);
        return;
      }
      if (activeHex.current && hexEquals(activeHex.current, h)) return;
      cancelAnimationFrame(rafRef.current);
      activeHex.current = h;
      completed.current = false;
      startedAt.current = performance.now();
      setHold({ hex: h, progress: 0 });
      const step = () => {
        const t = (performance.now() - startedAt.current) / durationMs;
        if (t >= 1 && !completed.current) {
          completed.current = true;
          const target = activeHex.current;
          reset();
          if (target) onCompleteRef.current(target);
          return;
        }
        setHold({ hex: h, progress: Math.min(1, Math.max(0, t)) });
        rafRef.current = requestAnimationFrame(step);
      };
      rafRef.current = requestAnimationFrame(step);
    },
    [durationMs, reset, triggerRejection],
  );

  const cancel = useCallback(
    (h?: Hex) => {
      if (h && activeHex.current && !hexEquals(activeHex.current, h)) return;
      reset();
    },
    [reset],
  );

  useEffect(() => {
    const onUp = () => reset();
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      cancelAnimationFrame(rafRef.current);
      if (rejectTimerRef.current !== null) {
        window.clearTimeout(rejectTimerRef.current);
      }
    };
  }, [reset]);

  return { hold, rejection, start, cancel };
};
