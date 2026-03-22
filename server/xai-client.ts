import fs from "fs";
import path from "path";
import { log } from "./index";

const XAI_API_URL = "https://api.x.ai/v1";

function getApiKey(): string {
  const key = process.env.XAI_API_KEY;
  if (!key) throw new Error("XAI_API_KEY не настроен");
  return key;
}

export function isXaiConfigured(): boolean {
  return !!process.env.XAI_API_KEY;
}

export interface XaiVideoResult {
  videoUrl: string;
  duration?: number;
  costUsd?: number;
  revisedPrompt?: string;
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function generateVideo(prompt: string, aspectRatio: string = "9:16"): Promise<XaiVideoResult> {
  const apiKey = getApiKey();

  log(`[xai] Starting video generation (${aspectRatio}): "${prompt.substring(0, 80)}..."`, "xai");

  const body: Record<string, any> = {
    model: "grok-imagine-video",
    prompt,
    response_format: "url",
  };
  if (aspectRatio && aspectRatio !== "auto") {
    body.aspect_ratio = aspectRatio;
  }

  const resp = await fetch(`${XAI_API_URL}/videos/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    log(`[xai] Video generation error (${resp.status}): ${text}`, "xai");
    throw new Error(`xAI API error (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  log(`[xai] Video generation response: ${JSON.stringify(data).substring(0, 300)}`, "xai");

  if (data.data && data.data[0]?.url) {
    return {
      videoUrl: data.data[0].url,
      revisedPrompt: data.data[0].revised_prompt,
    };
  }

  if (data.request_id) {
    log(`[xai] Async generation, polling request_id: ${data.request_id}`, "xai");
    return await pollVideoResult(data.request_id, apiKey);
  }

  if (data.video?.url) {
    return {
      videoUrl: data.video.url,
      duration: data.video.duration,
      costUsd: data.usage?.cost_in_usd_ticks ? data.usage.cost_in_usd_ticks / 10000000000 : undefined,
    };
  }

  throw new Error("xAI: unexpected response format: " + JSON.stringify(data).substring(0, 200));
}

async function pollVideoResult(requestId: string, apiKey: string, maxAttempts = 120): Promise<XaiVideoResult> {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(3000);

    const resp = await fetch(`${XAI_API_URL}/videos/${requestId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!resp.ok) {
      if (resp.status === 404) {
        log(`[xai] Poll ${i + 1}: not found yet, retrying...`, "xai");
        continue;
      }
      const text = await resp.text();
      throw new Error(`xAI poll error (${resp.status}): ${text}`);
    }

    const data = await resp.json();

    if (data.status === "done" && data.video?.url) {
      const costUsd = data.usage?.cost_in_usd_ticks ? data.usage.cost_in_usd_ticks / 10000000000 : undefined;
      log(`[xai] Video ready! Duration: ${data.video.duration}s, Cost: $${costUsd?.toFixed(2) ?? 'unknown'}`, "xai");
      return {
        videoUrl: data.video.url,
        duration: data.video.duration,
        costUsd,
      };
    }

    if (data.status === "failed" || data.status === "error") {
      throw new Error(`xAI generation failed: ${JSON.stringify(data)}`);
    }

    if (i % 10 === 0) {
      log(`[xai] Poll ${i + 1}/${maxAttempts}: status=${data.status || 'pending'}`, "xai");
    }
  }

  throw new Error("xAI: video generation timed out after polling");
}

export async function downloadVideo(url: string, outputDir: string, filename: string): Promise<string> {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = path.join(outputDir, filename);
  log(`[xai] Downloading video to ${outputPath}`, "xai");

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to download video: ${resp.status}`);
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);

  log(`[xai] Downloaded video: ${outputPath} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`, "xai");
  return outputPath;
}

export async function getXaiBalance(): Promise<{ balance?: number; error?: string }> {
  try {
    const apiKey = getApiKey();
    const resp = await fetch(`${XAI_API_URL}/api-key`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
    if (!resp.ok) return { error: `HTTP ${resp.status}` };
    const data = await resp.json();
    return { balance: data.remaining_balance ?? data.balance };
  } catch (err: any) {
    return { error: err.message };
  }
}
