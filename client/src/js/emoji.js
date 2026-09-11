// A curated emoji set with keywords, grouped the way people look for them.
// The third element of each tuple is its shortcode — the plain name typed
// between colons, e.g. `:thumbsup:` for 👍 (see markdown.js and
// emojiautocomplete.js, which both key off it).

export const EMOJI_GROUPS = [
  {
    name: 'Reactions',
    items: [
      ['👍', 'thumbs up yes approve like', 'thumbsup'],
      ['👎', 'thumbs down no disapprove', 'thumbsdown'],
      ['❤️', 'heart love red', 'heart'],
      ['🔥', 'fire lit hot', 'fire'],
      ['🎉', 'party tada celebrate', 'tada'],
      ['😂', 'joy laugh crying funny', 'joy'],
      ['👀', 'eyes looking watching', 'eyes'],
      ['✅', 'check done complete yes', 'white_check_mark'],
      ['❌', 'cross no wrong', 'x'],
      ['🙏', 'pray thanks please', 'pray'],
      ['💯', 'hundred perfect score', '100'],
      ['🚀', 'rocket ship launch ship it', 'rocket'],
      ['🤝', 'handshake deal agree', 'handshake'],
      ['⭐', 'star favourite', 'star'],
      ['💡', 'idea lightbulb', 'bulb'],
      ['🧠', 'brain smart big brain', 'brain'],
    ],
  },
  {
    name: 'Smileys',
    items: [
      ['😀', 'grin happy smile', 'grinning'],
      ['😃', 'smile happy', 'smiley'],
      ['😄', 'laugh happy', 'smile'],
      ['😁', 'beam grin', 'grin'],
      ['😊', 'blush smile warm', 'blush'],
      ['🙂', 'slight smile', 'slight_smile'],
      ['😉', 'wink', 'wink'],
      ['😍', 'heart eyes love', 'heart_eyes'],
      ['🥰', 'loved hearts', 'smiling_face_with_hearts'],
      ['😘', 'kiss', 'kissing_heart'],
      ['😜', 'tongue silly', 'stuck_out_tongue_winking_eye'],
      ['🤪', 'zany goofy', 'zany_face'],
      ['🤔', 'thinking hmm', 'thinking'],
      ['🤨', 'raised eyebrow sceptical', 'raised_eyebrow'],
      ['😐', 'neutral meh', 'neutral_face'],
      ['😑', 'expressionless', 'expressionless'],
      ['😴', 'sleep tired zzz', 'sleeping'],
      ['😪', 'sleepy', 'sleepy'],
      ['😭', 'sob cry', 'sob'],
      ['😅', 'sweat smile phew', 'sweat_smile'],
      ['😆', 'laughing satisfied squint', 'laughing'],
      ['🤣', 'rofl rolling floor laughing lol', 'rofl'],
      ['😬', 'grimace yikes', 'grimacing'],
      ['🙃', 'upside down', 'upside_down'],
      ['😎', 'cool sunglasses', 'sunglasses'],
      ['🥳', 'partying celebrate', 'partying_face'],
      ['🤯', 'mind blown', 'exploding_head'],
      ['😳', 'flushed shocked', 'flushed'],
      ['🥲', 'happy tear', 'smiling_face_with_tear'],
      ['😤', 'triumph determined', 'triumph'],
      ['😱', 'scream shocked', 'scream'],
      ['🤗', 'hug', 'hugging_face'],
      ['🤫', 'shh quiet', 'shushing_face'],
      ['🫠', 'melting', 'melting_face'],
    ],
  },
  {
    name: 'Gestures & people',
    items: [
      ['👋', 'wave hello hi bye', 'wave'],
      ['🤚', 'raised hand stop', 'raised_back_of_hand'],
      ['✌️', 'peace victory', 'v'],
      ['🤞', 'fingers crossed luck', 'crossed_fingers'],
      ['🤟', 'love you', 'love_you_gesture'],
      ['👌', 'ok perfect', 'ok_hand'],
      ['🤌', 'pinched italian', 'pinched_fingers'],
      ['👏', 'clap applause', 'clap'],
      ['🙌', 'raised hands praise', 'raised_hands'],
      ['💪', 'muscle strong', 'muscle'],
      ['🫶', 'heart hands', 'heart_hands'],
      ['🙇', 'bow sorry', 'bow'],
      ['🤷', 'shrug dunno', 'shrug'],
      ['🤦', 'facepalm', 'facepalm'],
      ['💃', 'dancing', 'dancer'],
      ['🧑‍💻', 'coder developer working', 'technologist'],
    ],
  },
  {
    name: 'Objects & symbols',
    items: [
      ['💬', 'chat speech message', 'speech_balloon'],
      ['📌', 'pin pinned', 'pushpin'],
      ['📎', 'clip attachment', 'paperclip'],
      ['📝', 'memo note write', 'memo'],
      ['📅', 'calendar date', 'calendar'],
      ['⏰', 'alarm clock time', 'alarm_clock'],
      ['🔔', 'bell notification', 'bell'],
      ['🔕', 'mute silent', 'no_bell'],
      ['🔒', 'lock private', 'lock'],
      ['🔑', 'key access', 'key'],
      ['⚙️', 'settings gear', 'gear'],
      ['🐛', 'bug issue', 'bug'],
      ['🛠️', 'tools fix', 'tools'],
      ['📦', 'package box ship', 'package'],
      ['💻', 'laptop computer', 'computer'],
      ['📱', 'phone mobile', 'iphone'],
      ['☕', 'coffee break', 'coffee'],
      ['🍕', 'pizza food', 'pizza'],
      ['🍻', 'beers cheers', 'beers'],
      ['🎮', 'game gaming controller', 'video_game'],
      ['🎵', 'music note', 'musical_note'],
      ['🌙', 'moon night', 'crescent_moon'],
      ['☀️', 'sun day', 'sunny'],
      ['🌈', 'rainbow', 'rainbow'],
      ['⚡', 'zap fast lightning', 'zap'],
      ['💤', 'zzz sleep afk', 'zzz'],
      ['🏆', 'trophy win', 'trophy'],
      ['🎯', 'target bullseye goal', 'dart'],
    ],
  },
];

/** Flat, searchable list. */
export const EMOJI_ALL = EMOJI_GROUPS.flatMap((group) =>
  group.items.map(([emoji, keywords, name]) => ({ emoji, keywords, name, group: group.name })));

/** Shortcode (no colons) -> emoji, for `:name:` autocomplete and rendering. */
export const EMOJI_BY_NAME = Object.fromEntries(EMOJI_ALL.map((e) => [e.name, e.emoji]));

/** The row offered as one-click reactions on message hover. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '🔥'];

export function searchEmoji(query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return null;
  return EMOJI_ALL.filter((entry) => entry.keywords.includes(needle) || entry.emoji === needle || entry.name === needle);
}

/** Shortcodes whose name starts with (or contains) `query`, prefix matches first. */
export function matchEmojiNames(query, limit = 8) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return [];
  return EMOJI_ALL
    .filter((entry) => entry.name.includes(needle))
    .sort((a, b) => {
      const ap = a.name.startsWith(needle) ? 0 : 1;
      const bp = b.name.startsWith(needle) ? 0 : 1;
      return ap - bp || a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}
