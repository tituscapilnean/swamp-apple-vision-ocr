# @tituscapilnean/apple-vision-ocr

OCR local images with Apple's on-device Vision framework, read their TIFF/IPTC
copyright fields, and flag the ones that carry copyright notices or watermarks.

Built to audit a blog's image library before publishing it again. Three things
are usually worth flagging: cartoons with a "Reproduction rights obtainable
from…" line, stock photos with an agency watermark, and infographics with a
"© Company" credit.

## Requirements

macOS only. Vision runs through `osascript -l JavaScript` (JavaScript for
Automation) and its Objective-C bridge. You don't need Python, a Swift
toolchain or a network connection. Images are only read, never changed.

## Usage

```bash
swamp extension pull @tituscapilnean/apple-vision-ocr
swamp behavior create @tituscapilnean/apple-vision-ocr image-scan

swamp behavior run image-scan scan \
  --input 'paths:json=["assets/img"]' --input label=blog

# flagged paths
swamp data query 'behavior("image-scan") && name == "blog"' --select content --json \
  | jq -r '.results[0].flagged[]'
```

The `scan` method takes files and/or directories. It handles every image in
one run and writes one `scan` resource, named after `label`. That resource
holds:

- `imageCount`, `withTextCount`, `flaggedCount` and `errorCount`, plus
  `flagged`, the paths of the flagged images
- `images[]`, one entry per image: `text` (the recognized lines), `width`,
  `height`, `metadata` (copyright, artist, credit, source and byline) and
  `flags[]`. Each flag has `pattern`, `match`, `source` (text or metadata) and
  `line` (the full line that matched, so you can judge a flag without opening
  the image).

## Global arguments

| Argument | Default | Notes |
| --- | --- | --- |
| `recognitionLevel` | `accurate` | `fast` is quicker but misses small print |
| `languages` | `[]` | BCP-47, e.g. `["en-US", "ro-RO"]`; empty uses Vision's default |
| `languageCorrection` | `false` | Leave it off so URLs and watermarks are kept exactly as written |
| `flagPatterns` | built in | Case-insensitive regexes; setting this replaces the defaults |
| `extensions` | common image types | Picked up when a path is a directory |
| `batchSize` | `100` | Images per `osascript` call |

To flag a site-specific watermark as well, or to scan in Romanian too, set the
global arguments in the behavior definition. Setting `flagPatterns` replaces
the defaults, so list every pattern you want:

```yaml
globalArguments:
  languages: [en-US, ro-RO]
  flagPatterns: ["©", "copyright", "all rights reserved", "cartoonstock", "example-photos\\.com"]
```

## Flags need a person to review them

A flag means "look at this", not "this is infringing". Website screenshots
often carry a "Facebook © 2012" footer, and OCR sometimes reads a `0` as `©`.
The `line` field makes it quick to sort these out. Vision also misses faint
or stylised watermarks, so give anything you plan to republish a visual check
as well.
