import fs from "fs";
import path from "path";
import { log } from "./index";
import { fal } from "@fal-ai/client";

function ensureConfigured() {
  const key = process.env.FAL_API_KEY;
  if (!key) throw new Error("FAL_API_KEY не настроен");
  fal.config({ credentials: key });
}

export function isFalConfigured(): boolean {
  return !!process.env.FAL_API_KEY;
}

export interface FalVideoResult {
  videoUrl: string;
  localPath?: string;
  duration?: number;
}

export async function generateFalVideo(
  prompt: string,
  options: {
    imageUrl?: string;
    imagePath?: string;
    duration?: string;
    aspectRatio?: string;
    model?: string;
  } = {}
): Promise<FalVideoResult> {
  ensureConfigured();

  const model = options.model || "fal-ai/kling-video/v2.1/standard/image-to-video";
  const duration = options.duration || "5";
  const aspectRatio = options.aspectRatio || "9:16";

  let imageUrl = options.imageUrl;
  if (!imageUrl && options.imagePath) {
    imageUrl = await uploadImageToFal(options.imagePath);
  }

  log(`[fal] Starting video gen (${model}): "${prompt.substring(0, 80)}..."`, "veo");

  const input: Record<string, any> = {
    prompt,
    duration,
    aspect_ratio: aspectRatio,
  };

  if (imageUrl) {
    input.image_url = imageUrl;
  }

  const result = await fal.subscribe(model, {
    input,
    logs: true,
    onQueueUpdate: (update) => {
      if (update.status === "IN_QUEUE") {
        log(`[fal] In queue, position: ${(update as any).queue_position ?? "?"}`, "veo");
      } else if (update.status === "IN_PROGRESS") {
        log(`[fal] In progress...`, "veo");
      }
    },
  });

  const videoUrl = (result.data as any)?.video?.url;
  if (!videoUrl) {
    throw new Error(`No video URL in fal.ai result: ${JSON.stringify(result.data).slice(0, 500)}`);
  }

  log(`[fal] Video ready: ${videoUrl}`, "veo");
  return { videoUrl, duration: parseInt(duration) };
}

async function uploadImageToFal(imagePath: string): Promise<string> {
  ensureConfigured();
  const absPath = path.resolve(imagePath);

  if (!fs.existsSync(absPath)) {
    throw new Error(`Image not found: ${absPath}`);
  }

  const imageBuffer = fs.readFileSync(absPath);
  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";

  const file = new File([imageBuffer], path.basename(imagePath), { type: mimeType });
  const url = await fal.storage.upload(file);

  log(`[fal] Image uploaded: ${url}`, "veo");
  return url;
}

export async function downloadFalVideo(videoUrl: string, outputPath: string): Promise<string> {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);

  log(`[fal] Downloaded: ${outputPath} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`, "veo");
  return outputPath;
}
