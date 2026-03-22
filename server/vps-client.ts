import fs from "fs";
import path from "path";
import { Agent, fetch as undiciFetch } from "undici";

let _log: ((message: string, source?: string) => void) | null = null;
function log(message: string, source = "vps-client") {
  if (!_log) {
    try {
      _log = require("./index").log;
    } catch {
      _log = (msg: string, src?: string) => console.log(`[${src || "vps-client"}] ${msg}`);
    }
  }
  _log!(message, source);
}

const longTimeoutAgent = new Agent({
  headersTimeout: 900_000,
  bodyTimeout: 900_000,
  connectTimeout: 30_000,
});

function normalizeVpsUrl(raw: string): string {
  if (!raw) return "";
  let url = raw;
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `http://${url}`;
  }
  if (url.startsWith("http://") && !/:\d+/.test(url.replace(/^http:\/\//, ""))) {
    url = `${url}:8787`;
  }
  return url;
}

const VPS_URL = normalizeVpsUrl(process.env.VPS_URL || "");
const VPS_TOKEN = process.env.VPS_TOKEN || "";

function authHeaders(): Record<string, string> {
  return { "Authorization": `Bearer ${VPS_TOKEN}` };
}

export function isVpsConfigured(): boolean {
  return !!(VPS_URL && VPS_TOKEN);
}

async function vpsRequest(endpoint: string, options: RequestInit = {}, timeoutMs = 120000): Promise<Response> {
  const url = `${VPS_URL}${endpoint}`;
  let response: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const fetchOptions: any = {
      ...options,
      signal: controller.signal,
      headers: {
        ...authHeaders(),
        ...(options.headers || {}),
      },
      dispatcher: longTimeoutAgent,
    };
    response = await undiciFetch(url, fetchOptions) as unknown as Response;
  } catch (err: any) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new Error(`VPS таймаут (${timeoutMs / 1000}с): ${endpoint}`);
    }
    const cause = err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : "";
    throw new Error(`VPS недоступен: ${url}${cause}`);
  }
  clearTimeout(timer);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`VPS ${endpoint} ошибка (${response.status}): ${body}`);
  }
  return response;
}

export async function vpsJson<T = any>(endpoint: string, body?: any, timeoutMs?: number): Promise<T> {
  const options: RequestInit = { method: "POST" };
  if (body) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }
  const response = await vpsRequest(endpoint, options, timeoutMs);
  return response.json() as Promise<T>;
}

export interface VpsProbeResult {
  duration: number;
  width: number;
  height: number;
  codec: string | null;
  fps: string | null;
  hasAudio: boolean;
  fileSize: number;
  audioStartTime?: number;
  videoStartTime?: number;
  audioOffset?: number;
}

export async function vpsProbe(videoId: string): Promise<VpsProbeResult> {
  log(`VPS ffprobe: ${videoId}`, "vps-client");
  return vpsJson<VpsProbeResult>(`/ffprobe/${videoId}`);
}

export async function vpsRemux(videoId: string): Promise<{ status: string; size: number }> {
  log(`VPS remux (faststart): ${videoId}`, "vps-client");
  return vpsJson(`/remux/${videoId}`, undefined, 600000);
}

export async function vpsRegeneratePreview(videoId: string): Promise<{ status: string }> {
  log(`VPS regenerate preview: ${videoId}`, "vps-client");
  return vpsJson(`/preview/${videoId}/regenerate`, undefined, 30000);
}

export async function vpsStopPreview(videoId: string): Promise<{ status: string }> {
  log(`VPS stop preview: ${videoId}`, "vps-client");
  return vpsJson(`/preview/${videoId}/stop`, undefined, 10000);
}

export function getVpsUrl(): string {
  return VPS_URL;
}

export function getVpsToken(): string {
  return VPS_TOKEN;
}

export async function vpsExtractAudio(videoId: string): Promise<{ duration: number; sizeBytes: number }> {
  log(`VPS extract audio: ${videoId}`, "vps-client");
  return vpsJson(`/audio/extract/${videoId}`, undefined, 600000);
}

