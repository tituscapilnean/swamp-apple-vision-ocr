/**
 * Reads the text in local images with Apple's on-device Vision framework
 * (VNRecognizeTextRequest) and the copyright fields in their TIFF/IPTC
 * metadata, then flags images whose text or metadata matches copyright and
 * watermark patterns (©, "all rights reserved", stock agencies, cartoon
 * syndicates, meme generators, ...).
 *
 * macOS only. Vision is driven through JavaScript for Automation
 * (`osascript -l JavaScript`) and its Objective-C bridge, so nothing needs to
 * be installed: no Python, no Swift toolchain, no network.
 *
 * Read-only: images are never modified.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Patterns that suggest third-party copyright or a watermark. Case-insensitive. */
export const DEFAULT_FLAG_PATTERNS = [
  "©",
  "\\(c\\)\\s*\\d{4}",
  "copyright",
  "all rights reserved",
  "reproduction rights",
  "getty",
  "shutterstock",
  "istock",
  "dreamstime",
  "alamy",
  "123rf",
  "depositphotos",
  "fotolia",
  "adobe ?stock",
  "bigstock",
  "thinkstock",
  "corbis",
  "cartoonstock",
  "clipartof",
  "memegenerator",
  "joyoftech",
  "dilbert\\.com",
  "watermark",
];

/** File extensions scanned when a path is a directory. */
export const DEFAULT_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "heic",
  "tif",
  "tiff",
  "bmp",
];

const GlobalArgsSchema = z.object({
  recognitionLevel: z.enum(["accurate", "fast"]).default("accurate")
    .describe(
      "Vision recognition level; fast is ~5x quicker but misses small text",
    ),
  languages: z.array(z.string()).default([])
    .describe(
      "BCP-47 recognition languages in priority order, e.g. [en-US, ro-RO]; empty = Vision default",
    ),
  languageCorrection: z.boolean().default(false)
    .describe(
      "Let Vision autocorrect words; off keeps URLs and watermarks verbatim",
    ),
  flagPatterns: z.array(z.string()).default(DEFAULT_FLAG_PATTERNS)
    .describe(
      "Case-insensitive regexes; an image is flagged when its text or metadata matches one",
    ),
  extensions: z.array(z.string()).default(DEFAULT_EXTENSIONS)
    .describe("File extensions picked up when a path is a directory"),
  batchSize: z.number().int().min(1).default(100)
    .describe("Images per osascript call"),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ScanArgsSchema = z.object({
  paths: z.array(z.string()).min(1)
    .describe(
      "Image files and/or directories to scan (absolute, or relative to the repo)",
    ),
  recursive: z.boolean().default(true).describe("Descend into subdirectories"),
  label: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).default("latest")
    .describe(
      "Instance name for the result, so separate scans can be kept side by side",
    ),
});
type ScanArgs = z.infer<typeof ScanArgsSchema>;

const FlagSchema = z.object({
  pattern: z.string(),
  match: z.string(),
  source: z.enum(["text", "metadata"]),
  line: z.string().describe(
    "The full recognized line (or metadata value) containing the match",
  ),
});
type Flag = z.infer<typeof FlagSchema>;

const MetadataSchema = z.object({
  copyright: z.string().optional(),
  artist: z.string().optional(),
  credit: z.string().optional(),
  source: z.string().optional(),
  byline: z.string().optional(),
});
type Metadata = z.infer<typeof MetadataSchema>;

const ImageSchema = z.object({
  path: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  text: z.string().describe("Recognized lines joined with newlines"),
  lineCount: z.number(),
  metadata: MetadataSchema,
  flags: z.array(FlagSchema),
  error: z.string().optional(),
});
type ImageResult = z.infer<typeof ImageSchema>;

const ScanSchema = z.object({
  scannedAt: z.string(),
  paths: z.array(z.string()),
  recognitionLevel: z.string(),
  imageCount: z.number(),
  withTextCount: z.number(),
  flaggedCount: z.number(),
  errorCount: z.number(),
  flagged: z.array(z.string()).describe("Paths of flagged images"),
  images: z.array(ImageSchema),
});

/** Match text and metadata against the flag patterns; one flag per pattern and source. */
export function findFlags(
  text: string,
  metadata: Metadata,
  patterns: string[],
): Flag[] {
  const flags: Flag[] = [];
  const sources = [
    ["text", text.split("\n")],
    [
      "metadata",
      Object.values(metadata).filter((v): v is string => Boolean(v)),
    ],
  ] as const;
  for (const p of patterns) {
    const re = new RegExp(p, "iu");
    for (const [source, lines] of sources) {
      for (const line of lines) {
        const m = line.match(re);
        if (m) {
          flags.push({ pattern: p, match: m[0], source, line });
          break;
        }
      }
    }
  }
  return flags;
}

/** Whether a file name has one of the allowed extensions (case-insensitive). */
export function hasImageExtension(name: string, extensions: string[]): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = name.slice(dot + 1).toLowerCase();
  return extensions.some((e) => e.toLowerCase().replace(/^\./, "") === ext);
}

