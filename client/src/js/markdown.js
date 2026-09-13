/**
 * A deliberately small Markdown subset — the formatting people actually use in
 * chat. Input is HTML-escaped *first*, so every tag in the output is one this
 * file put there; user text can never become markup.
 */
import { EMOJI_BY_NAME } from './emoji.js';

// Control-character placeholders (built at runtime so no source-encoding
// surprises): code spans are lifted out, the inline rules run, then they are
// stitched back in untouched.
const FENCE_MARK = String.fromCharCode(0);
const CODE_MARK = String.fromCharCode(1);

const EMOJI_ONLY = /^(?:\s*(?:\p{Extended_Pictographic})(?:️|‍|[\u{1F3FB}-\u{1F3FF}])*\s*){1,4}$/u;

function escapeText(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {string} text raw message content
 * @param {{ selfUsername?: string, knownUsernames?: Set<string> }} ctx
 * @returns {HTMLElement} a <span> holding the rendered content
 */
export function renderMarkdown(text, ctx = {}) {
  const container = document.createElement('span');
  const source = String(text ?? '');
  const trimmed = source.trim();

  // A message that is nothing but a few emoji reads better big.
  if (trimmed && EMOJI_ONLY.test(trimmed)) {
    const big = document.createElement('span');
    big.className = 'md-emoji-only';
    big.textContent = trimmed;
    container.appendChild(big);
    return container;
  }

  let working = escapeText(source);

  // 1. Pull fenced code blocks out so nothing else touches their contents.
  const fences = [];
  working = working.replace(/```(?:[a-zA-Z0-9+#._-]*\n)?([\s\S]*?)```/g, (_match, body) => {
    fences.push(body.replace(/^\n+|\n+$/g, ''));
    return `${FENCE_MARK}${fences.length - 1}${FENCE_MARK}`;
  });

  // 2. Then inline code, for the same reason.
  const codes = [];
  working = working.replace(/`([^`\n]+)`/g, (_match, body) => {
    codes.push(body);
    return `${CODE_MARK}${codes.length - 1}${CODE_MARK}`;
  });

  // 3. Block quotes (line-level, so they run before newlines become <br>).
  working = working.replace(/^&gt;\s?(.*)$/gm, '<span class="md-quote">$1</span>');

  // 4. Auto-links.
  working = working.replace(
    /(https?:\/\/[^\s<]+[^\s<.,:;!?)"'\]])/g,
    (url) => `<a class="md-link" data-href="${url}" title="${url}">${url}</a>`,
  );

  // 5. Emphasis. Longest markers first so ** never loses to *.
  working = working
    .replace(/\|\|([\s\S]+?)\|\|/g, '<span class="md-spoiler" title="Click to reveal">$1</span>')
    .replace(/\*\*\*([^*\n]+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+?)__/g, '<u>$1</u>')
    .replace(/~~([^~]+?)~~/g, '<s>$1</s>')
    .replace(/(^|[\s(])\*([^*\n]+?)\*(?=$|[\s.,!?)])/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+?)_(?=$|[\s.,!?)])/g, '$1<em>$2</em>');

  // 6. Mentions. Unknown handles stay as plain text so stray "@" is not styled.
  const self = String(ctx.selfUsername || '').toLowerCase();
  working = working.replace(/(^|[^\w/])@(everyone|here|[a-zA-Z0-9._-]{2,24})/g, (match, lead, name) => {
    const lower = name.toLowerCase();
    const broadcast = lower === 'everyone' || lower === 'here';
    if (!broadcast && ctx.knownUsernames && !ctx.knownUsernames.has(lower)) return match;
    const isMe = broadcast || lower === self;
    return `${lead}<span class="md-mention${isMe ? ' md-mention--me' : ''}" data-mention="${lower}">@${name}</span>`;
  });

  // 6a. #channel mentions. Only names of channels in this space are styled, so
  // a stray "#1" or a hashtag stays plain text; the id rides along so a click
  // opens the channel even after a rename since the last render.
  if (ctx.knownChannels && ctx.knownChannels.size) {
    working = working.replace(/(^|[^\w/&#])#([a-z0-9][a-z0-9_-]{0,63})/gi, (match, lead, name) => {
      const id = ctx.knownChannels.get(name.toLowerCase());
      if (!id) return match;
      return `${lead}<span class="md-chan" data-channel="${escapeText(id)}">#${name}</span>`;
    });
  }

  // 6b. :name: emoji — a custom one for this space first, then the built-in
  // shortcode set (:thumbsup: etc.), so a plain-text shortcode always renders
  // the same way regardless of which space or DM it's sent in.
  working = working.replace(/:([a-z0-9_+-]{2,32}):/gi, (match, name) => {
    const lower = name.toLowerCase();
    const url = ctx.emojis?.[lower];
    if (url) {
      // Photosensitivity: don't render an animated (GIF) emoji — show its name.
      if (ctx.reduceFlashing && /\.gif(\?|$)/i.test(url)) {
        return `<span class="emoji-muted" title=":${name}: (animated — hidden)">:${name}:</span>`;
      }
      return `<img class="custom-emoji" src="${escapeText(url)}" alt=":${name}:" title=":${name}:" />`;
    }
    const builtIn = EMOJI_BY_NAME[lower];
    if (builtIn) return `<span class="md-shortcode-emoji" title=":${name}:">${builtIn}</span>`;
    return match;
  });

  // 7. Newlines last, so the line-level rules above still saw real \n.
  working = working.replace(/\n/g, '<br />');

  // 8. Put the code back.
  working = working
    .replace(new RegExp(`${CODE_MARK}(\\d+)${CODE_MARK}`, 'g'),
      (_match, index) => `<code class="md-code">${codes[Number(index)]}</code>`)
    .replace(new RegExp(`${FENCE_MARK}(\\d+)${FENCE_MARK}`, 'g'),
      (_match, index) => `<pre class="md-pre">${fences[Number(index)]}</pre>`);

  container.innerHTML = working;
  return container;
}

/** Highlights every case-insensitive occurrence of `query` inside `root`. */
export function highlightMatches(root, query) {
  if (!query) return 0;
  const needle = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets = [];
  let node = walker.nextNode();
  while (node) {
    if (node.nodeValue.toLowerCase().includes(needle)) targets.push(node);
    node = walker.nextNode();
  }

  let hits = 0;
  for (const textNode of targets) {
    const value = textNode.nodeValue;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    let index = value.toLowerCase().indexOf(needle);
    while (index !== -1) {
      if (index > cursor) fragment.appendChild(document.createTextNode(value.slice(cursor, index)));
      const mark = document.createElement('mark');
      mark.className = 'md-search-hit';
      mark.textContent = value.slice(index, index + needle.length);
      fragment.appendChild(mark);
      hits += 1;
      cursor = index + needle.length;
      index = value.toLowerCase().indexOf(needle, cursor);
    }
    if (cursor < value.length) fragment.appendChild(document.createTextNode(value.slice(cursor)));
    textNode.parentNode.replaceChild(fragment, textNode);
  }
  return hits;
}

/** Plain-text preview for lists and notifications. */
export function toPlainText(text, limit = 140) {
  const flat = String(text ?? '')
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/[*_~`|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}
