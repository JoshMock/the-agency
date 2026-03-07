import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import {
  computeLineHash,
  formatLineTag,
  formatHashLines,
  parseTag,
  applyHashlineEdits,
  HashlineMismatchError,
} from "./hashline.ts";

describe("computeLineHash", () => {
  it("returns a 2-character string", () => {
    const hash = computeLineHash(1, "hello world");
    assert.equal(hash.length, 2);
  });

  it("returns consistent results for the same input", () => {
    const a = computeLineHash(1, "const x = 1;");
    const b = computeLineHash(1, "const x = 1;");
    assert.equal(a, b);
  });

  it("ignores whitespace differences", () => {
    const a = computeLineHash(1, "const x = 1;");
    const b = computeLineHash(1, "const  x  =  1;");
    assert.equal(a, b);
  });

  it("strips trailing carriage return", () => {
    const a = computeLineHash(1, "hello");
    const b = computeLineHash(1, "hello\r");
    assert.equal(a, b);
  });

  it("uses line number as seed for non-alphanumeric lines", () => {
    const a = computeLineHash(1, "---");
    const b = computeLineHash(2, "---");
    assert.notEqual(a, b);
  });
});

describe("formatLineTag", () => {
  it("returns LINE#HASH format", () => {
    const tag = formatLineTag(5, "some text");
    assert.match(tag, /^5#[A-Z]{2}$/);
  });
});

describe("formatHashLines", () => {
  it("prefixes each line with LINE#HASH:", () => {
    const result = formatHashLines("a\nb\nc");
    const lines = result.split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^1#[A-Z]{2}:a$/);
    assert.match(lines[1], /^2#[A-Z]{2}:b$/);
    assert.match(lines[2], /^3#[A-Z]{2}:c$/);
  });

  it("respects startLine parameter", () => {
    const result = formatHashLines("x\ny", 10);
    const lines = result.split("\n");
    assert.match(lines[0], /^10#[A-Z]{2}:x$/);
    assert.match(lines[1], /^11#[A-Z]{2}:y$/);
  });
});

describe("parseTag", () => {
  it("parses a valid LINE#HASH reference", () => {
    const anchor = parseTag("5#ZP");
    assert.equal(anchor.line, 5);
    assert.equal(anchor.hash, "ZP");
  });

  it("handles leading whitespace", () => {
    const anchor = parseTag("  10#MQ");
    assert.equal(anchor.line, 10);
    assert.equal(anchor.hash, "MQ");
  });

  it("throws on invalid format", () => {
    assert.throws(() => parseTag("invalid"), /Invalid line reference/);
  });

  it("throws on line number 0", () => {
    assert.throws(() => parseTag("0#ZZ"), /must be >= 1/);
  });
});

describe("applyHashlineEdits", () => {
  // helper to get hash for a line
  function tagFor(lineNum: number, text: string): string {
    return `${lineNum}#${computeLineHash(lineNum, text)}`;
  }

  function anchorFor(lineNum: number, text: string) {
    return { line: lineNum, hash: computeLineHash(lineNum, text) };
  }

  it("returns unchanged text with no edits", () => {
    const result = applyHashlineEdits("hello\nworld", []);
    assert.equal(result.lines, "hello\nworld");
    assert.equal(result.firstChangedLine, undefined);
  });

  it("replaces a single line", () => {
    const text = "aaa\nbbb\nccc";
    const result = applyHashlineEdits(text, [
      { op: "replace", pos: anchorFor(2, "bbb"), lines: ["BBB"] },
    ]);
    assert.equal(result.lines, "aaa\nBBB\nccc");
    assert.equal(result.firstChangedLine, 2);
  });

  it("replaces a range of lines", () => {
    const text = "aaa\nbbb\nccc\nddd";
    const result = applyHashlineEdits(text, [
      {
        op: "replace",
        pos: anchorFor(2, "bbb"),
        end: anchorFor(3, "ccc"),
        lines: ["XXX"],
      },
    ]);
    assert.equal(result.lines, "aaa\nXXX\nddd");
  });

  it("appends lines after a position", () => {
    const text = "aaa\nbbb";
    const result = applyHashlineEdits(text, [
      { op: "append", pos: anchorFor(1, "aaa"), lines: ["inserted"] },
    ]);
    assert.equal(result.lines, "aaa\ninserted\nbbb");
  });

  it("appends at EOF when pos is omitted", () => {
    const text = "aaa\nbbb";
    const result = applyHashlineEdits(text, [
      { op: "append", lines: ["ccc"] },
    ]);
    assert.equal(result.lines, "aaa\nbbb\nccc");
  });

  it("prepends lines before a position", () => {
    const text = "aaa\nbbb";
    const result = applyHashlineEdits(text, [
      { op: "prepend", pos: anchorFor(2, "bbb"), lines: ["inserted"] },
    ]);
    assert.equal(result.lines, "aaa\ninserted\nbbb");
  });

  it("prepends at BOF when pos is omitted", () => {
    const text = "aaa\nbbb";
    const result = applyHashlineEdits(text, [
      { op: "prepend", lines: ["zzz"] },
    ]);
    assert.equal(result.lines, "zzz\naaa\nbbb");
  });

  it("throws HashlineMismatchError on stale hash", () => {
    const text = "aaa\nbbb";
    assert.throws(
      () =>
        applyHashlineEdits(text, [
          { op: "replace", pos: { line: 1, hash: "XX" }, lines: ["new"] },
        ]),
      (err: any) => err instanceof HashlineMismatchError
    );
  });

  it("detects no-op edits", () => {
    const text = "aaa\nbbb";
    const result = applyHashlineEdits(text, [
      { op: "replace", pos: anchorFor(1, "aaa"), lines: ["aaa"] },
    ]);
    assert.equal(result.firstChangedLine, undefined);
    assert.equal(result.noopEdits?.length, 1);
  });

  it("throws on out-of-range line number", () => {
    assert.throws(
      () =>
        applyHashlineEdits("aaa", [
          { op: "replace", pos: { line: 5, hash: "ZZ" }, lines: ["x"] },
        ]),
      /does not exist/
    );
  });
});
