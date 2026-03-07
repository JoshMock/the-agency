/**
 *
 * This file contains code derived from https://github.com/can1357/oh-my-pi
 * Copyright (c) Can Bölük
 * Licensed under the MIT License.
 */

/**
 * Hashline edit mode — a line-addressable edit format using text hashes.
 *
 * Each line in a file is identified by its 1-indexed line number and a short
 * hash derived from the normalized line text (xxHash32, encoded as 2 chars
 * from a custom nibble alphabet).
 *
 * The combined `LINE#ID` reference acts as both an address and a staleness
 * check: if the file has changed since the caller last read it, hash
 * mismatches are caught before any mutation occurs.
 *
 * Displayed format: `LINENUM#HASH:TEXT`
 * Reference format: `"LINENUM#HASH"` (e.g. `"5#ZZ"`)
 */

/**
 * xxHash32 — fast, spec-correct 32-bit hash, works on Node and Bun.
 *
 * The algorithm processes input in 16-byte blocks using four independent
 * accumulators (v1–v4), each seeded at a different offset. Every 4-byte word
 * is mixed via multiply → rotate → multiply (the `>>> 0` calls keep values in
 * uint32 range, since JS has no native unsigned integer type). After the main
 * loop the accumulators are merged with different rotation amounts so the four
 * parallel streams combine asymmetrically. Remaining bytes are consumed 4-at-
 * a-time then 1-at-a-time. A final three-round XOR-shift+multiply avalanche
 * ensures every output bit depends on every input bit.
 *
 * The five prime constants (P1–P5) are large primes with balanced bit
 * patterns chosen by the xxHash author; P1 is derived from floor(2^32 / φ).
 *
 * A third-party implementation isn't a good fit here: the best option
 * (`xxhash-wasm`) requires an async initialization step to load the WASM
 * module, which would complicate the call sites. The implementation below is
 * short, self-contained, and fully covered by the existing test suite.
 */
const _P1 = 0x9e3779b1;
const _P2 = 0x85ebca77;
const _P3 = 0xc2b2ae3d;
const _P4 = 0x27d4eb2f;
const _P5 = 0x165667b1;
const _enc = new TextEncoder();

function _rotl32(x: number, r: number): number {
  return (x << r) | (x >>> (32 - r));
}

function xxHash32(str: string, seed = 0): number {
  const data = _enc.encode(str);
  const len = data.length;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let h32: number;
  let p = 0;

  if (len >= 16) {
    let v1 = (seed + _P1 + _P2) >>> 0;
    let v2 = (seed + _P2) >>> 0;
    let v3 = seed >>> 0;
    let v4 = (seed - _P1) >>> 0;
    do {
      v1 = Math.imul(_rotl32((v1 + Math.imul(view.getUint32(p, true), _P2)) >>> 0, 13), _P1) >>> 0; p += 4;
      v2 = Math.imul(_rotl32((v2 + Math.imul(view.getUint32(p, true), _P2)) >>> 0, 13), _P1) >>> 0; p += 4;
      v3 = Math.imul(_rotl32((v3 + Math.imul(view.getUint32(p, true), _P2)) >>> 0, 13), _P1) >>> 0; p += 4;
      v4 = Math.imul(_rotl32((v4 + Math.imul(view.getUint32(p, true), _P2)) >>> 0, 13), _P1) >>> 0; p += 4;
    } while (p <= len - 16);
    h32 = (_rotl32(v1, 1) + _rotl32(v2, 7) + _rotl32(v3, 12) + _rotl32(v4, 18)) >>> 0;
  } else {
    h32 = (seed + _P5) >>> 0;
  }

  h32 = (h32 + len) >>> 0;

  while (p <= len - 4) {
    h32 = Math.imul(_rotl32((h32 ^ Math.imul(view.getUint32(p, true), _P3)) >>> 0, 17), _P4) >>> 0;
    p += 4;
  }
  while (p < len) {
    h32 = Math.imul(_rotl32((h32 ^ Math.imul(data[p], _P5)) >>> 0, 11), _P1) >>> 0;
    p++;
  }

  h32 ^= h32 >>> 15;
  h32 = Math.imul(h32, _P2) >>> 0;
  h32 ^= h32 >>> 13;
  h32 = Math.imul(h32, _P3) >>> 0;
  h32 ^= h32 >>> 16;

  return h32;
}

