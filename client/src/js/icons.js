// Inline SVG icon set. Everything ships in-app — no icon font, no network.

const PATHS = {
  hash: '<path d="M9.5 3.5 8 20.5M16 3.5l-1.5 17M4 8.5h16M3 15.5h16" />',
  home: '<path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z" /><path d="M9.5 20.5v-6h5v6" />',
  plus: '<path d="M12 5v14M5 12h14" />',
  speaker: '<path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" /><path d="M15.5 9a4 4 0 0 1 0 6" /><path d="M18 6.5a7.5 7.5 0 0 1 0 11" />',
  expand: '<path d="M4 9V4h5" /><path d="M20 15v5h-5" /><path d="M4 4l6 6" /><path d="M20 20l-6-6" />',
  minus: '<path d="M5 12h14" />',
  close: '<path d="M6 6l12 12M18 6 6 18" />',
  search: '<circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" />',
  settings: '<circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />',
  users: '<path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20" /><circle cx="9" cy="7" r="3.5" /><path d="M22 20v-1.5a4 4 0 0 0-3-3.87" /><path d="M16.5 3.6a4 4 0 0 1 0 7.75" />',
  user: '<circle cx="12" cy="8" r="4" /><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />',
  send: '<path d="M4.5 12 20 4.5 15.5 20l-4-6.5z" /><path d="m11.5 13.5 8.5-9" />',
  smile: '<circle cx="12" cy="12" r="9" /><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" /><path d="M9 9.5h.01M15 9.5h.01" stroke-width="2.2" stroke-linecap="round" />',
  logout: '<path d="M15 17l5-5-5-5" /><path d="M20 12H9" /><path d="M12 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6" />',
  play: '<path d="M7 4v16l13-8z" />',
  compass: '<circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5z" />',
  gamepad: '<path d="M6 11h4M8 9v4M15 12h.01M18 10h.01" /><path d="M17.3 5H6.7a4 4 0 0 0-3.97 3.5L2 16.5A2.5 2.5 0 0 0 6.5 18l2-2.5h7l2 2.5a2.5 2.5 0 0 0 4.5-1.5l-.73-8A4 4 0 0 0 17.3 5z" />',
  globe: '<circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />',
  'chevron-down': '<path d="m6 9 6 6 6-6" />',
  'chevron-right': '<path d="m9 6 6 6-6 6" />',
  'arrow-down': '<path d="M12 5v14M6 13l6 6 6-6" />',
  'arrow-up': '<path d="M12 19V5M6 11l6-6 6 6" />',
  'arrow-left': '<path d="M19 12H5M11 6l-6 6 6 6" />',
  pencil: '<path d="M4 20h4L20 8l-4-4L4 16z" /><path d="m14.5 5.5 4 4" />',
  trash: '<path d="M4 7h16" /><path d="M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2" /><path d="M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7" />',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" />',
  check: '<path d="m5 13 4.5 4.5L19 7" />',
  reply: '<path d="M9 8 4 13l5 5" /><path d="M4 13h9.5a6 6 0 0 1 6 6v1" />',
  forward: '<path d="M15 8 20 13l-5 5" /><path d="M20 13h-9.5a6 6 0 0 0-6 6v1" />',
  dots: '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />',
  pin: '<path d="M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5Z" /><path d="M12 14v6" />',
  bell: '<path d="M18 9a6 6 0 1 0-12 0c0 6-2.5 7.5-2.5 7.5h17S18 15 18 9" /><path d="M13.7 20.5a2 2 0 0 1-3.4 0" />',
  help: '<circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.1-2.5 3.6" /><path d="M12 17.5h.01" stroke-width="2.2" stroke-linecap="round" />',
  at: '<circle cx="12" cy="12" r="4" /><path d="M16 8v5.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1" />',
  'dm': '<path d="M21 12a8 8 0 0 1-8 8H4l2-3.5A8 8 0 1 1 21 12z" />',
  'plus-circle': '<circle cx="12" cy="12" r="9" /><path d="M12 8.5v7M8.5 12h7" />',
  'log-in': '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" /><path d="m9 16 4-4-4-4" /><path d="M13 12H3" />',
  'exit': '<path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3" /><path d="m15 16 4-4-4-4" /><path d="M19 12H9" />',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z" />',
  sun: '<circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />',
  link: '<path d="M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 1 0-5.7-5.7L11.5 6.3" /><path d="M14 10.5a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 1 0 5.7 5.7l1.3-1.3" />',
  info: '<circle cx="12" cy="12" r="9" /><path d="M12 11v5.5" /><path d="M12 7.6h.01" stroke-width="2.2" stroke-linecap="round" />',
  alert: '<path d="M12 4 2.5 20.5h19z" /><path d="M12 10v4.5" /><path d="M12 18h.01" stroke-width="2.2" stroke-linecap="round" />',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />',
  shield: '<path d="M12 3l7 2.8v5.2c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V5.8z" />',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c.9 0 1.5-.8 1.5-1.7 0-.8-.6-1.3-.6-2.1 0-.6.5-1.2 1.2-1.2H16a5 5 0 0 0 5-5c0-4.3-4-8-9-8Z" /><circle cx="7.5" cy="11" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="8" r="1" fill="currentColor" stroke="none" /><circle cx="16" cy="11" r="1" fill="currentColor" stroke="none" />',
  chat: '<path d="M4.5 5.5h15v10h-11l-4 4z" /><path d="M8.5 9.5h7M8.5 12.5h4" />',
  keyboard: '<rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" stroke-width="2" stroke-linecap="round" />',
  tag: '<path d="M4 12.5V5.5A1.5 1.5 0 0 1 5.5 4h7l7.5 7.5-7 7z" /><circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none" />',
  flag: '<path d="M6 21V4.5M6 4.5h11l-2 4 2 4H6" />',
  sparkle: '<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.4L12 17l-1.9-5.6L4.5 10l5.6-1.4z" />',
  layers: '<path d="M12 3 3 8l9 5 9-5-9-5Z" /><path d="M3 13l9 5 9-5" /><path d="M3 16.5l9 5 9-5" />',
  steam: '<circle cx="12" cy="12" r="9" /><circle cx="15.3" cy="8.7" r="2.7" /><circle cx="8.6" cy="15.4" r="2" /><path d="m10.2 14 3.1-3.4" />',
  bookmark: '<path d="M6 4h12v16l-6-4.2L6 20z" />',
  clock: '<circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" />',
  ban: '<circle cx="12" cy="12" r="8.5" /><path d="M6.2 6.2l11.6 11.6" />',
  list: '<path d="M9 6h11M9 12h11M9 18h11" /><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" stroke-width="2.2" stroke-linecap="round" />',
  bot: '<rect x="4" y="8" width="16" height="11" rx="3" /><path d="M12 8V4M9 4h6" /><circle cx="9.5" cy="13" r="1.1" fill="currentColor" stroke="none" /><circle cx="14.5" cy="13" r="1.1" fill="currentColor" stroke="none" /><path d="M2 12v3M22 12v3" />',
  sliders: '<path d="M4 8h9M17 8h3M4 16h3M11 16h9" /><circle cx="15" cy="8" r="2" /><circle cx="9" cy="16" r="2" />',
  phone: '<path d="M6.5 4.5h3l1.5 4-2 1.5a11 11 0 0 0 5 5l1.5-2 4 1.5v3a1.5 1.5 0 0 1-1.6 1.5A15.5 15.5 0 0 1 5 6.1 1.5 1.5 0 0 1 6.5 4.5Z" />',
  'phone-off': '<path d="M6.5 4.5h3l1.5 4-2 1.5a11 11 0 0 0 3 3.6M14 16.2l1-1.3 4 1.5v3a1.5 1.5 0 0 1-1.6 1.5 15.4 15.4 0 0 1-7.9-3" /><path d="M3 3l18 18" />',
  video: '<rect x="3" y="6" width="12" height="12" rx="2" /><path d="M15 10.5 21 7v10l-6-3.5z" />',
  'video-off': '<path d="M15 10.5 21 7v10l-6-3.5V10.5z" /><path d="M11 6h2a2 2 0 0 1 2 2v2M15 15v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2" /><path d="M3 3l18 18" />',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0" /><path d="M12 17.5V21" />',
  'mic-off': '<path d="M9 9V6a3 3 0 0 1 5.9-.7M15 11v.5a3 3 0 0 1-4.2 2.7" /><path d="M5.5 11a6.5 6.5 0 0 0 10.2 5.3M18.5 11a6.5 6.5 0 0 1-.3 2" /><path d="M12 17.5V21" /><path d="M3 3l18 18" />',
  'screen-share': '<rect x="3" y="4.5" width="18" height="12" rx="2" /><path d="M8 20.5h8M12 16.5v4" /><path d="M12 8v5M9.5 10.5 12 8l2.5 2.5" />',
  grip: '<circle cx="9" cy="6" r="1.3" fill="currentColor" stroke="none" /><circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="9" cy="18" r="1.3" fill="currentColor" stroke="none" /><circle cx="15" cy="6" r="1.3" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="15" cy="18" r="1.3" fill="currentColor" stroke="none" />',
};

/**
 * @param {keyof PATHS} name
 * @returns {SVGElement}
 */
export function icon(name, { size } = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (size) {
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
  }
  svg.innerHTML = PATHS[name] || PATHS.info;
  return svg;
}

/** Replaces every `<span data-icon="name">` placeholder in the static HTML. */
export function hydrateIcons(root = document) {
  for (const node of root.querySelectorAll('[data-icon]')) {
    if (node.dataset.iconDone) continue;
    node.appendChild(icon(node.dataset.icon));
    node.dataset.iconDone = '1';
  }
}
