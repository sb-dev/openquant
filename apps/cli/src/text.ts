// Terminal text (OQ-04 section 11, OQ-05 section 8). Every text that reaches the terminal passes through `sanitize`:
// API values, error messages and file contents are untrusted, and a control sequence in them must not move the cursor,
// change colours, retitle the window or reorder text. Lines are wrapped, never clipped, to the output width, at most
// 80 columns. JSON output keeps every value exact and escapes the same characters, so it is safe to print too.

/** Widest output, in terminal columns: the CLI fits an 80-column terminal (OQ-04 section 11). */
export const MAX_WIDTH = 80;
/** The narrowest width the CLI lays out; a narrower terminal wraps at this width. */
export const MIN_WIDTH = 20;

// C0 and C1 controls and DEL; bidirectional overrides, isolates and marks; line and paragraph separators. A visible
// replacement keeps the reader aware that something was removed.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the expression exists to find control characters.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Text that is safe to print: no control sequence, no bidirectional override, tabs as spaces, newlines kept. */
export function sanitize(text: string): string {
  return text.replace(LONE_SURROGATE, '\ufffd').replace(/\t/g, ' ').replace(UNSAFE, '?');
}

/** One line of text: sanitised, with every line break turned into a space. */
export function sanitizeLine(text: string): string {
  return sanitize(text).replace(/\r\n|\r|\n/g, ' ');
}

/** JSON text whose values are unchanged and which holds no raw control or bidirectional character. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

const COMBINING = /\p{M}/u;
const WIDE = /\p{Extended_Pictographic}/u;

/** Terminal columns of one code point: 0 for a combining mark, 2 for an East Asian wide character, 1 otherwise. */
export function cellWidth(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  if (code === 0x200d || COMBINING.test(character)) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd) ||
    (code >= 0x1f300 && WIDE.test(character))
  ) {
    return 2;
  }
  return 1;
}

export function textWidth(text: string): number {
  let width = 0;
  for (const character of text) width += cellWidth(character);
  return width;
}

/** The output width for a terminal of `columns` columns: at most 80, at least MIN_WIDTH. */
export function outputWidth(columns: number | undefined): number {
  if (columns === undefined || !Number.isFinite(columns) || columns <= 0) return MAX_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(columns)));
}

/**
 * Wrap one line to `width` columns. Words move to the next line; a word longer than the line is broken. A wrapped
 * line keeps the indentation of the first, plus `hang` spaces, so a value stays under its label.
 */
export function wrapLine(line: string, width: number, hang = 0): string[] {
  const text = sanitizeLine(line);
  if (textWidth(text) <= width) return [text];
  const indent = /^ */.exec(text)?.[0].length ?? 0;
  const pad = ' '.repeat(Math.min(indent + hang, Math.floor(width / 2)));
  const lines: string[] = [];
  let current = text.slice(0, indent);
  let currentWidth = indent;
  // Whether the current line holds a word yet: a line never starts with a space, and is only broken after a word.
  let started = false;
  const words = text.slice(indent).split(/( +)/);
  const push = () => {
    lines.push(current.replace(/ +$/, ''));
    current = pad;
    currentWidth = pad.length;
    started = false;
  };
  const add = (part: string, partWidth: number) => {
    current += part;
    currentWidth += partWidth;
    started = true;
  };
  for (const word of words) {
    if (word === '') continue;
    const wordWidth = textWidth(word);
    if (/^ +$/.test(word)) {
      if (started && currentWidth + wordWidth <= width) {
        current += word;
        currentWidth += wordWidth;
      }
      continue;
    }
    if (started && currentWidth + wordWidth > width) push();
    if (currentWidth + wordWidth <= width) {
      add(word, wordWidth);
      continue;
    }
    for (const character of word) {
      const characterWidth = cellWidth(character);
      if (started && currentWidth + characterWidth > width) push();
      add(character, characterWidth);
    }
  }
  if (current.trim() !== '' || lines.length === 0) lines.push(current.replace(/ +$/, ''));
  return lines;
}

/** Wrap every line; a line that starts with two spaces after a label hangs under its value. */
export function wrapLines(lines: readonly string[], width: number): string[] {
  return lines.flatMap((line) =>
    sanitize(line)
      .split(/\r\n|\r|\n/)
      .flatMap((part) => wrapLine(part, width, 2)),
  );
}