const NIBBLE_STR = "ZPMQVRWSNKTXJBYH";

const DICT = Array.from({ length: 256 }, (_, i) => {
  const h = i >>> 4;
  const l = i & 0x0f;
  return `${NIBBLE_STR[h]}${NIBBLE_STR[l]}`;
});

const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;

export interface Anchor {
  line: number;
  hash: string;
}

export type HashlineEdit =
  | { op: "replace"; pos: Anchor; end?: Anchor; lines: string[] }
  | { op: "append"; pos?: Anchor; lines: string[] }
  | { op: "prepend"; pos?: Anchor; lines: string[] };

export interface HashMismatch {
  line: number;
  expected: string;
  actual: string;
}

/**
 * Compute a 2-char hash for a single line.
 *
 * Uses xxHash32 on whitespace-normalized text. For lines with no
 * alphanumeric characters, the line number is mixed in as the seed
 * to reduce collisions among punctuation-only / blank lines.
 */
export function computeLineHash(idx: number, line: string): string {
  if (line.endsWith("\r")) {
    line = line.slice(0, -1);
  }
  line = line.replace(/\s+/g, "");

  let seed = 0;
  if (!RE_SIGNIFICANT.test(line)) {
    seed = idx;
  }
  return DICT[xxHash32(line, seed) & 0xff];
}

/** Format a `LINE#HASH` tag. */
export function formatLineTag(line: number, text: string): string {
  return `${line}#${computeLineHash(line, text)}`;
}

/**
 * Format file text with hashline prefixes.
 *
 * Each output line becomes `LINENUM#HASH:TEXT` (1-indexed).
 */
export function formatHashLines(text: string, startLine = 1): string {
  const lines = text.split("\n");
  return lines
    .map((line, i) => {
      const num = startLine + i;
      return `${formatLineTag(num, line)}:${line}`;
    })
    .join("\n");
}

/**
 * Parse a line reference like `"5#ZP"` into `{ line, hash }`.
 */
