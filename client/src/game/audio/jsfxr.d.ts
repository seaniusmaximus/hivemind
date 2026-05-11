declare module 'jsfxr' {
  export const sfxr: {
    generate(
      algorithm:
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
        | 'random',
      options?: { sound_vol?: number; sample_rate?: number; sample_size?: number },
    ): Record<string, unknown>;
    toWebAudio(synthdef: Record<string, unknown>, audiocontext: AudioContext): AudioBufferSourceNode | undefined;
    play(synthdef: Record<string, unknown>): unknown;
  };
}
