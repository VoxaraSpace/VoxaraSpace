// Ready-made word lists for the automod filter. A space admin enables a pack
// to seed the blocked-words list, then edits the result however they like;
// nothing here is enforced on its own. Matching is whole-word and
// case-insensitive on the server, so plain forms are enough.
export const AUTOMOD_PACKS = [
  {
    id: 'curse', label: 'Curse words', hint: 'Everyday swearing.',
    words: ['fuck', 'fucking', 'fucker', 'motherfucker', 'shit', 'bullshit', 'shitty', 'bitch', 'bitches', 'asshole', 'arsehole', 'bastard', 'damn', 'goddamn', 'crap', 'piss', 'pissed', 'dick', 'dickhead', 'prick', 'cock', 'twat', 'wanker', 'bollocks', 'cunt', 'douchebag', 'jackass', 'dumbass', 'bugger', 'sod off'],
  },
  {
    id: 'sexual', label: 'Sexual terms', hint: 'Explicit sexual language.',
    words: ['sex', 'porn', 'porno', 'pornography', 'nude', 'nudes', 'naked', 'boobs', 'tits', 'titties', 'pussy', 'vagina', 'penis', 'cock', 'dick pic', 'blowjob', 'handjob', 'anal', 'cum', 'jizz', 'orgasm', 'masturbate', 'masturbation', 'horny', 'hentai', 'onlyfans', 'sexting', 'nsfw', 'xxx', 'dildo', 'fetish', 'bdsm', 'milf', 'thot', 'slut', 'whore', 'hooker'],
  },
  {
    id: 'slurs', label: 'Slurs', hint: 'Hateful terms for groups of people.',
    words: ['nigger', 'nigga', 'niggers', 'faggot', 'fag', 'fags', 'retard', 'retarded', 'tranny', 'trannies', 'kike', 'spic', 'chink', 'gook', 'wetback', 'beaner', 'raghead', 'towelhead', 'coon', 'jigaboo', 'paki', 'dyke', 'shemale', 'heeb', 'zipperhead', 'redskin', 'wop', 'kraut', 'gyppo'],
  },
  {
    id: 'scams', label: 'Scam phrases', hint: 'Lines used by account-theft and giveaway spam.',
    words: ['free nitro', 'free gift card', 'steam gift', 'claim your prize', 'you have been selected', 'verify your account here', 'airdrop', 'double your crypto', 'send me your password', 'dm me for free', 'click this link to claim', 'limited time giveaway', 'account will be deleted', 'login to confirm', 'free robux', 'free vbucks', 'earn $', 'make money fast', 'crypto investment', 'trading signals'],
  },
];
