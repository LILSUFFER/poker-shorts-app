import fs from "fs";
import path from "path";
import { log } from "./index";

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta";

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY не настроен");
  return key;
}

export function isVeoConfigured(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

export interface VeoVideoResult {
  videoUrl: string;
  localPath?: string;
  duration?: number;
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function generateVeoVideo(
  prompt: string,
  options: {
    model?: string;
    aspectRatio?: string;
    imageBase64?: string;
    imageMimeType?: string;
  } = {}
): Promise<VeoVideoResult> {
  const apiKey = getApiKey();
  const model = options.model || "veo-2.0-generate-001";
  const aspectRatio = options.aspectRatio || "9:16";

  log(`[veo] Starting video generation (${model}, ${aspectRatio}): "${prompt.substring(0, 80)}..."`, "veo");

  const isVeo3 = model.startsWith("veo-3");
  const requestBody: Record<string, any> = {
    instances: [{
      prompt,
    }],
  };

  if (isVeo3) {
    requestBody.instances[0].aspectRatio = aspectRatio;
  } else {
    requestBody.config = {
      aspectRatio,
      numberOfVideos: 1,
    };
  }

  if (options.imageBase64 && options.imageMimeType) {
    requestBody.instances[0].image = {
      bytesBase64Encoded: options.imageBase64,
      mimeType: options.imageMimeType,
    };
    log(`[veo] Image-to-video mode, image size: ${(options.imageBase64.length * 0.75 / 1024).toFixed(0)}KB`, "veo");
  }

  const resp = await fetch(
    `${GEMINI_API_URL}/models/${model}:predictLongRunning?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    log(`[veo] Generation error (${resp.status}): ${text}`, "veo");
    throw new Error(`Veo API error (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  const operationName = data.name;

  if (!operationName) {
    throw new Error("Veo: no operation name in response: " + JSON.stringify(data).substring(0, 300));
  }

  log(`[veo] Operation started: ${operationName}`, "veo");
  return await pollVeoOperation(operationName, apiKey);
}

async function pollVeoOperation(operationName: string, apiKey: string, maxAttempts = 120): Promise<VeoVideoResult> {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(5000);

    const resp = await fetch(
      `${GEMINI_API_URL}/${operationName}?key=${apiKey}`,
      { headers: { "Content-Type": "application/json" } }
    );

    if (!resp.ok) {
      const text = await resp.text();
      if (resp.status === 404 && i < 5) {
        log(`[veo] Poll ${i + 1}: operation not found yet, retrying...`, "veo");
        continue;
      }
      throw new Error(`Veo poll error (${resp.status}): ${text}`);
    }

    const data = await resp.json();

    if (data.done) {
      const response = data.response;
      if (response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri) {
        const videoUri = response.generateVideoResponse.generatedSamples[0].video.uri;
        log(`[veo] Video ready! URI: ${videoUri.substring(0, 100)}...`, "veo");
        return { videoUrl: videoUri };
      }

      if (response?.error) {
        throw new Error(`Veo generation failed: ${JSON.stringify(response.error)}`);
      }

      throw new Error("Veo: done but no video in response: " + JSON.stringify(data).substring(0, 500));
    }

    if (data.error) {
      throw new Error(`Veo operation error: ${JSON.stringify(data.error)}`);
    }

    if (i % 6 === 0) {
      const progress = data.metadata?.progress || "unknown";
      log(`[veo] Poll ${i + 1}/${maxAttempts}: status=processing, progress=${progress}`, "veo");
    }
  }

  throw new Error("Veo: video generation timed out after polling");
}

export async function downloadVeoVideo(videoUri: string, outputDir: string, filename: string): Promise<string> {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = path.join(outputDir, filename);
  const apiKey = getApiKey();

  const downloadUrl = videoUri.includes("?") ? `${videoUri}&key=${apiKey}` : `${videoUri}?key=${apiKey}`;

  log(`[veo] Downloading video to ${outputPath}`, "veo");

  const resp = await fetch(downloadUrl, {
    headers: { "x-goog-api-key": apiKey },
    redirect: "follow",
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to download Veo video (${resp.status}): ${text.substring(0, 200)}`);
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);

  log(`[veo] Downloaded video: ${outputPath} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`, "veo");
  return outputPath;
}

export async function listVeoModels(): Promise<string[]> {
  const apiKey = getApiKey();
  const resp = await fetch(`${GEMINI_API_URL}/models?key=${apiKey}`);
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data.models || [])
    .filter((m: any) => m.name.includes("veo"))
    .map((m: any) => m.name.replace("models/", ""));
}