export function parseTag(ref: string): Anchor {
  const match = ref.match(/^\s*[>+-]*\s*(\d+)\s*#\s*([ZPMQVRWSNKTXJBYH]{2})/);
  if (!match) {
    throw new Error(
      `Invalid line reference "${ref}". Expected format "LINE#ID" (e.g. "5#ZZ").`
    );
  }
  const line = Number.parseInt(match[1], 10);
  if (line < 1) {
    throw new Error(`Line number must be >= 1, got ${line} in "${ref}".`);
  }
  return { line, hash: match[2] };
}

const MISMATCH_CONTEXT = 2;

export class HashlineMismatchError extends Error {
  readonly remaps: ReadonlyMap<string, string>;

  constructor(
    public readonly mismatches: HashMismatch[],
    public readonly fileLines: string[]
  ) {
    super(HashlineMismatchError.formatMessage(mismatches, fileLines));
    this.name = "HashlineMismatchError";
    const remaps = new Map<string, string>();
    for (const m of mismatches) {
      const actual = computeLineHash(m.line, fileLines[m.line - 1]);
      remaps.set(`${m.line}#${m.expected}`, `${m.line}#${actual}`);
    }
    this.remaps = remaps;
  }

  static formatMessage(
    mismatches: HashMismatch[],
    fileLines: string[]
  ): string {
    const mismatchSet = new Map<number, HashMismatch>();
    for (const m of mismatches) {
      mismatchSet.set(m.line, m);
    }

    const displayLines = new Set<number>();
    for (const m of mismatches) {
      const lo = Math.max(1, m.line - MISMATCH_CONTEXT);
      const hi = Math.min(fileLines.length, m.line + MISMATCH_CONTEXT);
      for (let i = lo; i <= hi; i++) {
        displayLines.add(i);
      }
    }

    const sorted = [...displayLines].sort((a, b) => a - b);
    const lines: string[] = [];

    lines.push(
      `${mismatches.length} line${mismatches.length > 1 ? "s have" : " has"} changed since last read. Use the updated LINE#ID references shown below (>>> marks changed lines).`
    );
    lines.push("");

    let prevLine = -1;
    for (const lineNum of sorted) {
      if (prevLine !== -1 && lineNum > prevLine + 1) {
        lines.push("    ...");
      }
      prevLine = lineNum;

      const text = fileLines[lineNum - 1];
      const hash = computeLineHash(lineNum, text);
      const prefix = `${lineNum}#${hash}`;

      if (mismatchSet.has(lineNum)) {
        lines.push(`>>> ${prefix}:${text}`);
      } else {
        lines.push(`    ${prefix}:${text}`);
      }
    }
    return lines.join("\n");
  }
}

/**
 * Apply an array of hashline edits to file content.
 *
 * Edits are validated for hash correctness then applied bottom-up so
 * earlier splices don't invalidate later line numbers.
 */
export function applyHashlineEdits(
  text: string,
  edits: HashlineEdit[]
): {
  lines: string;
  firstChangedLine: number | undefined;
  warnings?: string[];
  noopEdits?: Array<{ editIndex: number; loc: string; current: string }>;
} {
  if (edits.length === 0) {
    return { lines: text, firstChangedLine: undefined };
  }

  const fileLines = text.split("\n");
  const originalFileLines = [...fileLines];
  let firstChangedLine: number | undefined;
  const noopEdits: Array<{ editIndex: number; loc: string; current: string }> =
    [];
  const warnings: string[] = [];

  // pre-validate all hashes before mutating
  const mismatches: HashMismatch[] = [];
  function validateRef(ref: Anchor): boolean {
    if (ref.line < 1 || ref.line > fileLines.length) {
      throw new Error(
        `Line ${ref.line} does not exist (file has ${fileLines.length} lines)`
      );
    }
    const actualHash = computeLineHash(ref.line, fileLines[ref.line - 1]);
    if (actualHash === ref.hash) return true;
    mismatches.push({ line: ref.line, expected: ref.hash, actual: actualHash });
    return false;
  }

  for (const edit of edits) {
    switch (edit.op) {
      case "replace": {
        if (edit.end) {
          const startValid = validateRef(edit.pos);
          const endValid = validateRef(edit.end);
          if (!startValid || !endValid) continue;
          if (edit.pos.line > edit.end.line) {
            throw new Error(
              `Range start line ${edit.pos.line} must be <= end line ${edit.end.line}`
            );
          }
        } else {
          if (!validateRef(edit.pos)) continue;
        }
        break;
      }
      case "append": {
        if (edit.pos && !validateRef(edit.pos)) continue;
        if (edit.lines.length === 0) edit.lines = [""];
        break;
      }
      case "prepend": {
        if (edit.pos && !validateRef(edit.pos)) continue;
        if (edit.lines.length === 0) edit.lines = [""];
        break;
      }
    }
  }

  if (mismatches.length > 0) {
    throw new HashlineMismatchError(mismatches, fileLines);
  }

  // autocorrect escaped tabs
  for (const edit of edits) {
    if (edit.lines.length === 0) continue;
    const hasEscapedTabs = edit.lines.some((l) => l.includes("\\t"));
    if (!hasEscapedTabs) continue;
    const hasRealTabs = edit.lines.some((l) => l.includes("\t"));
    if (hasRealTabs) continue;
    let correctedCount = 0;
    const corrected = edit.lines.map((line) =>
      line.replace(/^((?:\\t)+)/, (escaped) => {
        correctedCount += escaped.length / 2;
        return "\t".repeat(escaped.length / 2);
      })
    );
    if (correctedCount === 0) continue;
    edit.lines = corrected;
    warnings.push(
      "Auto-corrected escaped tab indentation: converted leading \\t to real tab characters"
    );
  }

  // deduplicate identical edits targeting the same location
  const seenEditKeys = new Map<string, number>();
  const dedupIndices = new Set<number>();
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    let lineKey: string;
    switch (edit.op) {
      case "replace":
        lineKey = edit.end
          ? `r:${edit.pos.line}:${edit.end.line}`
          : `s:${edit.pos.line}`;
        break;
      case "append":
        lineKey = edit.pos ? `i:${edit.pos.line}` : "ieof";
        break;
      case "prepend":
        lineKey = edit.pos ? `ib:${edit.pos.line}` : "ibef";
        break;
    }
    const dstKey = `${lineKey}:${edit.lines.join("\n")}`;
    if (seenEditKeys.has(dstKey)) {
      dedupIndices.add(i);
    } else {
      seenEditKeys.set(dstKey, i);
    }
  }
  if (dedupIndices.size > 0) {
    for (let i = edits.length - 1; i >= 0; i--) {
      if (dedupIndices.has(i)) edits.splice(i, 1);
    }
  }

  // sort bottom-up so splices don't shift later targets
  const annotated = edits.map((edit, idx) => {
    let sortLine: number;
    let precedence: number;
    switch (edit.op) {
      case "replace":
        sortLine = edit.end ? edit.end.line : edit.pos.line;
        precedence = 0;
        break;
      case "append":
        sortLine = edit.pos ? edit.pos.line : fileLines.length + 1;
        precedence = 1;
        break;
      case "prepend":
        sortLine = edit.pos ? edit.pos.line : 0;
        precedence = 2;
        break;
    }
    return { edit, idx, sortLine, precedence };
  });

  annotated.sort(
    (a, b) =>
      b.sortLine - a.sortLine ||
      a.precedence - b.precedence ||
      a.idx - b.idx
  );

  function trackFirstChanged(line: number): void {
    if (firstChangedLine === undefined || line < firstChangedLine) {
      firstChangedLine = line;
    }
  }

  // apply edits bottom-up
  for (const { edit, idx } of annotated) {
    switch (edit.op) {
      case "replace": {
        if (!edit.end) {
          const origLines = originalFileLines.slice(
            edit.pos.line - 1,
            edit.pos.line
          );
          if (origLines.every((line, i) => line === edit.lines[i])) {
            noopEdits.push({
              editIndex: idx,
              loc: `${edit.pos.line}#${edit.pos.hash}`,
              current: origLines.join("\n"),
            });
            break;
          }
          fileLines.splice(edit.pos.line - 1, 1, ...edit.lines);
          trackFirstChanged(edit.pos.line);
        } else {
          const count = edit.end.line - edit.pos.line + 1;
          const newLines = [...edit.lines];
          const trailingReplacementLine =
            newLines[newLines.length - 1]?.trimEnd();
          const nextSurvivingLine = fileLines[edit.end.line]?.trimEnd();
          if (
            trailingReplacementLine &&
            nextSurvivingLine &&
            trailingReplacementLine === nextSurvivingLine &&
            fileLines[edit.end.line - 1]?.trimEnd() !==
              trailingReplacementLine
          ) {
            newLines.pop();
            warnings.push(
              `Auto-corrected range replace ${edit.pos.line}#${edit.pos.hash}-${edit.end.line}#${edit.end.hash}: removed trailing line that duplicated next surviving line`
            );
          }
          fileLines.splice(edit.pos.line - 1, count, ...newLines);
          trackFirstChanged(edit.pos.line);
        }
        break;
      }
      case "append": {
        if (edit.lines.length === 0) {
          noopEdits.push({
            editIndex: idx,
            loc: edit.pos ? `${edit.pos.line}#${edit.pos.hash}` : "EOF",
            current: edit.pos ? originalFileLines[edit.pos.line - 1] : "",
          });
          break;
        }
        if (edit.pos) {
          fileLines.splice(edit.pos.line, 0, ...edit.lines);
          trackFirstChanged(edit.pos.line + 1);
        } else {
          if (fileLines.length === 1 && fileLines[0] === "") {
            fileLines.splice(0, 1, ...edit.lines);
            trackFirstChanged(1);
          } else {
            fileLines.splice(fileLines.length, 0, ...edit.lines);
            trackFirstChanged(fileLines.length - edit.lines.length + 1);
          }
        }
        break;
      }
      case "prepend": {
        if (edit.lines.length === 0) {
          noopEdits.push({
            editIndex: idx,
            loc: edit.pos ? `${edit.pos.line}#${edit.pos.hash}` : "BOF",
            current: edit.pos ? originalFileLines[edit.pos.line - 1] : "",
          });
          break;
        }
        if (edit.pos) {
          fileLines.splice(edit.pos.line - 1, 0, ...edit.lines);
          trackFirstChanged(edit.pos.line);
        } else {
          if (fileLines.length === 1 && fileLines[0] === "") {
            fileLines.splice(0, 1, ...edit.lines);
          } else {
            fileLines.splice(0, 0, ...edit.lines);
          }
          trackFirstChanged(1);
        }
        break;
      }
    }
  }

  return {
    lines: fileLines.join("\n"),
    firstChangedLine,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(noopEdits.length > 0 ? { noopEdits } : {}),
  };
}
