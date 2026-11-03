/**
 * Unit tests for the pure helpers in apple_vision_ocr.ts. The text samples are
 * real OCR output from the 2026-11 blog image review.
 *
 * @module
 */
import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.13";
import {
  DEFAULT_FLAG_PATTERNS,
  deps,
  findFlags,
  hasImageExtension,
  model,
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

// ---- scan() end to end, with osascript stubbed ----------------------------

type Written = { spec: string; name: string; data: Record<string, unknown> };

function fakeContext(repoDir: string, written: Written[]) {
  const noop = () => {};
  return {
    globalArgs: model.globalArguments.parse({ batchSize: 2 }),
    repoDir,
    signal: new AbortController().signal,
    logger: { info: noop, warning: noop },
    writeResource: (spec: string, name: string, data: Record<string, unknown>) => {
      written.push({ spec, name, data });
      return Promise.resolve({ name });
    },
  };
}

async function withStubs<T>(
  stub: (paths: string[]) => { code: number; stdout: string; stderr: string },
  fn: () => Promise<T>,
): Promise<T> {
  const orig = { ...deps };
  deps.platform = () => "darwin";
  deps.runOsascript = async (args: string[]) => {
    const cfg = JSON.parse(await Deno.readTextFile(args[3])) as { paths: string[] };
    return stub(cfg.paths);
  };
  try {
    return await fn();
  } finally {
    Object.assign(deps, orig);
  }
}

Deno.test("scan: walks directories, batches, flags and writes one resource", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/sub`);
    for (const f of ["a.png", "b.JPG", "sub/c.gif", "notes.txt"]) await Deno.writeTextFile(`${dir}/${f}`, "x");
    const calls: string[][] = [];
    const written: Written[] = [];
    await withStubs(
      (paths) => {
        calls.push(paths);
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify(paths.map((p) => ({
            path: p,
            width: 10,
            height: 10,
            lines: p.endsWith("a.png") ? ["© Getty Images"] : [],
            metadata: p.endsWith("c.gif") ? { copyright: "Copyright 2014 Jane Doe" } : {},
          }))),
        };
      },
      () => model.methods.scan.execute({ paths: [dir], recursive: true, label: "t" }, fakeContext(dir, written)),
    );
    assertEquals(calls.map((c) => c.length), [2, 1]); // 3 images, batchSize 2; notes.txt skipped
    assertEquals(written.length, 1);
    const data = written[0].data as { imageCount: number; flaggedCount: number; flagged: string[] };
    assertEquals([written[0].spec, written[0].name], ["scan", "t"]);
    assertEquals(data.imageCount, 3);
    assertEquals(data.flagged.map((p) => p.slice(dir.length)), ["/a.png", "/sub/c.gif"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scan: an osascript failure throws and writes nothing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/a.png`, "x");
    const written: Written[] = [];
    await withStubs(
      () => ({ code: 1, stdout: "", stderr: "execution error: Not authorized (-1743)" }),
      () =>
        assertRejects(
          () => model.methods.scan.execute({ paths: [dir], recursive: true, label: "t" }, fakeContext(dir, written)),
          Error,
          "osascript exited 1",
        ),
    );
    assertEquals(written.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scan: refuses to run off macOS", async () => {
  const orig = deps.platform;
  deps.platform = () => "linux";
  try {
    await assertRejects(
      () => model.methods.scan.execute({ paths: ["."], recursive: true, label: "t" }, fakeContext(".", [])),
      Error,
      "needs macOS",
    );
  } finally {
    deps.platform = orig;
  }
});
