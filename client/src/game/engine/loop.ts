/**
 * Fixed-timestep tick loop, used by the local solo game (and by the client
 * for prediction in multiplayer). Engine logic itself lives in @hivemind/shared
 * so the server can run the authoritative version.
 */

export interface LoopOptions {
  hz: number;
  onTick: (dt: number, tick: number) => void;
}

export const startLoop = ({ hz, onTick }: LoopOptions): (() => void) => {
  const dt = 1 / hz;
  let tick = 0;
  let raf = 0;
  let last = performance.now();
  let acc = 0;

  const step = (now: number) => {
    acc += (now - last) / 1000;
    last = now;
    while (acc >= dt) {
      onTick(dt, tick++);
      acc -= dt;
    }
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
};
