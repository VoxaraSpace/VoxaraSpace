/**
 * Voice & Video settings: which microphone, headset/speakers and camera to
 * use, a live microphone meter with a test, and input/output levels. Device
 * changes apply to a call in progress.
 */
import { el, clear } from '../utils.js';
import { store } from '../state.js';
import { setPref } from '../actions.js';
import { section, toggleRow } from './settingsshell.js';
import { toastError } from './toast.js';
import { micConstraints, applyDeviceChange, applyOutputDevice, applyInputVolume, applyOutputVolume } from './call.js';

const KINDS = [
  { kind: 'audioinput', pref: 'micDevice', label: 'Microphone', hint: 'What other people hear.', fallback: 'Default microphone' },
  { kind: 'audiooutput', pref: 'speakerDevice', label: 'Output', hint: 'Headset or speakers that play other people. Applies to calls only; app sounds use the system default.', fallback: 'Default output' },
  { kind: 'videoinput', pref: 'cameraDevice', label: 'Camera', hint: 'For video calls.', fallback: 'Default camera' },
];

function supportsSink() { return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype; }

/** The device selects. Labels are blank until the mic has been allowed once, so a Refresh asks. */
function deviceSection() {
  const selects = new Map();
  const rows = KINDS.map((k) => {
    const sel = el('select', { class: 'field__input voice__select', 'aria-label': k.label });
    selects.set(k.kind, sel);
    sel.addEventListener('change', async () => {
      setPref(k.pref, sel.value);
      try {
        if (k.kind === 'audioinput') await applyDeviceChange('audio');
        else if (k.kind === 'videoinput') await applyDeviceChange('video');
        else await applyOutputDevice();
      } catch (err) { toastError(err.message || 'Could not switch device.'); }
    });
    return el('div', { class: 'setting-row voice__row' },
      el('div', { class: 'setting-row__text' }, el('div', { class: 'setting-row__label' }, k.label), el('div', { class: 'field__hint' }, k.hint)),
      sel);
  });

  async function fill() {
    let list = [];
    try { list = await navigator.mediaDevices.enumerateDevices(); } catch { list = []; }
    for (const k of KINDS) {
      const sel = selects.get(k.kind);
      const current = String(store.ui[k.pref] || '');
      clear(sel);
      sel.appendChild(el('option', { value: '' }, k.fallback));
      const devices = list.filter((d) => d.kind === k.kind && d.deviceId && d.deviceId !== 'default');
      for (const d of devices) sel.appendChild(el('option', { value: d.deviceId }, d.label || `${k.label} ${sel.children.length}`));
      if (current && !devices.some((d) => d.deviceId === current)) sel.appendChild(el('option', { value: current }, 'Saved device (not connected)'));
      sel.value = current;
      if (k.kind === 'audiooutput' && !supportsSink()) { sel.disabled = true; sel.title = 'Choosing an output device is not supported here.'; }
    }
    return list.some((d) => d.label);
  }

  const refresh = el('button', { class: 'btn btn--sm', type: 'button' }, 'Refresh devices');
  const note = el('p', { class: 'field__hint' });
  refresh.addEventListener('click', async () => {
    // Names only appear once the microphone has been allowed; ask for it briefly.
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); for (const t of s.getTracks()) t.stop(); } catch { /* denied: names stay generic */ }
    const named = await fill();
    note.textContent = named ? '' : 'Allow the microphone when asked so devices show their names.';
  });
  void fill().then((named) => { note.textContent = named ? '' : 'Device names appear after you allow the microphone once. Click Refresh devices.'; });
  const onChange = () => void fill();
  navigator.mediaDevices?.addEventListener?.('devicechange', onChange);

  return section('Devices', ...rows, el('div', { class: 'settings__actions' }, refresh), note);
}

/** A live level meter with a test button: start listening to the chosen mic and show its level. */
function meterSection() {
  const bar = el('div', { class: 'micmeter' }, el('span', { class: 'micmeter__fill' }));
  const fill = bar.firstChild;
  const status = el('p', { class: 'field__hint' }, 'Click Test microphone and speak. The bar should move with your voice.');
  const btn = el('button', { class: 'btn btn--sm', type: 'button' }, 'Test microphone');
  let stream = null, ctx = null, raf = 0;
  const stop = () => {
    cancelAnimationFrame(raf); raf = 0;
    if (stream) for (const t of stream.getTracks()) t.stop();
    stream = null;
    if (ctx) ctx.close().catch(() => {}); ctx = null;
    fill.style.width = '0%'; btn.textContent = 'Test microphone';
  };
  btn.addEventListener('click', async () => {
    if (stream) { stop(); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(), video: false });
      ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain(); gain.gain.value = Number(store.ui.inputVolume ?? 100) / 100;
      const analyser = ctx.createAnalyser(); analyser.fftSize = 512;
      src.connect(gain); gain.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      let peak = 0;
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0; for (const v of data) { const d = (v - 128) / 128; sum += d * d; }
        const rms = Math.sqrt(sum / data.length);
        const level = Math.min(100, Math.round(rms * 300));
        peak = Math.max(peak * 0.92, level);
        fill.style.width = `${peak}%`;
        fill.classList.toggle('is-hot', peak > 85);
        raf = requestAnimationFrame(tick);
      };
      tick();
      btn.textContent = 'Stop test';
      status.textContent = `Listening to ${stream.getAudioTracks()[0]?.label || 'the microphone'}. Speak normally; aim for the bar to reach the middle.`;
    } catch (err) { stop(); status.textContent = err.name === 'NotAllowedError' ? 'Microphone access was refused. Allow it in your system settings and try again.' : (err.message || 'Could not open the microphone.'); }
  });
  // Stop when the pane goes away.
  const observer = new MutationObserver(() => { if (!document.body.contains(bar)) { stop(); observer.disconnect(); } });
  observer.observe(document.body, { childList: true, subtree: true });
  return section('Test', bar, el('div', { class: 'settings__actions' }, btn), status);
}

function levelRow(pref, label, hint, onApply) {
  const value = Number(store.ui[pref] ?? 100);
  const out = el('span', { class: 'menu-slider__value' }, `${value}%`);
  const slider = el('input', { class: 'menu-slider__input', type: 'range', min: '0', max: '200', step: '5', value: String(value), 'aria-label': label });
  slider.addEventListener('input', () => { out.textContent = `${slider.value}%`; });
  slider.addEventListener('change', () => { setPref(pref, Number(slider.value)); onApply(); });
  return el('div', { class: 'setting-row' },
    el('div', { class: 'setting-row__text' }, el('div', { class: 'setting-row__label' }, label), el('div', { class: 'field__hint' }, hint)),
    el('div', { class: 'menu-slider' }, slider, out));
}

export function voiceDevicesPane(pane, extras = []) {
  pane.append(
    deviceSection(),
    meterSection(),
    section('Levels',
      levelRow('inputVolume', 'Microphone level', 'Below 100% quietens you, above boosts. 100% sends the microphone as captured.', applyInputVolume),
      levelRow('outputVolume', 'Everyone else', 'How loud other people are in calls. Per-person volume from the member list stacks on top.', applyOutputVolume)),
    ...extras);
}
