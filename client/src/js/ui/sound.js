// Notification sound: a short, soft two-note chime made with WebAudio, so
// there is no audio file to ship or load. Throttled so a burst of messages
// is one sound, not a drum roll. Volume is fixed low; the point is to be
// heard from another tab or window, not to startle.
let ctx = null;
let lastAt = 0;

function context() {
  if (!ctx) {
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function tone(ac, freq, start, length, gain) {
  const osc = ac.createOscillator();
  const vol = ac.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, start);
  vol.gain.setValueAtTime(0.0001, start);
  vol.gain.exponentialRampToValueAtTime(gain, start + 0.012);
  vol.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(vol).connect(ac.destination);
  osc.start(start);
  osc.stop(start + length + 0.02);
}

/** Plays the chime, at most once every 1.5 seconds. */
export function playNotificationSound({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastAt < 1500) return false;
  lastAt = now;
  const ac = context();
  if (!ac) return false;
  const t = ac.currentTime + 0.01;
  tone(ac, 880, t, 0.16, 0.18);
  tone(ac, 1174.66, t + 0.11, 0.22, 0.16);
  // Lets tests and the settings preview know a sound was requested.
  try { document.dispatchEvent(new CustomEvent('voxara:sound')); } catch { /* not in a document */ }
  return true;
}
