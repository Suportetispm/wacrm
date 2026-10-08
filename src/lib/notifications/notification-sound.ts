/**
 * Notification beep synthesised with WebAudio — no audio asset to ship
 * and no `media-src` change to the CSP.
 *
 * Autoplay: browsers keep an AudioContext suspended until the page gets
 * a user gesture. The context is therefore only created/resumed from a
 * gesture (`unlockNotificationSound`, wired to the first pointer/key
 * interaction and to the settings toggle). If the tab that ends up
 * showing a notification never had a gesture, `playNotificationSound`
 * returns false and the caller lets the OS play its own notification
 * sound instead (Notification `silent: false`).
 */

type AudioContextCtor = typeof AudioContext;

let context: AudioContext | null = null;

function getCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Call from inside a user-gesture handler. Safe to call repeatedly. */
export function unlockNotificationSound(): void {
  try {
    if (!context) {
      const Ctor = getCtor();
      if (!Ctor) return;
      context = new Ctor();
    }
    if (context.state === "suspended") void context.resume().catch(() => {});
  } catch {
    // Audio unavailable — sound simply stays off.
  }
}

/**
 * Installs one-shot gesture listeners that unlock audio on the first
 * interaction with the page. Returns a cleanup.
 */
export function installNotificationSoundUnlock(): () => void {
  if (typeof window === "undefined") return () => {};
  const events = ["pointerdown", "keydown"] as const;
  const handler = () => {
    unlockNotificationSound();
    if (context?.state === "running") cleanup();
  };
  function cleanup() {
    for (const e of events) window.removeEventListener(e, handler, true);
  }
  for (const e of events) window.addEventListener(e, handler, { capture: true, passive: true });
  return cleanup;
}

/** Two short soft tones. Returns false when audio is not unlocked. */
export function playNotificationSound(): boolean {
  if (!context || context.state !== "running") return false;
  try {
    const now = context.currentTime;
    const tones: [number, number][] = [
      [880, 0],
      [1320, 0.13],
    ];
    for (const [freq, offset] of tones) {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.12, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.12);
      osc.connect(gain);
      gain.connect(context.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.13);
    }
    return true;
  } catch {
    return false;
  }
}
