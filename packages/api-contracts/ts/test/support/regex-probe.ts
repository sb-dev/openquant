// Probes a schema pattern for super-linear backtracking in V8 (OQ-05 §7).
//
// A pattern is parsed into a small tree. Its adversarial inputs are strings that the pattern nearly
// matches: one unbounded repetition is pumped to n copies and the rest of the pattern is matched as
// short as it can be, then a character that no pattern accepts follows. That is the shape that makes
// a backtracking engine try every way to split the pumped text (-0.111...1x for the Decimal pattern).
// The probe times each input at n and at 8n characters and reports the worst ratio. Linear
// matching gives about 8 and quadratic matching about 64.
//
// The parser reads the syntax the schemas use: ^ $ (?: ) | [..] with ranges and escapes . * + ? {m}
// {m,n} and literal characters. It throws on anything else, so a pattern that needs more is noticed.

type Node =
  | { readonly kind: 'chars'; readonly chars: readonly string[] }
  | { readonly kind: 'seq'; readonly items: readonly Node[] }
  | { readonly kind: 'alt'; readonly options: readonly Node[] }
  | { readonly kind: 'rep'; readonly node: Node; readonly min: number; readonly max: number };

const EMPTY: Node = { kind: 'seq', items: [] };
/** Stands for `.`: a letter, a digit and two symbols. */
const ANY = ['a', '0', '-', '/'];

class Parser {
  private index = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  parse(): Node {
    const node = this.alternation();
    if (this.index !== this.source.length) this.unsupported();
    return node;
  }

  private unsupported(): never {
    throw new Error(`unsupported pattern syntax at ${this.index} of ${this.source}`);
  }

  private peek(): string | undefined {
    return this.source[this.index];
  }

  private alternation(): Node {
    const options = [this.sequence()];
    while (this.peek() === '|') {
      this.index += 1;
      options.push(this.sequence());
    }
    return options.length === 1 ? (options[0] ?? EMPTY) : { kind: 'alt', options };
  }

  private sequence(): Node {
    const items: Node[] = [];
    for (let next = this.peek(); next !== undefined && next !== '|' && next !== ')'; next = this.peek()) {
      const atom = this.atom();
      items.push(atom === EMPTY ? atom : this.quantified(atom));
    }
    return { kind: 'seq', items };
  }

  private atom(): Node {
    const char = this.peek();
    this.index += 1;
    if (char === '^' || char === '$') return EMPTY;
    if (char === '.') return { kind: 'chars', chars: ANY };
    if (char === '[') return this.characterClass();
    if (char === '\\') return { kind: 'chars', chars: [this.escaped()] };
    if (char === '(') {
      if (!this.source.startsWith('?:', this.index)) this.unsupported();
      this.index += 2;
      const inner = this.alternation();
      if (this.peek() !== ')') this.unsupported();
      this.index += 1;
      return inner;
    }
    if (char === undefined || '*+?{}|)]'.includes(char)) this.unsupported();
    return { kind: 'chars', chars: [char] };
  }

  private escaped(): string {
    const char = this.peek();
    this.index += 1;
    if (char === undefined || /[A-Za-z0-9]/.test(char)) this.unsupported();
    return char;
  }

  // One representative per range end, so the probe can pick overlapping classes apart.
  private characterClass(): Node {
    if (this.peek() === '^') this.unsupported();
    const chars: string[] = [];
    while (this.peek() !== ']') {
      if (this.peek() === undefined) this.unsupported();
      const first = this.classChar();
      if (this.peek() === '-' && this.source[this.index + 1] !== ']') {
        this.index += 1;
        const last = this.classChar();
        const span = last.codePointAt(0) ?? 0;
        const start = first.codePointAt(0) ?? 0;
        chars.push(first, String.fromCodePoint(Math.min(start + 1, span)), last);
      } else {
        chars.push(first);
      }
    }
    this.index += 1;
    return { kind: 'chars', chars: [...new Set(chars)] };
  }

  private classChar(): string {
    const char = this.peek();
    this.index += 1;
    if (char === '\\') return this.escaped();
    if (char === undefined) this.unsupported();
    return char;
  }

  private quantified(atom: Node): Node {
    const char = this.peek();
    let min: number;
    let max: number;
    if (char === '*') [min, max] = [0, Number.POSITIVE_INFINITY];
    else if (char === '+') [min, max] = [1, Number.POSITIVE_INFINITY];
    else if (char === '?') [min, max] = [0, 1];
    else if (char === '{') {
      const close = this.source.indexOf('}', this.index);
      const bounds = /^\{(\d+)(?:(,)(\d*))?\}$/.exec(this.source.slice(this.index, close + 1));
      if (close < 0 || bounds === null) this.unsupported();
      min = Number(bounds[1]);
      max = bounds[2] === undefined ? min : bounds[3] === '' ? Number.POSITIVE_INFINITY : Number(bounds[3]);
      this.index = close;
    } else return atom;
    this.index += 1;
    return { kind: 'rep', node: atom, min, max };
  }
}

/** Every repetition without an upper bound, in pattern order. */
function unboundedRepetitions(node: Node, out: Node[] = []): Node[] {
  if (node.kind === 'rep') {
    if (node.max === Number.POSITIVE_INFINITY) out.push(node);
    unboundedRepetitions(node.node, out);
  } else if (node.kind === 'seq') {
    for (const item of node.items) unboundedRepetitions(item, out);
  } else if (node.kind === 'alt') {
    for (const option of node.options) unboundedRepetitions(option, out);
  }
  return out;
}

interface Pump {
  /** The repetition pumped to `size` copies, or 'all' for every unbounded one. */
  readonly target: Node | 'all';
  readonly size: number;
  /** Which representative of each character set to use. */
  readonly pick: number;
}

const MAX_VARIANTS = 48;

// Every string that the node matches, with the repetitions that `pump` names at `size` copies and the
// others as short as they can be. A choice between options gives one string for each option.
function expand(node: Node, pump: Pump): string[] {
  if (node.kind === 'chars') return [node.chars[pump.pick % node.chars.length] ?? ''];
  if (node.kind === 'seq') {
    let strings = [''];
    for (const item of node.items) {
      const parts = expand(item, pump);
      strings = strings.flatMap((head) => parts.map((part) => head + part)).slice(0, MAX_VARIANTS);
    }
    return strings;
  }
  if (node.kind === 'alt') return node.options.flatMap((option) => expand(option, pump)).slice(0, MAX_VARIANTS);
  const pumped = pump.target === 'all' || pump.target === node;
  const count = pumped ? (node.max === Number.POSITIVE_INFINITY ? pump.size : node.max) : node.min;
  return expand(node.node, pump).map((part) => part.repeat(count));
}

/** Strings of about `size` characters that a backtracking engine tends to match slowly, and fail. */
export function adversarialInputs(pattern: string, size: number): string[] {
  const tree = new Parser(pattern).parse();
  const targets: (Node | 'all')[] = [...unboundedRepetitions(tree), 'all'];
  const inputs = new Set<string>();
  for (const target of targets) {
    for (let pick = 0; pick < 3; pick += 1) {
      for (const text of expand(tree, { target, size, pick })) inputs.add(`${text}!`);
    }
  }
  return [...inputs];
}

/** True when the pattern has an unbounded repetition, so the work to match it can grow with the text. */
export function hasUnboundedRepetition(pattern: string): boolean {
  return unboundedRepetitions(new Parser(pattern).parse()).length > 0;
}
