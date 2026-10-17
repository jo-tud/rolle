/** Short beeps and a vibration, so a scan can be confirmed without looking at the screen. */

let audio: AudioContext | null = null;

export type Signal = 'add' | 'remove' | 'new' | 'error';

const TONES: Record<Signal, [number, number][]> = {
  add: [[880, 0.08]],
  remove: [[660, 0.07], [440, 0.09]],
  new: [[880, 0.07], [1320, 0.1]],
  error: [[220, 0.25]],
};

export function signal(kind: Signal, sound: boolean): void {
  navigator.vibrate?.(kind === 'error' ? [80, 60, 80] : 40);
  if (!sound) return;
  try {
    const Ctx = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audio ??= new Ctx();
    if (audio.state === 'suspended') void audio.resume();
    let t = audio.currentTime + 0.01;
    for (const [freq, dur] of TONES[kind]) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = kind === 'error' ? 'square' : 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain).connect(audio.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
      t += dur + 0.03;
    }
  } catch {
    // No sound then; the screen still shows the result.
  }
}