async function collectImages(
  paths: string[],
  recursive: boolean,
  extensions: string[],
  repoDir: string,
): Promise<string[]> {
  const out = new Set<string>();
  const abs = (p: string) => (p.startsWith("/") ? p : `${repoDir}/${p}`);
  async function walk(dir: string) {
    for await (const e of Deno.readDir(dir)) {
      const full = `${dir}/${e.name}`;
      if (e.isDirectory && recursive) await walk(full);
      else if (e.isFile && hasImageExtension(e.name, extensions)) out.add(full);
    }
  }
  for (const p of paths.map(abs)) {
    const st = await Deno.stat(p);
    if (st.isDirectory) await walk(p);
    else out.add(p);
  }
  return [...out].sort();
}

/**
 * JXA program run by osascript. argv[0] is a JSON file:
 * { paths, level, languages, correction }. Prints a JSON array to stdout.
 */
const JXA = String.raw`
ObjC.import('Foundation'); ObjC.import('Vision'); ObjC.import('ImageIO');
function str(v) { return v === undefined || v === null ? undefined : String(v); }
function run(argv) {
  const cfg = JSON.parse($.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, $()).js);
  const out = [];
  for (const p of cfg.paths) {
    const r = { path: p, lines: [], metadata: {} };
    try {
      const url = $.NSURL.fileURLWithPath(p);
      const src = $.CGImageSourceCreateWithURL(url, $());
      if (src) {
        const props = ObjC.deepUnwrap(ObjC.castRefToObject($.CGImageSourceCopyPropertiesAtIndex(src, 0, $()))) || {};
        r.width = props.PixelWidth; r.height = props.PixelHeight;
        const tiff = props['{TIFF}'] || {}, iptc = props['{IPTC}'] || {};
        r.metadata = {
          copyright: str(tiff.Copyright || iptc.CopyrightNotice),
          artist: str(tiff.Artist),
          credit: str(iptc.Credit),
          source: str(iptc.Source),
          byline: str(Array.isArray(iptc.Byline) ? iptc.Byline.join(', ') : iptc.Byline),
        };
      }
      const req = $.VNRecognizeTextRequest.alloc.init;
      req.recognitionLevel = cfg.level === 'fast' ? 1 : 0;
      req.usesLanguageCorrection = !!cfg.correction;
      if (cfg.languages.length) req.recognitionLanguages = $(cfg.languages);
      const handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $());
      const err = $();
      if (!handler.performRequestsError($([req]), err)) {
        r.error = 'Vision failed: ' + (err.localizedDescription ? err.localizedDescription.js : 'unknown error');
      } else {
        const res = req.results;
        for (let i = 0; i < res.count; i++) {
          r.lines.push(res.objectAtIndex(i).topCandidates(1).objectAtIndex(0).string.js);
        }
      }
    } catch (e) {
      r.error = String(e);
    }
    out.push(r);
  }
  return JSON.stringify(out);
}
`;

const RawResultSchema = z.object({
  path: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  lines: z.array(z.string()),
  metadata: z.record(z.string(), z.string().optional()),
  error: z.string().optional(),
});
type RawResult = z.infer<typeof RawResultSchema>;

/**
 * Parse and validate what the JXA program printed for one batch. Throws a
 * descriptive error when osascript produced something other than one result
 * per requested image.
 */
export function parseRecognizeOutput(
  stdout: string,
  expected: number,
): RawResult[] {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch (e) {
    throw new Error(
      `osascript returned non-JSON output (${String(e)}): ${
        stdout.slice(0, 200)
      }`,
    );
  }
  const parsed = z.array(RawResultSchema).safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `osascript returned an unexpected shape: ${
        parsed.error.message.slice(0, 300)
      }`,
    );
  }
  if (parsed.data.length !== expected) {
    throw new Error(
      `osascript returned ${parsed.data.length} results for ${expected} images`,
    );
  }
  return parsed.data;
}

