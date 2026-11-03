/**
 * Unit tests for the pure helpers in apple_vision_ocr.ts. The text samples are
 * real OCR output from the 2026-11 blog image review.
 *
 * @module
 */
import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.13";
import {
  DEFAULT_FLAG_PATTERNS,
  findFlags,
  hasImageExtension,
  parseRecognizeOutput,
  toImageResult,
} from "./apple_vision_ocr.ts";

Deno.test("findFlags: CartoonStock reproduction notice", () => {
  const flags = findFlags(
    "© Original Artist\nReproduction rights.obtainable from\nwww.CartoonStock.comr",
    {},
    DEFAULT_FLAG_PATTERNS,
  );
  assertEquals(flags.map((f) => f.pattern), ["©", "reproduction rights", "cartoonstock"]);
});

Deno.test("findFlags: comic site credit without a © sign", () => {
  const flags = findFlags("Geek Culture\nby Nitrozac & Snaggy\njoyoftech.com", {}, DEFAULT_FLAG_PATTERNS);
  assertEquals(flags, [{ pattern: "joyoftech", match: "joyoftech", source: "text", line: "joyoftech.com" }]);
});

Deno.test("findFlags: metadata copyright is reported with source=metadata", () => {
  const flags = findFlags("", { copyright: "Copyright 2014 Jane Doe" }, DEFAULT_FLAG_PATTERNS);
  assertEquals(flags, [{
    pattern: "copyright",
    match: "Copyright",
    source: "metadata",
    line: "Copyright 2014 Jane Doe",
  }]);
});

Deno.test("findFlags: plain data-source citations and screenshots are not flagged", () => {
  assertEquals(findFlags("Source: IMF Commodity Price Forecasts, May 2013", {}, DEFAULT_FLAG_PATTERNS), []);
  assertEquals(findFlags("www.facebook.com | Like | Comment | Share", {}, DEFAULT_FLAG_PATTERNS), []);
});

Deno.test("findFlags: custom patterns replace the defaults", () => {
  const flags = findFlags("www.example-photos.com", {}, ["example-photos"]);
  assertEquals(flags.length, 1);
});

Deno.test("hasImageExtension: case-insensitive, ignores leading dots in the list", () => {
  assertEquals(hasImageExtension("IMG_0036-271x300.PNG", ["png"]), true);
  assertEquals(hasImageExtension("photo.jpeg", [".jpeg"]), true);
  assertEquals(hasImageExtension("notes.md", ["png", "jpg"]), false);
  assertEquals(hasImageExtension("README", ["png"]), false);
});

Deno.test("toImageResult: drops empty metadata, joins lines, keeps errors", () => {
  const r = toImageResult(
    {
      path: "/a.png",
      width: 400,
      height: 300,
      lines: ["the best", "FIRSTCOVERS.COM"],
      metadata: { copyright: "", artist: "  ", credit: undefined },
    },
    DEFAULT_FLAG_PATTERNS,
  );
  assertEquals(r.metadata, {});
  assertEquals(r.text, "the best\nFIRSTCOVERS.COM");
  assertEquals(r.lineCount, 2);
  assertEquals(r.flags, []);

  const e = toImageResult({ path: "/b.gif", lines: [], metadata: {}, error: "Vision failed: x" }, []);
  assertEquals(e.error, "Vision failed: x");
  assertEquals("width" in e, false);
});

Deno.test("parseRecognizeOutput: accepts one well-formed result per image", () => {
  const out = parseRecognizeOutput(
    JSON.stringify([{ path: "/a.png", width: 10, height: 10, lines: ["hi"], metadata: {} }]),
    1,
  );
  assertEquals(out[0].lines, ["hi"]);
});

Deno.test("parseRecognizeOutput: rejects non-JSON, wrong shape and wrong count", () => {
  assertThrows(() => parseRecognizeOutput("execution error: -1743", 1), Error, "non-JSON");
  assertThrows(() => parseRecognizeOutput(JSON.stringify([{ path: "/a.png" }]), 1), Error, "unexpected shape");
  assertThrows(
    () => parseRecognizeOutput(JSON.stringify([{ path: "/a.png", lines: [], metadata: {} }]), 2),
    Error,
    "1 results for 2 images",
  );
});
