import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { join, basename, isAbsolute, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  extractWorkflowFromImage,
  listOutputImages,
  getOutputImage,
  uploadImageAuto,
  uploadVideoAuto,
  uploadAudioAuto,
  stageOutputAsInput,
} from "../services/image-management.js";
import { errorToToolResult } from "../utils/errors.js";

/**
 * Where get_image writes when the caller names no directory (#768).
 *
 * It used to be `process.cwd()`, which is not a location this process chose — it is
 * whatever directory the MCP client happened to launch us from. On Windows that is
 * routinely `C:\Windows\System32`, and the write died with EPERM *after* the image had
 * already been fetched. The schema had always DOCUMENTED `/tmp/comfyui-images/`; the
 * string existed nowhere in the code, and `/tmp` is not a real directory on Windows
 * anyway. `os.tmpdir()` is the platform-correct, process-writable spelling of the same
 * promise (`%LOCALAPPDATA%\Temp` on Windows, `/tmp` on Linux, `$TMPDIR` on macOS).
 *
 * Computed per call rather than at module load so a test (or a caller) that repoints
 * TMPDIR/TEMP is honoured instead of being silently pinned to the value at import time.
 *
 * `os.tmpdir()` returns %TEMP%/%TMP%/$TMPDIR verbatim, and nothing guarantees those are
 * usable as a launch-independent base. Merely `resolve()`-ing a bad one would anchor it
 * to the MCP process's cwd and land us straight back in System32, so an unqualified
 * tmpdir is not used at all: `os.homedir()` is always fully qualified and always writable
 * by us, and the whole point of this function is to name a directory that does not depend
 * on where we were launched.
 */
export function defaultImageSaveDir(): string {
  const tmp = tmpdir();
  return resolve(isFullyQualified(tmp) ? tmp : homedir(), "comfyui-images");
}

/**
 * Is this path independent of the process's current directory — INCLUDING its drive?
 *
 * `path.isAbsolute` is not that test on Windows. It answers true for `\Temp`, which is
 * DRIVE-RELATIVE: `resolve("\\Temp", …)` picks up whatever drive the cwd happens to be
 * on, so `TEMP=\Windows\System32` reproduces the very failure #768 is about on a
 * C:-launched process. Only a drive-qualified path (`C:\…`) or a UNC path
 * (`\\server\share\…`) is genuinely launch-independent.
 */
function isFullyQualified(p: string | undefined): boolean {
  if (!p) return false;
  if (process.platform !== "win32") return isAbsolute(p);
  return /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
}

/**
 * Turn the caller's `save_dir` into an ABSOLUTE destination directory.
 *
 * Omitted → the documented default. A relative value keeps its historical meaning
 * (resolved against this process's cwd — the issue asked for explicit `save_dir`
 * behaviour to be left alone) but is resolved EAGERLY, so every path this tool reports
 * back is absolute. A bare relative `savePath` echoed to an agent is unreadable
 * evidence: it names a different file depending on who reads it.
 */
/**
 * A Windows path that is "absolute" to `path.isAbsolute` but still picks up the
 * process's CURRENT DRIVE — `\out`, `/out`. `resolve()` turns it into `C:\out` or
 * `D:\out` depending on where we were launched.
 *
 * This is NOT refused. It is a legal Windows path spelling, the caller typed it, and
 * refusing a real request is its own bug — the hazard is silence, not the path. So it is
 * DISCLOSED instead: the returned `Saved to:` line is always drive-qualified, and a
 * failure message says that the drive came from this process rather than from the
 * argument.
 */
function isDriveRelative(p: string): boolean {
  return process.platform === "win32" && /^[\\/](?![\\/])/.test(p);
}

export function resolveImageSaveDir(saveDir: string | undefined): string {
  const raw = saveDir?.trim();
  if (!raw) return defaultImageSaveDir();
  return isAbsolute(raw) ? resolve(raw) : resolve(process.cwd(), raw);
}