interface ChunkInfo {
  index: number;
  filename: string;
  startTime: number;
  endTime: number;
  sizeBytes: number;
}

export async function vpsPrepareAudioMp3(videoId: string): Promise<{ cached: boolean; sizeBytes: number }> {
  log(`VPS prepare audio MP3: ${videoId}`, "vps-client");
  const result = await vpsJson(`/audio/prepare-mp3/${videoId}`, {}, 300000) as { cached: boolean; sizeBytes: number };
  log(`VPS audio MP3 ready: ${videoId} (${(result.sizeBytes / 1024 / 1024).toFixed(1)}MB, cached=${result.cached})`, "vps-client");
  return result;
}

export async function vpsGetAudioToken(videoId: string): Promise<{ token: string; audioUrl: string }> {
  log(`VPS get audio token: ${videoId}`, "vps-client");
  const result = await vpsJson(`/audio/token/${videoId}`, {}, 30000) as { token: string };
  const vpsUrl = process.env.VPS_URL || "";
  const audioUrl = `${vpsUrl}/audio/public/${result.token}`;
  return { token: result.token, audioUrl };
}

export async function vpsCreateChunks(videoId: string, segmentDuration = 15): Promise<{ totalDuration: number; chunks: ChunkInfo[] }> {
  log(`VPS create audio chunks: ${videoId} (${segmentDuration}s segments)`, "vps-client");
  return vpsJson(`/audio/chunks/${videoId}`, { segmentDuration }, 1800000);
}

export async function vpsCreateVadChunks(videoId: string): Promise<{ totalDuration: number; silenceRegions: number; chunks: ChunkInfo[] }> {
  log(`VPS create VAD chunks: ${videoId}`, "vps-client");
  return vpsJson(`/audio/vad-chunks/${videoId}`, { minSilenceDuration: 0.5, silenceThreshold: "-35dB", maxChunkDuration: 25 }, 600000);
}

export async function vpsForceAlign(videoId: string, segments: { text: string; start: number; end: number }[]): Promise<{ segments: { start: number; end: number; text: string; words: { word: string; start: number; end: number; score: number }[] }[] }> {
  log(`VPS forced alignment: ${videoId} (${segments.length} segments)`, "vps-client");
  return vpsJson(`/align/${videoId}`, { segments }, 1800000);
}

export async function vpsDownloadVadChunk(videoId: string, filename: string): Promise<Buffer> {
  const response = await vpsRequest(`/audio/vad-chunk/${videoId}/${filename}`, { method: "GET" });
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function vpsExtractClipAudio(videoId: string, startTime: number, endTime: number): Promise<Buffer> {
  log(`VPS extract clip audio: ${videoId} (${startTime}-${endTime}s)`, "vps-client");
  const response = await vpsRequest(`/audio/clip/${videoId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ startTime, endTime }),
  }, 60000);
  // Race body read against a timeout (vpsRequest only times out header receipt)
  const arrayBuffer = await Promise.race<ArrayBuffer>([
    response.arrayBuffer(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`VPS audio body timeout for ${videoId}`)), 60000)),
  ]);
  return Buffer.from(arrayBuffer);
}

export async function vpsAlignClip(
  videoId: string,
  startTime: number,
  endTime: number,
  segments: Array<{ start: number; end: number; text: string }>
): Promise<Array<{ start: number; end: number; text: string; words: Array<{ word: string; start: number; end: number; score?: number }> }>> {
  log(`VPS align clip: ${videoId} (${startTime}-${endTime}s, ${segments.length} segments)`, "vps-client");
  const response = await vpsRequest(`/align/clip/${videoId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ startTime, endTime, segments }),
  }, 300000);
  const data = await response.json() as any;
  return data.segments || [];
}