async function recognize(
  paths: string[],
  g: GlobalArgs,
  signal: AbortSignal,
): Promise<RawResult[]> {
  const dir = await Deno.makeTempDir({ prefix: "apple-vision-ocr-" });
  try {
    const script = `${dir}/ocr.js`;
    const cfgFile = `${dir}/cfg.json`;
    await Deno.writeTextFile(script, JXA);
    await Deno.writeTextFile(
      cfgFile,
      JSON.stringify({
        paths,
        level: g.recognitionLevel,
        languages: g.languages,
        correction: g.languageCorrection,
      }),
    );
    // osascript is the only way to reach Vision without native deps; every argument is fixed or a temp file we wrote.
    // swamp-quality-ignore deno-command
    const { code, stdout, stderr } = await new Deno.Command("osascript", {
      args: ["-l", "JavaScript", script, cfgFile],
      stdout: "piped",
      stderr: "piped",
      signal,
    }).output();
    if (code !== 0) {
      throw new Error(
        `osascript exited ${code}: ${new TextDecoder().decode(stderr).trim()}`,
      );
    }
    return parseRecognizeOutput(new TextDecoder().decode(stdout), paths.length);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Turn one raw osascript result into the stored image record. */
export function toImageResult(raw: RawResult, patterns: string[]): ImageResult {
  const metadata = Object.fromEntries(
    Object.entries(raw.metadata ?? {}).filter(([, v]) =>
      typeof v === "string" && v.trim() !== ""
    ),
  ) as Metadata;
  const text = raw.lines.join("\n");
  return {
    path: raw.path,
    ...(raw.width ? { width: raw.width } : {}),
    ...(raw.height ? { height: raw.height } : {}),
    text,
    lineCount: raw.lines.length,
    metadata,
    flags: findFlags(text, metadata, patterns),
    ...(raw.error ? { error: raw.error } : {}),
  };
}

/** Model definition: one `scan` method that OCRs images and flags copyright marks. */
export const model = {
  type: "@tituscapilnean/apple-vision-ocr",
  version: "2026.11.02.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    scan: {
      description:
        "Recognized text, copyright metadata and copyright/watermark flags for every scanned image",
      schema: ScanSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    scan: {
      description:
        "OCR every image under the given paths with Apple Vision, read TIFF/IPTC copyright fields, and flag images matching copyright or watermark patterns",
      kind: "read",
      arguments: ScanArgsSchema,
      execute: async (
        args: ScanArgs,
        context: {
          globalArgs: GlobalArgs;
          repoDir: string;
          signal: AbortSignal;
          logger: {
            info: (m: string, p?: Record<string, unknown>) => void;
            warning: (m: string, p?: Record<string, unknown>) => void;
          };
          writeResource: (
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        if (Deno.build.os !== "darwin") {
          throw new Error(
            "apple-vision-ocr needs macOS: it uses the Vision framework through osascript",
          );
        }
        const g = context.globalArgs;
        for (const p of g.flagPatterns) new RegExp(p, "iu"); // fail fast on a bad pattern

        const files = await collectImages(
          args.paths,
          args.recursive,
          g.extensions,
          context.repoDir,
        );
        context.logger.info("Scanning {n} images ({level})", {
          n: files.length,
          level: g.recognitionLevel,
        });

        const images: ImageResult[] = [];
        for (let i = 0; i < files.length; i += g.batchSize) {
          const batch = files.slice(i, i + g.batchSize);
          for (const raw of await recognize(batch, g, context.signal)) {
            images.push(toImageResult(raw, g.flagPatterns));
          }
          context.logger.info("OCR {done}/{n}", {
            done: Math.min(i + g.batchSize, files.length),
            n: files.length,
          });
        }

        const flagged = images.filter((im) => im.flags.length > 0).map((im) =>
          im.path
        );
        const errors = images.filter((im) => im.error);
        for (const e of errors.slice(0, 5)) {
          context.logger.warning("Could not read {path}: {error}", {
            path: e.path,
            error: e.error,
          });
        }
        const handle = await context.writeResource("scan", args.label, {
          scannedAt: new Date().toISOString(),
          paths: args.paths,
          recognitionLevel: g.recognitionLevel,
          imageCount: images.length,
          withTextCount: images.filter((im) => im.lineCount > 0).length,
          flaggedCount: flagged.length,
          errorCount: errors.length,
          flagged,
          images,
        });
        context.logger.info(
          "{flagged} of {n} images flagged, {errors} unreadable",
          {
            flagged: flagged.length,
            n: images.length,
            errors: errors.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