export function registerImageManagementTools(server: McpServer): void {
  // ── get_image ────────────────────────────────────────────────────────────
  // Fetches a generated image from ComfyUI via HTTP /view.
  // Works with remote ComfyUI — no COMFYUI_PATH required.
  server.tool(
    "get_image",
    "Fetch a generated image from ComfyUI and return it as an inline image. " +
      "Video/audio outputs (e.g. a VHS_VideoCombine .mp4) are saved to save_dir " +
      "with their original extension instead of being rendered inline. " +
      "Works with remote ComfyUI instances — does not require COMFYUI_PATH. " +
      "Use get_history first to obtain the filename.",
    {
      filename: z
        .string()
        .describe("Output image filename, e.g. PulID_Klein_00001_.png"),
      type: z
        .enum(["output", "input", "temp"])
        .optional()
        .default("output")
        .describe("Image directory: output (default), input, or temp"),
      subfolder: z
        .string()
        .optional()
        .default("")
        .describe("Subfolder within the directory, if any"),
      save_dir: z
        .string()
        .optional()
        .describe(
          "Absolute local directory to save the file in. Defaults to a " +
            "'comfyui-images' folder inside the platform temp directory " +
            "(os.tmpdir()), which is created if missing. A RELATIVE value is " +
            "resolved against this MCP process's working directory, which is the " +
            "client's choice and may not be writable. On Windows a drive-less path " +
            "like \\out is resolved against this process's CURRENT DRIVE, not a drive " +
            "you chose. Prefer a fully-qualified path (C:\\... or \\\\server\\share); " +
            "the returned 'Saved to:' line always names the resolved absolute path.",
        ),
    },
    async (args) => {
      try {
        const { base64, mimeType } = await getOutputImage(
          args.filename,
          args.type ?? "output",
          args.subfolder ?? "",
          { allowMedia: true },
        );

        // The bytes are already in hand at this point. Saving them is a SEPARATE
        // operation that can fail on its own (EPERM/EACCES/ENOSPC/read-only volume),
        // and its failure says nothing about the fetch. Reporting the whole call as an
        // error there threw away a successfully retrieved image and invited a retry of
        // the fetch that could never fix the disk problem (#768) — so the save is
        // isolated and its outcome is DISCLOSED rather than allowed to fail the tool.
        //
        // RESOLUTION is inside the guarded region, not before it: `resolveImageSaveDir`
        // calls `process.cwd()` for a relative save_dir, and cwd itself throws ENOENT
        // when the launch directory has been deleted underneath us. Left outside, that
        // throw would reach the outer catch and discard the fetched image — the same
        // loss this block exists to prevent, one line earlier.
        //
        // `explicitDir` is the TRIMMED value actually used for resolution, so the
        // message can never describe a whitespace-only save_dir as a directory the
        // caller named (resolveImageSaveDir treats it as omitted).
        const explicitDir = args.save_dir?.trim() || undefined;
        const localFilename = basename(args.filename);
        let savePath: string | undefined;
        let saveError: string | undefined;
        try {
          const saveDir = resolveImageSaveDir(args.save_dir);
          savePath = join(saveDir, localFilename);
          await mkdir(saveDir, { recursive: true });
          await writeFile(savePath, Buffer.from(base64, "base64"));
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          // A default destination we can still NAME, even if resolution itself failed —
          // never a remedy the caller cannot act on.
          let fallbackDefault: string | undefined;
          try {
            fallbackDefault = defaultImageSaveDir();
          } catch {
            fallbackDefault = undefined;
          }
          saveError =
            `NOT SAVED. The image was fetched from ComfyUI successfully, but ` +
            (savePath
              ? `writing it to ${savePath} failed: ${detail}. `
              : `this process could not even work out where to put it: ${detail}. `) +
            (explicitDir
              ? `The destination came from the save_dir argument you passed ` +
                `("${explicitDir}")` +
                (!isAbsolute(explicitDir)
                  ? ` — a RELATIVE save_dir, resolved against this process's working directory`
                  : isDriveRelative(explicitDir)
                    ? ` — a DRIVE-RELATIVE save_dir, so the drive above came from this ` +
                      `process's working directory, not from your argument`
                    : "") +
                `. Retry with an absolute save_dir you can write to` +
                (fallbackDefault ? `, or omit save_dir to use the default ${fallbackDefault}.` : ".")
              : `That is the default destination${fallbackDefault ? ` (${fallbackDefault})` : ""}. ` +
                `Retry with an explicit absolute save_dir you can write to.`) +
            ` Do NOT re-run the render — the output already exists on the server.`;
        }

        // Only images render inline; video/audio are save-to-disk only (#663).
        if (!mimeType.toLowerCase().startsWith("image/")) {
          // Nothing can be handed back inline for media, so an unsaved fetch really did
          // deliver nothing — but the message still names the exact destination and a
          // remedy that works from here, instead of a bare EPERM.
          if (saveError) {
            return {
              content: [{ type: "text" as const, text: `${saveError} (${mimeType})` }],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: `Saved to: ${savePath} (${mimeType}; not rendered inline)`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: saveError
                ? `${saveError} The image itself is returned inline below.`
                : `Saved to: ${savePath}`,
            },
            {
              type: "image" as const,
              data: base64,
              mimeType,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  // ── upload_image / upload_video / upload_audio ────────────────────────────
  // HTTP-only (works for both local and remote ComfyUI via /upload/image).
  // Previous filesystem fallback was deceptive when COMFYUI_PATH auto-detected
  // an unrelated local install — files would land in the wrong tree and the
  // tool reported success while the remote ComfyUI never received them.
  // Originally diagnosed by João Lucas (github.com/joaolvivas) in
  // joaolvivas/comfyui-mcp-byjlucas@089180ad (2026-05-12).
  const registerMediaUpload = (
    name: string,
    description: string,
    autoFn: (s: string, f?: string) => Promise<{ filename: string }>,
    nodeHint: string,
  ): void => {
    server.tool(
      name,
      description,
      {
        source_path: z
          .string()
          .describe("Absolute path to the local file to upload"),
        filename: z
          .string()
          .optional()
          .describe(
            "Override the filename in ComfyUI's input/ directory. " +
              "Auto-detected from source path if omitted.",
          ),
      },
      async (args) => {
        try {
          const result = await autoFn(args.source_path, args.filename);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Uploaded via HTTP.\n\nFilename: ${result.filename}\n\n` +
                  `Use "${result.filename}" ${nodeHint}.`,
              },
            ],
          };
        } catch (err) {
          return errorToToolResult(err);
        }
      },
    );
  };

  registerMediaUpload(
    "upload_image",
    "Upload a local image file to the connected ComfyUI's input/ directory " +
      "via the HTTP /upload/image endpoint so it can be referenced in LoadImage " +
      "nodes. Works for both local and remote ComfyUI. Returns the stored " +
      "filename.",
    uploadImageAuto,
    "as the `image` input in LoadImage nodes",
  );

  registerMediaUpload(
    "upload_video",
    "Upload a local video file (.mp4, .mov, .webm, .avi, .mkv, .m4v) to the " +
      "connected ComfyUI's input/ directory via the HTTP /upload/image endpoint " +
      "for use in video-loading nodes such as VHS_LoadVideo " +
      "(ComfyUI-VideoHelperSuite). Works for both local and remote ComfyUI. " +
      "Returns the stored filename. Use upload_image for images or " +
      "upload_audio for audio.",
    uploadVideoAuto,
    "as the video file input in VHS_LoadVideo (or similar) nodes",
  );

  registerMediaUpload(
    "upload_audio",
    "Upload a local audio file (.wav, .mp3, .flac, .ogg, .m4a, .aac) to the " +
      "connected ComfyUI's input/ directory via the HTTP /upload/image endpoint " +
      "for use in audio-conditioned workflows (e.g. LoadAudio). Works for both " +
      "local and remote ComfyUI. Returns the stored filename. Use upload_image " +
      "for images or upload_video for video.",
    uploadAudioAuto,
    "as the audio file input in LoadAudio (or similar) nodes",
  );

  // ── stage_output_as_input ─────────────────────────────────────────────────
  // The correct, dir-agnostic way to pipe one pipeline stage's output into the
  // next stage's loader. Fetches the output via /view and re-registers it as an
  // input via /upload/image — never touches the filesystem, so it works with
  // custom --input-directory / --output-directory.
  server.tool(
    "stage_output_as_input",
    "Stage an EXISTING ComfyUI output (or temp/preview) as an INPUT so the next " +
      "stage's loader (LoadImage / VHS_LoadVideo / LoadAudio) can read it. This " +
      "is the CORRECT way to chain a multi-stage pipeline (e.g. Krea2 image → " +
      "LTX video → WAN extend): it fetches the output's bytes from the server " +
      "via /view and re-registers them as an input via /upload/image — the same " +
      "endpoints get_image and upload_image use. Because it goes entirely " +
      "through the server API, it works even when ComfyUI was launched with a " +
      "CUSTOM input/output directory. Do NOT instead copy the output file or " +
      "guess a filesystem `input/` path — the server's input dir may be custom " +
      "and it will reject the file (\"Invalid image file\"), wasting the render. " +
      "Pass an existing output reference ({ filename, subfolder?, type? }); the " +
      "media kind (image/video/audio) is inferred from the extension unless you " +
      "set `kind`. Returns the registered input { filename, subfolder, type: " +
      "\"input\", kind } — drop the returned `filename` straight into the " +
      "loader's image/video/audio widget.",
    {
      filename: z
        .string()
        .describe(
          "Filename of the existing output/temp asset (from get_history or list_output_images), e.g. LTX_video_00001.mp4",
        ),
      subfolder: z
        .string()
        .optional()
        .describe("Subfolder the asset currently lives in, if any"),
      type: z
        .enum(["output", "temp"])
        .optional()
        .default("output")
        .describe(
          "Source directory the asset lives in: output (default) or temp (previews)",
        ),
      kind: z
        .enum(["image", "video", "audio"])
        .optional()
        .describe(
          "Force the media kind instead of inferring it from the file extension",
        ),
      as_filename: z
        .string()
        .optional()
        .describe(
          "Override the filename it is registered under in the input/ directory (defaults to the source filename)",
        ),
    },
    async (args) => {
      try {
        const staged = await stageOutputAsInput({
          filename: args.filename,
          subfolder: args.subfolder,
          type: args.type ?? "output",
          kind: args.kind,
          asFilename: args.as_filename,
        });
        const loaderHint =
          staged.kind === "video"
            ? "the video file input in VHS_LoadVideo (or similar)"
            : staged.kind === "audio"
              ? "the audio input in LoadAudio (or similar)"
              : "the `image` input in LoadImage";
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Staged ${staged.kind} output as input via the server API.\n\n` +
                `Input filename: ${staged.filename}\n` +
                `subfolder: ${staged.subfolder || "(none)"}\n` +
                `type: ${staged.type}\n\n` +
                `Use "${staged.filename}" as ${loaderHint}.\n\n` +
                `NOTE: the open ComfyUI tab's loader dropdown was populated at page-load, ` +
                `so this just-registered input is not in it yet — call panel_refresh_nodes ` +
                `first (it re-pulls /object_info so the new file becomes selectable), THEN ` +
                `panel_set_widget the loader's widget to "${staged.filename}". ` +
                `(panel_set_widget also self-refreshes on a rejected value, so a single ` +
                `retry after panel_refresh_nodes will always accept it.)`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  // ── workflow_from_image ───────────────────────────────────────────────────
  server.tool(
    "workflow_from_image",
    "Extract embedded ComfyUI workflow metadata from a PNG file. " +
      "ComfyUI stores the full workflow (API format) and prompt data in PNG tEXt chunks. " +
      "Use this to reverse-engineer how any ComfyUI image was generated.",
    {
      image_path: z
        .string()
        .describe("Absolute path to a ComfyUI-generated PNG file"),
    },
    async (args) => {
      try {
        const result = await extractWorkflowFromImage(args.image_path);
        const sections: string[] = [];
        if (result.prompt) {
          sections.push(
            "## API Format (prompt)\n\nThis is the executable workflow format:\n```json\n" +
              JSON.stringify(result.prompt, null, 2) +
              "\n```",
          );
        }
        if (result.workflow) {
          sections.push(
            "## UI Format (workflow)\n\nThis is the ComfyUI web UI format with layout data:\n```json\n" +
              JSON.stringify(result.workflow, null, 2) +
              "\n```",
          );
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `# Workflow extracted from ${args.image_path}\n\n${sections.join("\n\n")}`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  // ── list_output_images ────────────────────────────────────────────────────
  server.tool(
    "list_output_images",
    "List recently generated image AND video files from ComfyUI's output/ directory, newest-first, with each file's kind ('image' | 'video'), subfolder, size, and modification time. Covers stills (.png/.jpg/.jpeg/.bmp) and video/animation outputs (.mp4/.webm/.mov/.mkv/.m4v/.avi/.gif/.webp). LOCAL ComfyUI (COMFYUI_PATH set): a RECURSIVE filesystem scan of output/ — includes subfolders like video/ that VHS/SaveVideo write to, and reports size + modification time. REMOTE ComfyUI: derives the list from /history over HTTP instead (size/modified are unavailable and omitted). It does NOT return the media bytes themselves — fetch those with get_image. USE THIS TO CONFIRM A VIDEO RENDER (e.g. VHS_VideoCombine / LTX / WAN output) when get_history shows the prompt done but lists no output: VHS-style video nodes write the file but often do NOT register in ComfyUI's /history, so the local filesystem scan is the reliable way to verify the .mp4 exists — then chain it with stage_output_as_input. Read-only.",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max images to return (default: 20)"),
      pattern: z
        .string()
        .optional()
        .describe("Filter by filename pattern (case-insensitive substring match)"),
      format: z
        .enum(["markdown", "json"])
        .optional()
        .describe("Response shape: markdown (default, human/agent-readable) or json ({images:[{filename,subfolder,kind,size,modified}]} — for app clients building pick grids)."),
    },
    async (args) => {
      try {
        const images = await listOutputImages({
          limit: args.limit,
          pattern: args.pattern,
        });
        if (args.format === "json") {
          // Machine-readable form for app clients (the mobile dataset picker):
          // same entries, no prose. Thumbs render client-side via /view URLs.
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  images: images.map((img) => ({
                    filename: img.filename,
                    subfolder: img.subfolder,
                    kind: img.kind,
                    ...(img.size > 0 ? { size: img.size } : {}),
                    ...(img.modified ? { modified: img.modified } : {}),
                  })),
                }),
              },
            ],
          };
        }
        if (images.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: args.pattern
                  ? `No output media (images or videos) found matching "${args.pattern}".`
                  : "No output media (images or videos) found.",
              },
            ],
          };
        }
        const lines = images.map((img, i) => {
          const loc = img.subfolder ? `${img.subfolder}/${img.filename}` : img.filename;
          const sub = img.subfolder ? ` _(subfolder: ${img.subfolder})_` : "";
          // Size/modified are only available on the local filesystem scan; the
          // remote (history-derived) path leaves them as 0 / "" — omit them then.
          const sizePart = img.size > 0 ? ` (${(img.size / 1024 / 1024).toFixed(1)} MB)` : "";
          const datePart = img.modified
            ? ` — ${new Date(img.modified).toLocaleString()}`
            : "";
          return `${i + 1}. **${loc}** [${img.kind}]${sizePart}${datePart}${sub}`;
        });
        const videoCount = images.filter((img) => img.kind === "video").length;
        const summary =
          videoCount > 0
            ? `Found ${images.length} media file(s) (${videoCount} video):`
            : `Found ${images.length} media file(s):`;
        return {
          content: [
            {
              type: "text" as const,
              text: `${summary}\n\n${lines.join("\n")}`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