export async function vpsDownloadFullAudio(videoId: string): Promise<Buffer> {
  log(`VPS download full audio: ${videoId}`, "vps-client");
  const response = await vpsRequest(`/audio/full/${videoId}`, { method: "GET" });
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function vpsDownloadChunk(videoId: string, filename: string): Promise<Buffer> {
  const response = await vpsRequest(`/audio/chunk/${videoId}/${filename}`, { method: "GET" });
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function vpsExtractFrame(videoId: string, timeSeconds: number, outputPath: string): Promise<void> {
  log(`VPS extract frame: ${videoId} @ ${timeSeconds}s`, "vps-client");
  const response = await vpsRequest(`/frame/${videoId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ time: timeSeconds }),
  });

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(arrayBuffer));
}

export async function vpsGenerateThumbnail(videoId: string, duration: number, outputPath: string): Promise<void> {
  log(`VPS thumbnail: ${videoId}`, "vps-client");
  const response = await vpsRequest(`/thumbnail/${videoId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ duration }),
  });

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(arrayBuffer));
}

export async function vpsGenerateClipThumbnail(
  videoId: string,
  startTime: number,
  endTime: number,
  calibration: any,
  contentType?: string,
  text?: string,
  frameTime?: number
): Promise<Buffer> {
  log(`VPS clip-thumbnail: ${videoId} (${startTime}-${endTime}s)`, "vps-client");
  const response = await vpsRequest(`/clip-thumbnail/${videoId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ startTime, endTime, calibration, contentType, text, frameTime }),
  });
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

interface VpsExportOptions {
  videoId: string;
  startTime: number;
  endTime: number;
  calibration: any;
  clipId?: string;
  subtitleSegments?: Array<{ start: number; end: number; text: string }>;
  subtitlesEnabled?: boolean;
  isPreview?: boolean;
  muteAudio?: boolean;
  bleepProfanity?: boolean;
  aspectRatio?: string;
  useOverlay?: boolean;
  contentType?: string;
  uniqualize?: boolean;
  filterPreset?: "subtle" | "medium" | "strong";
  resolution?: string;
  crawlText?: string;
  bgAudioFilename?: string;
  bgAudioVolume?: number;
  musicStartOffset?: number;
  voiceVolume?: number;
  musicDropTime?: number;
  musicDropVolumeBefore?: number;
  captionPositionY?: number;
  captionStyle?: string;
  renderEngine?: "vps" | "runpod";
  videoFilter?: string;
  subtitleOffsetMs?: number;
  cameraKeyframes?: Array<{ time: number; cropX: number; cropY: number; cropW: number; cropH: number; target: string; cut?: boolean; transitionDuration?: number }>;
}

export async function vpsExport(options: VpsExportOptions): Promise<{ exportId: string; sizeBytes: number }> {
  log(`VPS export${options.isPreview ? " (preview)" : ""}: ${options.videoId} (${options.startTime}-${options.endTime}s), aspectRatio=${options.aspectRatio || "9:16"}, resolution=${options.resolution || "1080p"}`, "vps-client");
  const gpuTimeout = 3600000;
  const exportTimeoutMs = options.isPreview ? 180000 : (options.renderEngine === "runpod" ? gpuTimeout : (options.resolution === "4k" ? 1200000 : 600000));
  return vpsJson(`/export/${options.videoId}`, {
    startTime: options.startTime,
    endTime: options.endTime,
    calibration: options.calibration,
    clipId: options.clipId,
    subtitleSegments: options.subtitleSegments,
    subtitlesEnabled: options.subtitlesEnabled,
    isPreview: options.isPreview,
    muteAudio: options.muteAudio,
    bleepProfanity: options.bleepProfanity,
    aspectRatio: options.aspectRatio || "9:16",
    useOverlay: options.useOverlay,
    contentType: options.contentType,
    uniqualize: options.uniqualize,
    filterPreset: options.filterPreset,
    resolution: options.resolution,
    crawlText: options.crawlText,
    bgAudioFilename: options.bgAudioFilename,
    bgAudioVolume: options.bgAudioVolume,
    musicStartOffset: options.musicStartOffset,
    voiceVolume: options.voiceVolume,
    musicDropTime: options.musicDropTime,
    musicDropVolumeBefore: options.musicDropVolumeBefore,
    captionPositionY: options.captionPositionY,
    captionStyle: options.captionStyle,
    renderEngine: options.renderEngine,
    videoFilter: options.videoFilter,
    subtitleOffsetMs: options.subtitleOffsetMs,
    cameraKeyframes: options.cameraKeyframes,
  }, exportTimeoutMs);
}

export async function vpsPreviewClip(videoId: string, startTime: number, endTime: number, calibration: any, contentType?: string, subtitleSegments?: any[], bgAudioFilename?: string, bgAudioVolume?: number, muteOriginalAudio?: boolean, musicDropTime?: number, musicDropVolumeBefore?: number, captionPositionY?: number, uniqualize?: boolean, filterPreset?: string, subtitleOffsetMs?: number, captionStyle?: string, bleepProfanity?: boolean, videoFilter?: string, musicStartOffset?: number, voiceVolume?: number): Promise<{ url: string; publicUrl?: string }> {
  log(`VPS preview-clip: ${videoId} (${startTime}-${endTime}s), contentType=${contentType || "poker"}, subs=${subtitleSegments?.length || 0}, bg=${bgAudioFilename || "none"}, vol=${bgAudioVolume ?? 0.2}, mute=${!!muteOriginalAudio}, bleep=${!!bleepProfanity}, filter=${videoFilter || (uniqualize ? (filterPreset || "medium") : "off")}, subOffset=${subtitleOffsetMs || 0}ms, captionStyle=${captionStyle || "classic"}, musicStart=${musicStartOffset || 0}s, voiceVol=${voiceVolume ?? 1.4}`, "vps-client");
  return vpsJson(`/preview-clip/${videoId}`, { startTime, endTime, calibration, contentType, subtitleSegments, bgAudioFilename, bgAudioVolume, muteOriginalAudio, musicDropTime, musicDropVolumeBefore, captionPositionY, uniqualize, filterPreset, subtitleOffsetMs, captionStyle, bleepProfanity, videoFilter, musicStartOffset, voiceVolume }, 120000);
}

export async function vpsSoundsList(): Promise<{ sounds: Array<{ id: string; filename: string; sizeBytes: number; createdAt: number }> }> {
  const response = await vpsRequest("/sounds", { method: "GET" });
  return await response.json();
}

export async function vpsSoundsUpload(fileBuffer: Buffer, filename: string, customName?: string): Promise<{ id: string; filename: string; sizeBytes: number }> {
  const FormData = (await import("form-data")).default;
  const formData = new FormData();
  formData.append("file", fileBuffer, { filename });
  if (customName) formData.append("name", customName);
  
  const url = `${getVpsUrl()}/sounds/upload`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${getVpsToken()}`,
      ...formData.getHeaders(),
    },
    body: formData as any,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`VPS sounds upload failed: ${response.status} ${text}`);
  }
  return await response.json() as any;
}

