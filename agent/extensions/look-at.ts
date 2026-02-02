import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"]);
const PDF_EXTS = new Set([".pdf"]);

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 8;
const PREVIEW_SIZE = 1024;
const DEFAULT_FRAME_COUNT = 4;

function commandExists(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_QLMANAGE = process.platform === "darwin" && commandExists("qlmanage");
const HAS_FFMPEG = commandExists("ffmpeg");

function resolvePath(inputPath: string, cwd: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
}

function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    default:
      return "application/octet-stream";
  }
}

function readImageFile(filePath: string, mimeOverride?: string): ImageContent {
  const buffer = fs.readFileSync(filePath);
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image too large (${Math.round(buffer.byteLength / 1024 / 1024)}MB).`
    );
  }
  return {
    type: "image",
    data: buffer.toString("base64"),
    mimeType: mimeOverride ?? guessMimeType(filePath),
  };
}

function safeRmdir(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function collectPreviewFiles(dirPath: string): string[] {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    return [];
  }
  return entries
    .filter(
      (f) => f.endsWith(".png") || f.endsWith(".jpg") || f.endsWith(".jpeg")
    )
    .sort()
    .map((f) => path.join(dirPath, f));
}

function readPreviewImages(dirPath: string, notes: string[]): ImageContent[] {
  const images: ImageContent[] = [];
  for (const filePath of collectPreviewFiles(dirPath)) {
    try {
      images.push(readImageFile(filePath));
    } catch (err) {
      notes.push(
        `Skipped preview ${path.basename(filePath)}: ${(err as Error).message}`
      );
    }
  }
  return images;
}

function renderQuickLook(inputPath: string, notes: string[]): ImageContent[] {
  if (!HAS_QLMANAGE) return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-look-at-"));
  try {
    execFileSync(
      "qlmanage",
      ["-t", "-s", String(PREVIEW_SIZE), "-o", dir, inputPath],
      {
        stdio: "ignore",
      }
    );
    return readPreviewImages(dir, notes);
  } finally {
    safeRmdir(dir);
  }
}

function getVideoFramesWithFfmpeg(
  inputPath: string,
  frameCount: number,
  notes: string[]
): ImageContent[] {
  if (!HAS_FFMPEG) return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-look-at-"));
  const pattern = path.join(dir, "frame-%02d.jpg");
  try {
    execFileSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        inputPath,
        "-vf",
        `fps=1,scale=${PREVIEW_SIZE}:-1`,
        "-frames:v",
        String(frameCount),
        pattern,
      ],
      { stdio: "ignore" }
    );
    return readPreviewImages(dir, notes);
  } finally {
    safeRmdir(dir);
  }
}

function getImagesForFile(
  filePath: string,
  notes: string[]
): { images: ImageContent[]; kind: string } {
  const ext = path.extname(filePath).toLowerCase();
  const images: ImageContent[] = [];

  if (IMAGE_EXTS.has(ext)) {
    try {
      images.push(readImageFile(filePath));
      return { images, kind: "image" };
    } catch {
      notes.push(
        `Image too large or unreadable (${path.basename(filePath)}). Trying preview.`
      );
    }
  }

  if (VIDEO_EXTS.has(ext)) {
    const frames = getVideoFramesWithFfmpeg(
      filePath,
      DEFAULT_FRAME_COUNT,
      notes
    );
    if (frames.length > 0) {
      return { images: frames, kind: "video" };
    }
  }

  if (PDF_EXTS.has(ext) || VIDEO_EXTS.has(ext) || IMAGE_EXTS.has(ext)) {
    const previews = renderQuickLook(filePath, notes);
    if (previews.length > 0) {
      return { images: previews, kind: PDF_EXTS.has(ext) ? "pdf" : "preview" };
    }
  }

  if (!IMAGE_EXTS.has(ext) && !VIDEO_EXTS.has(ext) && !PDF_EXTS.has(ext)) {
    const previews = renderQuickLook(filePath, notes);
    if (previews.length > 0) {
      return { images: previews, kind: "preview" };
    }
  }

  return { images, kind: "unknown" };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "look_at",
    label: "Look At",
    description:
      "Extract specific information from a local file (including PDFs, images, and other media). " +
      "Use this tool when you need analysis instead of literal file contents. " +
      "Provide a clear objective and context.",
    parameters: Type.Object({
      path: Type.String({
        description:
          "Workspace-relative or absolute path to the file to analyze.",
      }),
      objective: Type.String({
        description:
          "Natural-language description of the analysis goal (e.g., summarize, extract data, describe image).",
      }),
      context: Type.String({
        description:
          "Broader goal and context for the analysis (background on why this is needed).",
      }),
      referenceFiles: Type.Optional(
        Type.Array(
          Type.String({
            description: "Optional reference file paths for comparison.",
          })
        )
      ),
    }),

    async execute(_toolCallId, params, signal = undefined, _onUpdate, ctx) {
      const { path: rawPath, referenceFiles } = params as {
        path: string;
        objective: string;
        context: string;
        referenceFiles?: string[];
      };

      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Canceled." }],
          details: { ok: false, reason: "canceled" },
          isError: true,
        };
      }

      const primaryPath = resolvePath(rawPath, ctx.cwd);
      const refs = (referenceFiles ?? []).map((ref) =>
        resolvePath(ref, ctx.cwd)
      );
      const allFiles = [primaryPath, ...refs];
      const missing = allFiles.filter((p) => !fs.existsSync(p));

      if (missing.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `Missing file(s): ${missing.join(", ")}`,
            },
          ],
          details: { ok: false, missing },
          isError: true,
        };
      }

      const notes: string[] = [];
      const images: ImageContent[] = [];
      const order: string[] = [];

      for (const filePath of allFiles) {
        if (images.length >= MAX_IMAGES) break;
        const { images: fileImages, kind } = getImagesForFile(filePath, notes);
        if (fileImages.length === 0) {
          notes.push(
            `No preview images extracted for ${path.basename(filePath)}.`
          );
          continue;
        }
        const remaining = MAX_IMAGES - images.length;
        const selected = fileImages.slice(0, remaining);
        images.push(...selected);
        order.push(`${path.basename(filePath)} (${kind}) x${selected.length}`);
      }

      if (images.length === 0) {
        const fallback =
          HAS_FFMPEG || HAS_QLMANAGE
            ? ""
            : " (install ffmpeg or enable macOS QuickLook)";
        return {
          content: [
            {
              type: "text",
              text: `Unable to generate previews${fallback}.`,
            },
          ],
          details: { ok: false, reason: "no_previews", notes },
          isError: true,
        };
      }

      const textLines: string[] = [];
      textLines.push(`look_at: ${path.basename(primaryPath)}`);
      if (refs.length > 0) {
        textLines.push(
          `references: ${refs.map((r) => path.basename(r)).join(", ")}`
        );
      }
      textLines.push(`attached images: ${images.length}`);
      if (order.length > 0) textLines.push(`order: ${order.join("; ")}`);
      if (notes.length > 0) textLines.push(`notes: ${notes.join(" | ")}`);

      const content: Array<TextContent | ImageContent> = [
        { type: "text", text: textLines.join("\n") },
        ...images,
      ];

      return {
        content,
        details: {
          path: primaryPath,
          referenceFiles: refs,
          imageCount: images.length,
        },
      };
    },

    renderCall(args, theme) {
      const { path: rawPath, referenceFiles } = args as {
        path?: string;
        referenceFiles?: string[];
      };
      const refs = referenceFiles?.length
        ? ` (+${referenceFiles.length} refs)`
        : "";
      return new Text(
        theme.fg("toolTitle", "look_at ") +
          theme.fg("accent", `${rawPath ?? "..."}${refs}`),
        0,
        0
      );
    },

    renderResult(result, { expanded }, theme) {
      const text =
        result.content?.[0]?.type === "text"
          ? (result.content[0] as { text: string }).text
          : "";
      if (!expanded) {
        const first = text.split("\n")[0] || "(no output)";
        return new Text(theme.fg("muted", first), 0, 0);
      }
      return new Text(theme.fg("toolOutput", text || "(no output)"), 0, 0);
    },
  });
}
