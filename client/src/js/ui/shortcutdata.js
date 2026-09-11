/** One list of shortcuts, shown in Settings and in the Ctrl+/ reference. */
export const SHORTCUT_SECTIONS = [
  ['Navigation', [
    ['Quick switcher', ['Ctrl', 'K']],
    ['Walk the sidebar', ['Alt', '↓ / ↑']],
    ['Next / previous space', ['Ctrl', 'Alt', '↓ / ↑']],
    ['Jump to space by position', ['Ctrl', '1', '…', '9']],
    ['Jump to Friends', ['Ctrl', 'Shift', 'D']],
    ['Toggle member list', ['Ctrl', 'M']],
    ['Show or hide space names', ['Ctrl', 'B']],
  ]],
  ['Conversation', [
    ['Search this conversation', ['Ctrl', 'F']],
    ['Attach files', ['drag', 'or paste']],
    ['Edit your last message', ['↑', 'in an empty box']],
    ['New line', ['Shift', 'Enter']],
    ['Mark channel read', ['Esc']],
  ]],
  ['Formatting', [
    ['Bold', ['**text**']],
    ['Italic', ['*text*']],
    ['Underline', ['__text__']],
    ['Strikethrough', ['~~text~~']],
    ['Spoiler', ['||text||']],
    ['Inline code', ['`code`']],
    ['Code block', ['```code```']],
    ['Quote', ['> text']],
    ['Mention someone', ['@username']],
  ]],
  ['Window', [
    ['Settings', ['Ctrl', ',']],
    ['Keyboard shortcuts', ['Ctrl', '/']],
    ['Developer tools', ['F12']],
  ]],
];