export async function vpsDownloadSoundUrl(url: string, name?: string): Promise<{ id: string; filename: string; sizeBytes: number; title: string }> {
  const response = await vpsRequest("/sounds/download-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, name }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(err.error || `VPS download failed: ${response.status}`);
  }
  return await response.json();
}

export async function vpsSearchDownloadSound(query: string, name?: string): Promise<{ id: string; filename: string; sizeBytes: number; title: string }> {
  const response = await vpsRequest("/sounds/search-download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, name }),
  }, 130000);
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(err.error || `VPS search-download failed: ${response.status}`);
  }
  return await response.json();
}

export async function vpsSoundsDelete(soundId: string): Promise<void> {
  const response = await vpsRequest(`/sounds/${soundId}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`VPS sounds delete failed: ${response.status}`);
}

export async function vpsExportProgress(videoId: string, exportId: string): Promise<{ active: boolean; percent: number; fps?: number; speed?: string }> {
  try {
    const response = await vpsRequest(`/export-progress/${videoId}/${exportId}`, { method: "GET" });
    return await response.json();
  } catch {
    return { active: false, percent: 0 };
  }
}

export async function vpsDownloadExport(videoId: string, exportId: string, outputPath: string, onProgress?: (downloaded: number, total: number) => void): Promise<void> {
  log(`VPS download export: ${videoId}/${exportId}`, "vps-client");
  const response = await vpsRequest(`/exports/${videoId}/${exportId}`, { method: "GET" }, 600000);

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const totalSize = parseInt(response.headers.get("content-length") || "0", 10);
  const fileStream = fs.createWriteStream(outputPath);

  await new Promise<void>((resolve, reject) => {
    if (!response.body) {
      reject(new Error("No response body"));
      return;
    }
    const reader = response.body.getReader();
    let downloaded = 0;

    function pump(): Promise<void> {
      return reader.read().then(({ done, value }) => {
        if (done) {
          fileStream.end();
          return;
        }
        downloaded += value.length;
        if (onProgress && totalSize > 0) onProgress(downloaded, totalSize);
        if (!fileStream.write(value)) {
          return new Promise<void>((res) => fileStream.once("drain", res)).then(pump);
        }
        return pump();
      });
    }

    fileStream.on("finish", resolve);
    fileStream.on("error", reject);
    pump().catch((err) => {
      fileStream.destroy();
      reject(err);
    });
  });

  log(`Downloaded export: ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(1)}MB → ${outputPath}`, "vps-client");
}

export async function vpsUploadOverlay(overlayPath: string): Promise<{ ok: boolean }> {
  if (!fs.existsSync(overlayPath)) {
    throw new Error(`Overlay file not found: ${overlayPath}`);
  }
  log(`Uploading overlay to VPS: ${overlayPath} (${(fs.statSync(overlayPath).size / 1024).toFixed(0)}KB)`, "vps-client");

  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);

  const url = `${VPS_URL}/overlay/upload`;
  const cmd = `curl -sf -X POST -H "Authorization: Bearer ${VPS_TOKEN}" -F "file=@${overlayPath}" "${url}"`;

  const { stdout } = await execAsync(cmd, { timeout: 60000 });
  const result = JSON.parse(stdout);
  log(`Overlay uploaded to VPS successfully`, "vps-client");
  return result;
}

export async function vpsUploadBgTemplate(bgPath: string): Promise<{ ok: boolean }> {
  if (!fs.existsSync(bgPath)) {
    throw new Error(`BG template file not found: ${bgPath}`);
  }
  log(`Uploading bg template to VPS: ${bgPath} (${(fs.statSync(bgPath).size / 1024).toFixed(0)}KB)`, "vps-client");

  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);

  const url = `${VPS_URL}/bg-template/upload`;
  const cmd = `curl -sf -X POST -H "Authorization: Bearer ${VPS_TOKEN}" -F "file=@${bgPath}" "${url}"`;

  const { stdout } = await execAsync(cmd, { timeout: 60000 });
  const result = JSON.parse(stdout);
  log(`BG template uploaded to VPS successfully`, "vps-client");
  return result;
}

export async function vpsUploadBgFrame(bgPath: string): Promise<{ ok: boolean }> {
  if (!fs.existsSync(bgPath)) {
    throw new Error(`BG frame file not found: ${bgPath}`);
  }
  log(`Uploading bg frame to VPS: ${bgPath} (${(fs.statSync(bgPath).size / 1024).toFixed(0)}KB)`, "vps-client");

  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);

  const url = `${VPS_URL}/bg-frame/upload`;
  const cmd = `curl -sf -X POST -H "Authorization: Bearer ${VPS_TOKEN}" -F "file=@${bgPath}" "${url}"`;

  const { stdout } = await execAsync(cmd, { timeout: 60000 });
  const result = JSON.parse(stdout);
  log(`BG frame uploaded to VPS successfully`, "vps-client");
  return result;
}

export async function vpsUploadBgCanvas(bgPath: string): Promise<{ ok: boolean }> {
  if (!fs.existsSync(bgPath)) {
    throw new Error(`BG canvas file not found: ${bgPath}`);
  }
  log(`Uploading bg canvas to VPS: ${bgPath} (${(fs.statSync(bgPath).size / 1024).toFixed(0)}KB)`, "vps-client");

  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);

  const url = `${VPS_URL}/bg-canvas/upload`;
  const cmd = `curl -sf -X POST -H "Authorization: Bearer ${VPS_TOKEN}" -F "file=@${bgPath}" "${url}"`;

  const { stdout } = await execAsync(cmd, { timeout: 60000 });
  const result = JSON.parse(stdout);
  log(`BG canvas uploaded to VPS successfully`, "vps-client");
  return result;
}

export async function vpsHealthCheck(): Promise<{ ok: boolean; hasOverlay?: boolean; hasBgTemplate?: boolean; hasBgFrame?: boolean; hasBgCanvas?: boolean }> {
  try {
    const response = await vpsRequest("/health", { method: "GET" });
    return await response.json() as { ok: boolean; hasOverlay?: boolean; hasBgTemplate?: boolean; hasBgFrame?: boolean; hasBgCanvas?: boolean };
  } catch {
    return { ok: false };
  }
}

export async function vpsCleanup(videoId: string): Promise<void> {
  try {
    await vpsJson(`/cleanup/${videoId}`);
    log(`VPS cleanup: ${videoId}`, "vps-client");
  } catch (err: any) {
    log(`VPS cleanup warning: ${err.message}`, "vps-client");
  }
}

export async function vpsUploadCookies(cookieText: string): Promise<{ success: boolean; entries: number }> {
  log("Uploading cookies to VPS", "vps-client");
  const response = await vpsRequest(`/youtube/cookies`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: cookieText,
  });
  return response.json() as Promise<{ success: boolean; entries: number }>;
}

export async function vpsGetCookiesStatus(): Promise<{ hasCookies: boolean; entries: number; modifiedAt: string | null }> {
  const response = await vpsRequest(`/youtube/cookies/status`, { method: "GET" });
  return response.json() as Promise<{ hasCookies: boolean; entries: number; modifiedAt: string | null }>;
}

export async function vpsDeleteCookies(): Promise<void> {
  await vpsRequest(`/youtube/cookies`, { method: "DELETE" });
}

export async function vpsDownloadYouTube(youtubeUrl: string, videoId: string, maxHeight?: number, trimStart?: number, trimEnd?: number): Promise<{ resolution: string; size: number }> {
  log(`VPS YouTube download: ${youtubeUrl} -> ${videoId}${maxHeight ? ` (maxHeight=${maxHeight})` : ""}${trimStart != null ? ` [trim ${trimStart}s-${trimEnd}s]` : ""}`, "vps-client");
  const result = await vpsJson<{ success: boolean; resolution: string; size: number; error?: string }>(`/youtube/download`, {
    url: youtubeUrl,
    videoId,
    ...(maxHeight ? { maxHeight } : {}),
    ...(trimStart != null && trimEnd != null ? { trimStart, trimEnd } : {}),
  }, 1800000);
  if (!result.success) {
    throw new Error(result.error || "VPS YouTube download failed");
  }
  log(`VPS YouTube download complete: ${result.resolution}, ${(result.size / 1048576).toFixed(1)} MB`, "vps-client");
  return { resolution: result.resolution, size: result.size };
}

export async function vpsDownloadTwitch(twitchUrl: string, videoId: string, trimStart?: number, trimEnd?: number): Promise<{ resolution: string; size: number }> {
  log(`VPS Twitch download: ${twitchUrl} -> ${videoId}${trimStart != null ? ` [trim ${trimStart}s-${trimEnd}s]` : ""}`, "vps-client");
  const result = await vpsJson<{ success: boolean; resolution: string; size: number; error?: string }>(`/twitch/download`, {
    url: twitchUrl,
    videoId,
    ...(trimStart != null && trimEnd != null ? { trimStart, trimEnd } : {}),
  }, 1800000);
  if (!result.success) {
    throw new Error(result.error || "VPS Twitch download failed");
  }
  log(`VPS Twitch download complete: ${result.resolution}, ${(result.size / 1048576).toFixed(1)} MB`, "vps-client");
  return { resolution: result.resolution, size: result.size };
}

export async function vpsDownloadGoogleDrive(gdriveUrl: string, videoId: string, trimStart?: number, trimEnd?: number): Promise<{ resolution: string; size: number }> {
  log(`VPS Google Drive download: ${gdriveUrl} -> ${videoId}${trimStart != null ? ` [trim ${trimStart}s-${trimEnd}s]` : ""}`, "vps-client");
  const result = await vpsJson<{ success: boolean; resolution: string; size: number; error?: string }>(`/gdrive/download`, {
    url: gdriveUrl,
    videoId,
    ...(trimStart != null && trimEnd != null ? { trimStart, trimEnd } : {}),
  }, 1800000);
  if (!result.success) {
    throw new Error(result.error || "VPS Google Drive download failed");
  }
  log(`VPS Google Drive download complete: ${result.resolution}, ${(result.size / 1048576).toFixed(1)} MB`, "vps-client");
  return { resolution: result.resolution, size: result.size };
}

export async function vpsDownloadVkVideo(vkUrl: string, videoId: string, trimStart?: number, trimEnd?: number): Promise<{ resolution: string; size: number }> {
  log(`VPS VK Video download: ${vkUrl} -> ${videoId}${trimStart != null ? ` [trim ${trimStart}s-${trimEnd}s]` : ""}`, "vps-client");
  const result = await vpsJson<{ success: boolean; resolution: string; size: number; error?: string }>(`/vkvideo/download`, {
    url: vkUrl,
    videoId,
    ...(trimStart != null && trimEnd != null ? { trimStart, trimEnd } : {}),
  }, 3600000);
  if (!result.success) {
    throw new Error(result.error || "VPS VK Video download failed");
  }
  log(`VPS VK Video download complete: ${result.resolution}, ${(result.size / 1048576).toFixed(1)} MB`, "vps-client");
  return { resolution: result.resolution, size: result.size };
}

export async function vpsDownloadKick(kickUrl: string, videoId: string, trimStart?: number, trimEnd?: number): Promise<{ resolution: string; size: number }> {
  log(`VPS Kick download: ${kickUrl} -> ${videoId}${trimStart != null ? ` [trim ${trimStart}s-${trimEnd}s]` : ""}`, "vps-client");
  const result = await vpsJson<{ success: boolean; resolution: string; size: number; error?: string }>(`/kick/download`, {
    url: kickUrl,
    videoId,
    ...(trimStart != null && trimEnd != null ? { trimStart, trimEnd } : {}),
  });
  if (!result.success) {
    throw new Error(result.error || "VPS Kick download failed");
  }
  log(`VPS Kick download complete: ${result.resolution}, ${(result.size / 1048576).toFixed(1)} MB`, "vps-client");
  return { resolution: result.resolution, size: result.size };
}

export async function vpsDownloadKickM3u8(m3u8Url: string, videoId: string, trimStart?: number, trimEnd?: number): Promise<{ resolution: string; size: number }> {
  log(`VPS Kick m3u8 download: ${m3u8Url.substring(0, 80)}... -> ${videoId}${trimStart != null ? ` [trim ${trimStart}s-${trimEnd}s]` : ""}`, "vps-client");
  const result = await vpsJson<{ success: boolean; resolution: string; size: number; error?: string }>(`/kick/download-m3u8`, {
    m3u8Url,
    videoId,
    ...(trimStart != null && trimEnd != null ? { trimStart, trimEnd } : {}),
  }, 7200000);
  if (!result.success) {
    throw new Error(result.error || "VPS Kick m3u8 download failed");
  }
  log(`VPS Kick m3u8 download complete: ${result.resolution}, ${(result.size / 1048576).toFixed(1)} MB`, "vps-client");
  return { resolution: result.resolution, size: result.size };
}

export async function vpsResolveKickM3u8(uuid: string): Promise<string> {
  log(`VPS resolving Kick m3u8 for UUID: ${uuid}`, "vps-client");
  const result = await vpsJson<{ success: boolean; m3u8Url?: string; error?: string }>(`/kick/resolve-m3u8`, {
    uuid,
  }, 30000);
  if (!result.success || !result.m3u8Url) {
    throw new Error(result.error || "VPS could not resolve Kick m3u8 URL");
  }
  log(`VPS resolved Kick m3u8: ${result.m3u8Url}`, "vps-client");
  return result.m3u8Url;
}

export async function vpsPublishToUploadPost(
  vpsFilePath: string,
  platform: string,
  title: string,
  apiKey: string,
  user: string,
  options?: {
    description?: string;
    thumbOffsetMs?: number;
    tiktokPrivacyLevel?: string;
    tiktokPostMode?: string;
    youtubePrivacy?: string;
    instagramShareMode?: string;
  }
): Promise<any> {
  log(`VPS upload-post/${platform}: starting publish via ${vpsFilePath}`, "vps-client");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 360000);
  let resp: any;
  try {
    resp = await undiciFetch(`${VPS_URL}/upload-post/publish`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${VPS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ filePath: vpsFilePath, platform, title, description: options?.description, apiKey, user, options }),
      signal: controller.signal,
      dispatcher: longTimeoutAgent,
    });
  } catch (err: any) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new Error(`VPS upload-post/${platform} таймаут (360с)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const text = await resp.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!resp.ok) {
    throw new Error(`VPS upload-post/${platform} ошибка (${resp.status}): ${text.substring(0, 300)}`);
  }
  log(`VPS upload-post/${platform} OK: ${JSON.stringify(data).substring(0, 150)}`, "vps-client");
  return data;
}

