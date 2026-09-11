// Themes: a base mode (dark/light) plus a set of colour-token overrides applied
// as inline custom properties on the document root. Built-in presets live here;
// community themes come from the server. Every value that ends up in CSS is a
// plain colour — the server validates that, and so do we — so a theme can never
// smuggle a `url()` (which would leak a viewer's IP) or any other CSS.
import { store } from './state.js';
import { mediaUrl } from './client.js';

// The tokens a theme may set — must mirror THEME_TOKENS on the server.
export const THEME_TOKENS = [
  '--accent', '--accent-hover', '--accent-press', '--accent-strong', '--accent-strong-hover',
  '--accent-soft', '--accent-ring',
  '--bg-app', '--bg-sidebar', '--bg-surface', '--bg-raised', '--bg-input',
  '--text', '--text-secondary', '--text-muted', '--text-faint',
  '--online', '--idle', '--dnd', '--danger', '--mention', '--success',
];

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC = /^(rgb|rgba|hsl|hsla)\(\s*[0-9.,%/\s]+\)$/i;
export const isColor = (v) => typeof v === 'string' && v.length <= 40 && (HEX.test(v) || FUNC.test(v.trim()));

// ------------------------------------------------------------ colour maths

function hexToRgb(hex) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((c) => clamp(c).toString(16).padStart(2, '0')).join('')}`;
}
/** Blend a toward b by t (0..1). */
export function mix(a, b, t) {
  const x = hexToRgb(a); const y = hexToRgb(b);
  return rgbToHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}
export function alpha(hex, a) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
/** Perceived luminance 0..1 — used to pick the base mode from a background. */
export function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * Turn a handful of chosen colours into a full, cohesive token set — deriving
 * the accent states, the raised ground, and the muted text tiers so a submitter
 * only has to pick the essentials.
 */
export function deriveTokens({ accent, bgApp, bgSidebar, bgSurface, bgInput, text }) {
  const light = luminance(bgApp) > 0.5;
  const toward = light ? '#000000' : '#ffffff';
  return {
    base: light ? 'light' : 'dark',
    tokens: {
      '--accent': accent,
      '--accent-hover': mix(accent, '#ffffff', 0.18),
      '--accent-press': mix(accent, '#000000', 0.15),
      '--accent-strong': accent,
      '--accent-strong-hover': mix(accent, '#ffffff', 0.10),
      '--accent-soft': alpha(accent, 0.13),
      '--accent-ring': alpha(accent, 0.5),
      '--bg-app': bgApp,
      '--bg-sidebar': bgSidebar,
      '--bg-surface': bgSurface,
      '--bg-raised': mix(bgSurface, toward, 0.06),
      '--bg-input': bgInput,
      '--text': text,
      '--text-secondary': mix(text, bgApp, 0.22),
      '--text-muted': mix(text, bgApp, 0.40),
      '--text-faint': mix(text, bgApp, 0.52),
    },
  };
}

// --------------------------------------------------------------- presets

// Built-in themes. 'midnight'/'paper' reproduce the original dark/light so the
// old two-way choice still exists inside the gallery.
export const BUILTIN_THEMES = [
  { id: 'midnight', name: 'Midnight', builtin: true, base: 'dark', tokens: {} },
  { id: 'paper', name: 'Paper', builtin: true, base: 'light', tokens: {} },
  makePreset('ember', 'Ember', { accent: '#f2653c', bgApp: '#14100e', bgSidebar: '#191310', bgSurface: '#1b1512', bgInput: '#221a15', text: '#fbf3ee' }),
  makePreset('forest', 'Forest', { accent: '#37b26b', bgApp: '#0c110d', bgSidebar: '#101711', bgSurface: '#121a14', bgInput: '#17211a', text: '#eef6f0' }),
  makePreset('ocean', 'Ocean', { accent: '#2f9bd6', bgApp: '#0a1016', bgSidebar: '#0d151d', bgSurface: '#0f1822', bgInput: '#132234', text: '#eef4fa' }),
  makePreset('grape', 'Grape', { accent: '#9b6bf0', bgApp: '#110e16', bgSidebar: '#16121f', bgSurface: '#191423', bgInput: '#211a2e', text: '#f4f0fb' }),
  makePreset('mono', 'Mono', { accent: '#8a8a92', bgApp: '#0e0e0f', bgSidebar: '#141416', bgSurface: '#161617', bgInput: '#1c1c1e', text: '#f2f2f4' }),
  makePreset('sand', 'Sand', { accent: '#b4762a', bgApp: '#fbf7ef', bgSidebar: '#f5efe2', bgSurface: '#fffdf8', bgInput: '#f0e9da', text: '#241d12' }),
];

function makePreset(id, name, palette) {
  const { base, tokens } = deriveTokens(palette);
  return { id, name, builtin: true, base, tokens };
}

// ------------------------------------------------------------- registry

const registry = new Map();
for (const t of BUILTIN_THEMES) registry.set(t.id, t);

/** Merge the server's community themes into the registry (built-ins win by id). */
export function registerThemes(list) {
  for (const t of list || []) {
    if (registry.has(t.id) && registry.get(t.id).builtin) continue;
    registry.set(t.id, t);
  }
}
export function allThemes() {
  return [...registry.values()];
}
export function getTheme(id) {
  return registry.get(id) || registry.get('midnight');
}

// --------------------------------------------------------------- apply

let appliedKeys = [];
/** Apply a theme by id: set its base mode and its token overrides, clearing any left by the previous theme. */
export function applyTheme(id) {
  const theme = getTheme(id);
  const root = document.documentElement;
  root.dataset.theme = theme.base;
  for (const key of appliedKeys) root.style.removeProperty(key);
  appliedKeys = [];
  for (const [key, value] of Object.entries(theme.tokens || {})) {
    if (!THEME_TOKENS.includes(key) || !isColor(value)) continue; // defence in depth
    root.style.setProperty(key, value);
    appliedKeys.push(key);
  }
  applyBackground(theme.bg);
}

/**
 * The optional wallpaper layer. The image is always one WE host (a `/media/…`
 * path the server stored), fetched with the viewer's session token — never an
 * external URL — so a theme can't turn into an IP beacon.
 */
function applyBackground(bg) {
  let layer = document.getElementById('themeBg');
  const path = bg?.image;
  // Only ever our own /media path; anything else is ignored.
  if (!path || !/^\/media\/[A-Za-z0-9._-]+$/.test(path)) {
    if (layer) layer.remove();
    document.body.classList.remove('has-theme-bg');
    return;
  }
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'themeBg';
    document.body.prepend(layer);
  }
  layer.style.backgroundImage = `url("${mediaUrl(path)}")`;
  document.documentElement.style.setProperty('--theme-overlay', String(bg.overlay ?? 0.5));
  document.body.classList.add('has-theme-bg');
}

/** The id the user has chosen, defaulting sensibly from the legacy theme pref. */
export function currentThemeId() {
  return store.ui.themeId || (store.ui.theme === 'light' ? 'paper' : 'midnight');
}