export async function vpsUploadFile(localPath: string, desiredVideoId?: string): Promise<{ videoId: string; storedPath: string; sizeBytes: number }> {
  const url = `${VPS_URL}/upload`;
  log(`VPS uploading file via curl: ${localPath}`, "vps-client");

  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  const { stdout } = await execFileAsync("curl", [
    "-s", "-X", "POST",
    "-H", `Authorization: Bearer ${VPS_TOKEN}`,
    "-F", `file=@${localPath};filename=input.mp4`,
    "--max-time", "7200",
    url,
  ], { timeout: 7200000, maxBuffer: 10 * 1024 * 1024 });

  const data = JSON.parse(stdout) as any;
  if (data.error) {
    throw new Error(`VPS upload error: ${data.error}`);
  }
  log(`VPS upload complete: ${data.videoId} (${(data.sizeBytes / 1048576).toFixed(1)} MB)`, "vps-client");
  return data;
}

export interface SpeakerFace {
  id: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  speaking_score: number;
  area: number;
}
export interface SpeakerFrame {
  time: number;
  faces: SpeakerFace[];
  audio_energy?: number; // RMS audio level 0-1 for this frame's time window
}

export async function vpsAnalyzeSpeakers(
  videoId: string,
  timestamps: number[],
  region: { x: number; y: number; w: number; h: number }
): Promise<SpeakerFrame[]> {
  log(`VPS analyze-speakers: ${videoId} (${timestamps.length} timestamps)`, "vps-client");
  const response = await vpsRequest(`/analyze-speakers/${videoId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timestamps, region }),
  }, 90000);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error(`Unexpected response from analyze-speakers: ${JSON.stringify(data).slice(0, 200)}`);
  return data as SpeakerFrame[];
}
