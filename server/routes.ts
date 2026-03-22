import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import Busboy from "busboy";
import FormData from "form-data";
import { storage } from "./storage";
import { log } from "./index";
import { extractFrame, getVideoInfo, generateThumbnail } from "./analyzer";
import { exportShort, cancelExport, scaleCalibration } from "./exporter";
import { runPipeline, reanalyzePipeline, rewhisperPipeline, cancelPipeline, downloadFromVps, downloadKick, resumeRunPodPipeline, realignAndAnalyzePipeline, splitLongSegments } from "./ai-pipeline";
import { isVpsConfigured, vpsExtractFrame, vpsGenerateThumbnail, vpsGenerateClipThumbnail, vpsRemux, vpsRegeneratePreview, vpsStopPreview, getVpsUrl, getVpsToken, vpsUploadBgTemplate, vpsUploadBgFrame, vpsUploadBgCanvas, vpsHealthCheck, vpsDownloadExport, vpsUploadCookies, vpsGetCookiesStatus, vpsDeleteCookies, vpsSoundsList, vpsSoundsUpload, vpsSoundsDelete, vpsDownloadSoundUrl, vpsSearchDownloadSound, vpsPreviewClip, vpsPublishToUploadPost } from "./vps-client";
import { detectRegionsWithAI } from "./ai-calibration";
import { analyzeCameraKeyframes, type CameraKeyframe } from "./ai-camera";
import { getAuthUrl, handleCallback, getYouTubeStatus, uploadToYouTube, disconnectYouTube, setYouTubeThumbnail } from "./youtube";
import { getVkAuthUrl, saveVkToken, getVkStatus, disconnectVk, uploadToVk, setVkGroup, clearVkGroup } from "./social-vk";
import { getTikTokAuthUrl, handleTikTokCallback, getTikTokStatus, disconnectTikTok, uploadToTikTok } from "./social-tiktok";
import { getInstagramAuthUrl, handleInstagramCallback, getInstagramStatus, disconnectInstagram, uploadToInstagram } from "./social-instagram";
import { getFacebookStatus, uploadToFacebook } from "./social-facebook";
import { getThreadsStatus, uploadToThreads } from "./social-threads";
import { isUploadPostConfigured, getUploadPostStatus, getConnectedPlatforms, getConnectedPlatformsForStreamer, clearPlatformCache, findPostUrlByRequestId, uploadToUploadPostForStreamer, uploadToUploadPost } from "./upload-post";
import { isPostmypostConfigured, getPostmypostVkStatus, uploadToVkViaPostmypost, getPublicationStatus, uploadViaPostmypost, getPostmypostStatuses, clearPostmypostCache } from "./social-vk-postmypost";
import { generateVideo, downloadVideo, isXaiConfigured, getXaiBalance } from "./xai-client";
import { generateVeoVideo, downloadVeoVideo, isVeoConfigured } from "./veo-client";
import { generateFalVideo, downloadFalVideo, isFalConfigured } from "./fal-client";
import { generateImage, generateImageWithGemini, generateImageWithOpenAI, saveBase64Image } from "./imagen-client";
import { getPodStatus, startPod, stopPod, ensurePodRunning, schedulePodAutoStop, acquireGpuLease, releaseGpuLease } from "./runpod-client";
import type { CalibrationData, ThresholdsData, TranscriptSegment, GeneratedClip, SceneData } from "@shared/schema";

const VPS_TOKEN = process.env.VPS_TOKEN || "";
const LOCAL_PROCESSING = process.env.LOCAL_PROCESSING !== "false";

const cleanExportInProgress = new Set<string>();

async function triggerCleanExport(exportId: string, storageRef: any): Promise<void> {
  if (cleanExportInProgress.has(exportId)) return;
  cleanExportInProgress.add(exportId);

  try {
    const job = await storageRef.getExportJob(exportId);
    if (!job || job.cleanOutputPath || job.isPreview) return;
    if (job.status !== "completed" || !job.outputPath) return;

    const clip = await storageRef.getClip(job.clipId);
    if (!clip) return;
    const video = await storageRef.getVideo(job.videoId);
    if (!video) return;
    const profile = await storageRef.getProfile(job.profileId);
    if (!profile) return;

    const useVps = video.vpsVideoId && video.filepath === "vps" && isVpsConfigured();
    if (!useVps) {
      log(`[clean-export] Skipping ${exportId}: not on VPS`, "exporter");
      return;
    }

    const startTime = clip.adjustedStartTime ?? clip.startTime;
    const endTime = clip.adjustedEndTime ?? clip.endTime;

    let clipCalibration: CalibrationData;
    if (clip.calibration) {
      clipCalibration = clip.calibration as CalibrationData;
      if (video.width && video.height) clipCalibration = scaleCalibration(clipCalibration, video.width, video.height);
    } else if (profile.calibration) {
      clipCalibration = profile.calibration as CalibrationData;
      if (video.width && video.height) clipCalibration = scaleCalibration(clipCalibration, video.width, video.height);
    } else {
      log(`[clean-export] Skipping ${exportId}: no calibration`, "exporter");
      return;
    }

    const cleanFile = `clean_${exportId}.mp4`;
    const cleanPath = path.join(CLEAN_EXPORTS_DIR, cleanFile);

    log(`[clean-export] Starting clean export for ${exportId}`, "exporter");

    await exportShort({
      videoPath: video.filepath,
      outputPath: cleanPath,
      startTime,
      endTime,
      calibration: clipCalibration,
      subtitlesEnabled: false,
      vpsVideoId: video.vpsVideoId!,
      isPreview: false,
      muteAudio: false,
      bleepProfanity: false,
      uniqualize: false,
      renderEngine: "runpod",
      aspectRatio: job.aspectRatio || "9:16",
      contentType: video.contentType || "poker",
      jobId: `clean_${exportId}`,
    });

    await storageRef.updateExportJob(exportId, { cleanOutputPath: cleanPath });
    log(`[clean-export] Completed for ${exportId}: ${cleanPath}`, "exporter");
  } catch (err: any) {
    log(`[clean-export] Failed for ${exportId}: ${err.message}`, "exporter");
    // If video no longer exists on VPS (404), mark it to skip future retries
    if (err.message?.includes("404") || err.message?.includes("Video not found")) {
      try {
        await storageRef.updateExportJob(exportId, { cleanOutputPath: "skip" });
        log(`[clean-export] Marked ${exportId} as skip (video not on VPS)`, "exporter");
      } catch {}
    }
  } finally {
    cleanExportInProgress.delete(exportId);
  }
}

const publishLocks = new Map<string, Promise<void>>();
async function addPublishedPlatform(
  exportId: string,
  platform: string,
  urlsToMerge: Record<string, string>,
  storageRef: any
): Promise<void> {
  while (publishLocks.has(exportId)) {
    await publishLocks.get(exportId);
  }
  let resolve: () => void;
  const lock = new Promise<void>(r => { resolve = r; });
  publishLocks.set(exportId, lock);
  try {
    const fresh = await storageRef.getExportJob(exportId);
    if (!fresh) return;
    const current = fresh.publishedTo || [];
    const currentUrls = (fresh.publishedUrls as Record<string, string>) || {};
    if (!current.includes(platform)) {
      const isFirstPublish = current.length === 0;
      await storageRef.updateExportJob(exportId, {
        publishedTo: [...current, platform],
        publishedUrls: { ...currentUrls, ...urlsToMerge },
        ...(!fresh.publishedAt ? { publishedAt: new Date() } : {}),
      });
      if (isFirstPublish && !fresh.cleanOutputPath && !fresh.isPreview) {
        triggerCleanExport(exportId, storageRef).catch(() => {});
      }
    }
  } finally {
    publishLocks.delete(exportId);
    resolve!();
  }
}

async function addPublishedPlatformAutoCut(
  cutId: string,
  platform: string,
  urlsToMerge: Record<string, string>,
  storageRef: any
): Promise<void> {
  const fresh = await storageRef.getAutoCut(cutId);
  if (!fresh) return;
  const current = (fresh.publishedTo as string[]) || [];
  const currentUrls = (fresh.publishedUrls as Record<string, string>) || {};
  if (!current.includes(platform)) {
    await storageRef.updateAutoCut(cutId, {
      publishedTo: [...current, platform],
      publishedUrls: { ...currentUrls, ...urlsToMerge },
      ...(!fresh.publishedAt ? { publishedAt: new Date() } : {}),
    });
  }
}

async function resolvePostmypostProjectIdForAutoCut(cut: any, storageRef: any): Promise<number | null> {
  try {
    const video = await storageRef.getVideo(cut.videoId);
    if (video?.profileId) {
      const profile = await storageRef.getProfile(video.profileId);
      if (profile?.postmypostProjectId) {
        return profile.postmypostProjectId;
      }
    }
  } catch {}
  return null;
}

function extractCaptionForClip(segments: TranscriptSegment[] | undefined | null, startTime: number, endTime: number): string {
  if (!segments || segments.length === 0) return "";
  const overlapping = segments.filter(s => s.end > startTime && s.start < endTime);
  if (overlapping.length === 0) return "";
  return overlapping.map(s => s.text.trim()).filter(Boolean).join(" ");
}

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

function pollUploadPostUrl(
  exportId: string,
  platform: string,
  requestId: string,
  storage: any,
  maxAttempts = 10,
  intervalMs = 15000,
) {
  let attempt = 0;
  const poll = async () => {
    attempt++;
    try {
      const postUrl = await findPostUrlByRequestId(requestId, platform);
      if (postUrl) {
        const job = await storage.getExportJob(exportId);
        if (job) {
          const currentUrls = (job.publishedUrls as Record<string, string>) || {};
          if (!currentUrls[platform] || currentUrls[platform] === genericPlatformUrl(platform)) {
            await storage.updateExportJob(exportId, {
              publishedUrls: { ...currentUrls, [platform]: postUrl },
            });
            console.log(`[Upload-Post] Updated ${platform} URL for export ${exportId}: ${postUrl}`);
          }
        }
        return;
      }
    } catch (err: any) {
      console.error(`[Upload-Post] Poll error for ${platform} export ${exportId}:`, err.message);
    }
    if (attempt < maxAttempts) {
      setTimeout(poll, intervalMs);
    } else {
      console.log(`[Upload-Post] Max attempts reached for ${platform} export ${exportId}, giving up URL polling`);
    }
  };
  setTimeout(poll, intervalMs);
}

function genericPlatformUrl(platform: string): string {
  const map: Record<string, string> = {
    instagram: "https://www.instagram.com/",
    tiktok: "https://www.tiktok.com/",
    facebook: "https://www.facebook.com/",
    threads: "https://www.threads.net/",
  };
  return map[platform] || "";
}

async function resolveStreamerCredentials(exportJob: any, storageRef: any): Promise<{ apiKey: string | null; user: string | null }> {
  try {
    const video = await storageRef.getVideo(exportJob.videoId);
    if (video?.profileId) {
      const profile = await storageRef.getProfile(video.profileId);
      if (profile?.uploadPostApiKey && profile?.uploadPostUser) {
        const apiKey = profile.uploadPostApiKey === "GLOBAL"
          ? (process.env.UPLOAD_POST_API_KEY || null)
          : profile.uploadPostApiKey;
        return { apiKey, user: profile.uploadPostUser };
      }
    }
  } catch {}
  return { apiKey: null, user: null };
}

async function resolvePostmypostProjectId(exportJob: any, storageRef: any): Promise<number | null> {
  try {
    const video = await storageRef.getVideo(exportJob.videoId);
    if (video?.profileId) {
      const profile = await storageRef.getProfile(video.profileId);
      if (profile?.postmypostProjectId) {
        return profile.postmypostProjectId;
      }
    }
  } catch {}
  return null;
}

async function getVpsExportPath(exportJob: any, storageRef: any): Promise<string | null> {
  if (!isVpsConfigured()) return null;
  try {
    const video = await storageRef.getVideo(exportJob.videoId);
    if (!video?.vpsVideoId) return null;
    const exportFilename = path.basename(exportJob.outputPath || "");
    if (!exportFilename) return null;
    const clipId = exportFilename.replace(/^short_/, "").replace(/\.mp4$/, "");
    return `/data/videos/${video.vpsVideoId}/exports/${clipId}.mp4`;
  } catch { return null; }
}

const REASON_HASHTAGS: Record<string, string[]> = {
  funny: ["#юмор", "#смешно", "#ржака"],
  drama: ["#драма", "#конфликт", "#скандал"],
  reaction: ["#реакция", "#эмоции"],
  viral: ["#вирусное", "#тренд"],
  girls: ["#отношения", "#девушки", "#любовь"],
  romantic: ["#романтика", "#любовь"],
  emotional: ["#эмоции", "#чувства"],
  rant: ["#мнение", "#rant"],
  hot_take: ["#мнение", "#правда"],
  confession: ["#история", "#откровение"],
  story: ["#история", "#рассказ"],
  relatable: ["#жиза", "#знакомо"],
  controversial: ["#спорное", "#мнение"],
  motivation: ["#мотивация", "#успех"],
  advice: ["#советы", "#лайфхак"],
  roast: ["#юмор", "#roast"],
  debate: ["#спор", "#дискуссия"],
  savage: ["#жёстко", "#savage"],
  wisdom: ["#мудрость", "#философия"],
  philosophy: ["#философия", "#мысли"],
  social: ["#общество", "#жизнь"],
  all_in: ["#покер", "#олл_ин"],
  big_pot: ["#покер", "#большойбанк"],
  bluff: ["#покер", "#блеф"],
  bad_beat: ["#покер", "#бэдбит"],
  hero_call: ["#покер", "#геройский_колл"],
  river_card: ["#покер", "#ривер"],
  cooler: ["#покер", "#кулер"],
  final_table: ["#покер", "#финал"],
  celebration: ["#победа", "#празднование"],
  tilt: ["#покер", "#тильт"],
  shove: ["#покер", "#шов"],
  fold: ["#покер", "#фолд"],
};

function generateHashtags(title: string, reasons?: string[]): string {
  const tags: string[] = [];

  if (reasons && reasons.length > 0) {
    const seen = new Set<string>();
    for (const reason of reasons) {
      const mapped = REASON_HASHTAGS[reason];
      if (mapped) {
        for (const tag of mapped) {
          if (!seen.has(tag)) {
            seen.add(tag);
            tags.push(tag);
          }
          if (tags.length >= 3) break;
        }
      }
      if (tags.length >= 3) break;
    }
  }

  if (tags.length === 0) {
    tags.push("#клип", "#стрим", "#shorts");
  } else if (tags.length < 3 && !tags.some(t => t === "#shorts")) {
    tags.push("#shorts");
  }

  return tags.slice(0, 3).join(" ");
}

function appendHashtags(text: string, title: string, reasons?: string[]): string {
  const hashtags = generateHashtags(title, reasons);
  if (!hashtags) return text;
  if (text.includes("#")) return text;
  return text ? `${text}\n\n${hashtags}` : hashtags;
}

async function tryVpsPublish(
  exportJob: any,
  platform: string,
  title: string,
  apiKey: string,
  user: string,
  storageRef: any,
  options?: any
): Promise<any | null> {
  const vpsPath = await getVpsExportPath(exportJob, storageRef);
  if (!vpsPath) return null;
  try {
    log(`[upload-vps] Trying VPS publish: ${platform} via ${vpsPath}`, "social");
    const data = await vpsPublishToUploadPost(vpsPath, platform, title, apiKey, user, options);
    return data;
  } catch (err: any) {
    log(`[upload-vps] VPS publish failed for ${platform}, falling back to local: ${err.message}`, "social");
    return null;
  }
}

function paramId(req: Request): string {
  const id = req.params.id;
  return Array.isArray(id) ? id[0] : id;
}

function formatTimeShort(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const UPLOADS_DIR = path.join(process.cwd(), "private_uploads");
const EXPORTS_DIR = path.join(process.cwd(), "private_exports");
const CLEAN_EXPORTS_DIR = path.join(process.cwd(), "private_clean_exports");
const THUMBNAILS_DIR = path.join(process.cwd(), "private_thumbnails");
const FRAMES_DIR = path.join(process.cwd(), "private_frames");
const BG_TEMPLATE_PATH = path.join(UPLOADS_DIR, "bg_template.png");
const BG_FRAME_PATH = path.join(UPLOADS_DIR, "bg_frame.png");
const BG_CANVAS_PATH = path.join(UPLOADS_DIR, "bg_canvas.png");
const hasBgTemplate = () => fs.existsSync(BG_TEMPLATE_PATH);
const hasBgFrame = () => fs.existsSync(BG_FRAME_PATH);
const hasBgCanvas = () => fs.existsSync(BG_CANVAS_PATH);

for (const dir of [UPLOADS_DIR, EXPORTS_DIR, CLEAN_EXPORTS_DIR, THUMBNAILS_DIR, FRAMES_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024;

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${uuidv4()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_FILE_SIZE },
});

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/pod/status", async (_req, res) => {
    try {
      const pod = await getPodStatus();
      const isRunning = pod.desiredStatus === "RUNNING" && pod.runtime?.uptimeInSeconds > 0;
      const isStarting = pod.desiredStatus === "RUNNING" && (!pod.runtime?.uptimeInSeconds || pod.runtime.uptimeInSeconds === 0);
      res.json({
        id: pod.id,
        name: pod.name,
        status: isRunning ? "running" : isStarting ? "starting" : "stopped",
        desiredStatus: pod.desiredStatus,
        uptimeSeconds: pod.runtime?.uptimeInSeconds || 0,
        gpu: pod.machine?.gpuDisplayName || "unknown",
        gpuCount: pod.gpuCount,
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/pod/start", async (_req, res) => {
    try {
      await startPod();
      res.json({ ok: true, message: "Pod starting..." });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/pod/stop", async (_req, res) => {
    try {
      await stopPod();
      res.json({ ok: true, message: "Pod stopped" });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/profiles", async (_req, res) => {
    try {
      const profiles = await storage.getProfiles();
      res.json(profiles);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/profiles", async (req, res) => {
    try {
      const { name } = req.body;
      if (!name) return res.status(400).json({ message: "Name required" });
      const profile = await storage.createProfile({ name });
      res.json(profile);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.delete("/api/profiles/:id", async (req, res) => {
    try {
      await storage.deleteProfile(paramId(req));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.patch("/api/profiles/:id/calibration", async (req, res) => {
    try {
      const calibration = req.body as CalibrationData;
      const profile = await storage.updateProfileCalibration(paramId(req), calibration);
      res.json(profile);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/clips/:id/calibration", async (req, res) => {
    try {
      const clip = await storage.getClip(paramId(req));
      if (!clip) return res.status(404).json({ message: "Clip not found" });
      res.json(clip.calibration || null);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.patch("/api/clips/:id/calibration", async (req, res) => {
    try {
      const existing = await storage.getClip(paramId(req));
      if (!existing) return res.status(404).json({ message: "Clip not found" });
      const calibration = req.body as CalibrationData;
      const clip = await storage.updateClip(paramId(req), { calibration } as any);
      res.json(clip);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.delete("/api/clips/:id/calibration", async (req, res) => {
    try {
      const existing = await storage.getClip(paramId(req));
      if (!existing) return res.status(404).json({ message: "Clip not found" });
      const clip = await storage.updateClip(paramId(req), { calibration: null } as any);
      res.json(clip);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.patch("/api/profiles/:id/thresholds", async (req, res) => {
    try {
      const thresholds = req.body as ThresholdsData;
      const profile = await storage.updateProfileThresholds(paramId(req), thresholds);
      res.json(profile);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.patch("/api/profiles/:id/settings", async (req, res) => {
    try {
      const { uploadPostApiKey, uploadPostUser, vkEnabled, postmypostProjectId } = req.body;
      const updateData: Partial<any> = {
        uploadPostApiKey: uploadPostApiKey ?? null,
        uploadPostUser: uploadPostUser ?? null,
      };
      if (vkEnabled !== undefined) updateData.vkEnabled = vkEnabled === true || vkEnabled === null ? vkEnabled : false;
      if (postmypostProjectId !== undefined) {
        updateData.postmypostProjectId = postmypostProjectId ? Number(postmypostProjectId) : null;
        clearPostmypostCache();
      }
      const profile = await storage.updateProfile(paramId(req), updateData);
      res.json(profile);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/profiles/:id/social-status", async (req, res) => {
    try {
      const profile = await storage.getProfile(paramId(req));
      if (!profile) return res.status(404).json({ message: "Profile not found" });

      const result: Record<string, { connected: boolean; accountName?: string | null; method?: string }> = {};

      if (profile.postmypostProjectId && isPostmypostConfigured()) {
        const statuses = await getPostmypostStatuses(profile.postmypostProjectId);
        for (const key of ["youtube", "tiktok", "instagram", "facebook", "vk"] as const) {
          const s = statuses[key];
          let connected = s.connected;
          if (key === "vk" && profile.vkEnabled === false) {
            connected = false;
          }
          result[key] = {
            connected,
            accountName: connected ? (s.accountName || null) : null,
            method: connected ? "postmypost" : "none",
          };
        }
        result.threads = { connected: false, accountName: null, method: "none" };
        return res.json({ configured: true, platforms: result });
      }

      if (profile.uploadPostApiKey && profile.uploadPostUser) {
        const resolvedApiKey = profile.uploadPostApiKey === "GLOBAL"
          ? (process.env.UPLOAD_POST_API_KEY || "")
          : profile.uploadPostApiKey;
        if (resolvedApiKey) {
          const platforms = await getConnectedPlatformsForStreamer(resolvedApiKey, profile.uploadPostUser);
          for (const key of ["youtube", "tiktok", "instagram", "facebook", "threads"] as const) {
            result[key] = {
              connected: platforms[key],
              accountName: platforms.accountNames[key] || null,
            };
          }
        }
      }

      let vkConnected = false;
      let vkAccountName: string | null = null;
      const profileVkEnabled = profile.vkEnabled !== false;
      if (profileVkEnabled && isPostmypostConfigured()) {
        const pmStatus = await getPostmypostVkStatus();
        if (pmStatus.connected) {
          vkConnected = true;
          vkAccountName = pmStatus.accountName || null;
        }
      }
      result.vk = { connected: vkConnected, accountName: vkAccountName, method: vkConnected ? "postmypost" : "none" };

      res.json({ configured: true, platforms: result });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  (async () => {
    try {
      const staleExports = await storage.getStaleExports();
      if (staleExports.length > 0) {
        log(`Found ${staleExports.length} stale export(s), marking as error`, "startup");
        for (const exp of staleExports) {
          await storage.updateExportJob(exp.id, { status: "error", error: "Сервер перезапущен — экспорт прерван. Нажмите «Повторить» для перезапуска." });
          log(`Marked stale export ${exp.id} as error`, "startup");
        }
      }
    } catch (err: any) {
      log(`Failed to clean stale exports: ${err.message}`, "startup");
    }
  })();

  if (isVpsConfigured()) {
    (async () => {
      try {
        const health = await vpsHealthCheck();
        if (hasBgTemplate() && !health.hasBgTemplate) {
          log("Auto-syncing bg template to VPS...", "startup");
          await vpsUploadBgTemplate(BG_TEMPLATE_PATH);
          log("BG template synced to VPS successfully", "startup");
        }
        if (hasBgFrame() && !health.hasBgFrame) {
          log("Auto-syncing bg frame to VPS...", "startup");
          await vpsUploadBgFrame(BG_FRAME_PATH);
          log("BG frame synced to VPS successfully", "startup");
        }
        if (hasBgCanvas() && !health.hasBgCanvas) {
          log("Auto-syncing bg canvas to VPS...", "startup");
          await vpsUploadBgCanvas(BG_CANVAS_PATH);
          log("BG canvas synced to VPS successfully", "startup");
        }
      } catch (err: any) {
        log(`Failed to sync assets to VPS: ${err.message}`, "startup");
      }
    })();
  }

  app.get("/api/videos", async (_req, res) => {
    try {
      const vids = await storage.getVideos();
      res.json(vids);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/videos/:id", async (req, res) => {
    try {
      const video = await storage.getVideo(paramId(req));
      if (!video) return res.status(404).json({ message: "Video not found" });
      res.json(video);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.patch("/api/videos/:id", async (req, res) => {
    try {
      const video = await storage.getVideo(paramId(req));
      if (!video) return res.status(404).json({ message: "Video not found" });
      const { profileId } = req.body;
      if (profileId) {
        const profile = await storage.getProfile(profileId);
        if (!profile) return res.status(400).json({ message: "Profile not found" });
      }
      const updated = await storage.updateVideo(paramId(req), { profileId: profileId || null });
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/videos/upload", (req, res, next) => {
    upload.single("video")(req, res, (err: any) => {
      if (err || req.file) return next(err);
      upload.single("file")(req, res, next);
    });
  }, async (req, res) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ message: "No file" });

      const start = Date.now();
      log(`Upload received: ${file.originalname} (${(file.size / 1024 / 1024).toFixed(1)}MB)`, "upload");

      let duration: number | undefined;
      let width: number | undefined;
      let height: number | undefined;
      let thumbnailPath: string | undefined;

      try {
        const info = await getVideoInfo(file.path);
        duration = info.duration;
        width = info.width;
        height = info.height;

        const thumbFile = `${uuidv4()}.jpg`;
        thumbnailPath = path.join(THUMBNAILS_DIR, thumbFile);
        await generateThumbnail(file.path, thumbnailPath, duration);
      } catch (err) {
        log(`Probe/thumbnail error (non-critical): ${err}`, "upload");
      }

      const video = await storage.createVideo({
        filename: file.filename,
        originalName: file.originalname,
        filepath: file.path,
        fileSize: file.size,
        youtubeUrl: null,
        duration: duration ?? null,
        width: width ?? null,
        height: height ?? null,
        profileId: (req.body as any).profileId || null,
        contentType: (req.body as any).contentType || "poker",
        status: "uploaded",
        thumbnailPath: thumbnailPath ?? null,
        vpsPath: null,
        vpsVideoId: null,
        transcription: null,
        highlights: null,
        pipelineStep: null,
        pipelineProgress: 0,
        pipelineError: null,
      });

      log(`Upload processed in ${Date.now() - start}ms`, "upload");
      res.json(video);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/upload", async (req: Request, res: Response) => {
    if (LOCAL_PROCESSING) {
      log("LOCAL_PROCESSING=true, proxying to local upload handler", "upload");
      return (upload.single("file") as any)(req, res, async (err: any) => {
        if (err) return res.status(500).json({ message: err.message });

        const file = (req as any).file;
        if (!file) return res.status(400).json({ message: "No file" });

        const start = Date.now();
        log(`Local upload: ${file.originalname} (${(file.size / 1024 / 1024).toFixed(1)}MB)`, "upload");

        let duration: number | undefined;
        let width: number | undefined;
        let height: number | undefined;
        let thumbnailPath: string | undefined;

        try {
          const info = await getVideoInfo(file.path);
          duration = info.duration;
          width = info.width;
          height = info.height;

          const thumbFile = `${uuidv4()}.jpg`;
          thumbnailPath = path.join(THUMBNAILS_DIR, thumbFile);
          await generateThumbnail(file.path, thumbnailPath, duration);
        } catch (probeErr) {
          log(`Probe/thumbnail error (non-critical): ${probeErr}`, "upload");
        }

        const profileId = (req.body as any).profileId || null;
        const contentType = (req.body as any).contentType || "poker";

        const video = await storage.createVideo({
          filename: file.filename,
          originalName: file.originalname,
          filepath: file.path,
          fileSize: file.size,
          youtubeUrl: null,
          duration: duration ?? null,
          width: width ?? null,
          height: height ?? null,
          profileId,
          contentType,
          status: "uploaded",
          thumbnailPath: thumbnailPath ?? null,
          vpsPath: null,
          vpsVideoId: null,
          transcription: null,
          highlights: null,
          pipelineStep: null,
          pipelineProgress: 0,
          pipelineError: null,
        });

        log(`Local upload done in ${Date.now() - start}ms`, "upload");
        res.json(video);
      });
    }

    if (!VPS_URL || !VPS_TOKEN) {
      return res.status(500).json({ message: "VPS not configured (VPS_URL and VPS_TOKEN required)" });
    }

    const profileId = (req.query.profileId as string) || null;

    log(`Pipe-proxy upload to VPS: ${VPS_URL}`, "upload");

    const vpsUrl = new URL(`${VPS_URL}/upload`);

    const proxyHeaders: Record<string, string> = {
      "authorization": `Bearer ${VPS_TOKEN}`,
    };
    if (req.headers["content-type"]) {
      proxyHeaders["content-type"] = req.headers["content-type"] as string;
    }
    if (req.headers["content-length"]) {
      proxyHeaders["content-length"] = req.headers["content-length"] as string;
    }

    const httpModule = await import(vpsUrl.protocol === "https:" ? "https" : "http");
    const proxyReq = httpModule.request(
      {
        hostname: vpsUrl.hostname,
        port: vpsUrl.port || (vpsUrl.protocol === "https:" ? 443 : 80),
        path: vpsUrl.pathname,
        method: "POST",
        headers: proxyHeaders,
        timeout: 3600000,
      },
      (proxyRes: any) => {
        let body = "";
        proxyRes.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        proxyRes.on("end", async () => {
          if (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300) {
            log(`VPS upload error ${proxyRes.statusCode}: ${body}`, "upload");
            if (!res.headersSent) {
              res.status(502).json({ message: `VPS error: ${body}` });
            }
            return;
          }

          try {
            const vpsData = JSON.parse(body) as { videoId: string; storedPath: string; sizeBytes: number };
            log(`VPS upload complete: ${vpsData.videoId} (${(vpsData.sizeBytes / 1024 / 1024).toFixed(1)}MB)`, "upload");

            const video = await storage.createVideo({
              filename: vpsData.videoId,
              originalName: vpsData.videoId,
              filepath: "vps",
              fileSize: vpsData.sizeBytes,
              youtubeUrl: null,
              duration: null,
              width: null,
              height: null,
              profileId,
              contentType: (req.query.contentType as string) || "poker",
              status: "uploaded",
              thumbnailPath: null,
              vpsPath: vpsData.storedPath,
              vpsVideoId: vpsData.videoId,
              transcription: null,
              highlights: null,
              pipelineStep: null,
              pipelineProgress: 0,
              pipelineError: null,
            });

            res.json(video);
          } catch (parseErr: any) {
            log(`VPS response parse error: ${parseErr.message}`, "upload");
            if (!res.headersSent) {
              res.status(502).json({ message: "VPS returned invalid response" });
            }
          }
        });
      }
    );

    proxyReq.on("error", (err: Error) => {
      log(`VPS proxy connection error: ${err.message}`, "upload");
      if (!res.headersSent) {
        res.status(502).json({ message: `Не удалось подключиться к VPS: ${err.message}` });
      }
    });

    proxyReq.on("timeout", () => {
      log("VPS proxy timeout", "upload");
      proxyReq.destroy();
      if (!res.headersSent) {
        res.status(504).json({ message: "Превышено время загрузки на VPS" });
      }
    });

    req.on("aborted", () => {
      log("Upload request aborted by client", "upload");
      proxyReq.destroy();
    });

    req.pipe(proxyReq);
  });

  app.get("/api/upload/mode", (_req, res) => {
    res.json({
      local: LOCAL_PROCESSING,
      vpsConfigured: !!(VPS_URL && VPS_TOKEN),
    });
  });

  app.get("/api/upload/config", (_req, res) => {
    if (LOCAL_PROCESSING || !VPS_URL || !VPS_TOKEN) {
      return res.json({ direct: false });
    }
    res.json({
      direct: true,
      vpsUrl: VPS_URL,
      vpsToken: VPS_TOKEN,
    });
  });


  app.post("/api/videos/register", async (req, res) => {
    try {
      const { vpsVideoId, vpsPath, originalName, fileSize, profileId, contentType } = req.body;
      if (!vpsVideoId || !vpsPath) {
        return res.status(400).json({ message: "vpsVideoId and vpsPath required" });
      }

      const video = await storage.createVideo({
        filename: vpsVideoId,
        originalName: originalName || "video.mp4",
        filepath: "vps",
        fileSize: fileSize || 0,
        youtubeUrl: null,
        duration: null,
        width: null,
        height: null,
        profileId: profileId || null,
        contentType: contentType || "poker",
        status: "uploaded",
        thumbnailPath: null,
        vpsPath,
        vpsVideoId,
        transcription: null,
        highlights: null,
        pipelineStep: null,
        pipelineProgress: 0,
        pipelineError: null,
      });

      log(`Video registered from direct VPS upload: ${vpsVideoId}`, "upload");
      res.json(video);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/cookies-status", async (_req, res) => {
    try {
      if (isVpsConfigured()) {
        const status = await vpsGetCookiesStatus();
        res.json({ exists: status.hasCookies, entries: status.entries, modifiedAt: status.modifiedAt, vps: true });
      } else {
        const cookiesPath = path.join(process.cwd(), "cookies.txt");
        res.json({ exists: fs.existsSync(cookiesPath), vps: false });
      }
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/cookies", multer({ dest: path.join(process.cwd(), "private_uploads") }).single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "Файл не загружен" });
      const content = fs.readFileSync(req.file.path, "utf-8");
      if (!content.includes("youtube.com") && !content.includes(".youtube.com")) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ message: "Файл не содержит cookies от YouTube" });
      }

      if (isVpsConfigured()) {
        const result = await vpsUploadCookies(content);
        fs.unlinkSync(req.file.path);
        log(`Cookies uploaded to VPS: ${result.entries} entries`, "routes");
        res.json({ ok: true, entries: result.entries, vps: true });
      } else {
        const cookiesPath = path.join(process.cwd(), "cookies.txt");
        fs.copyFileSync(req.file.path, cookiesPath);
        fs.unlinkSync(req.file.path);
        res.json({ ok: true, vps: false });
      }
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/cookies/text", async (req, res) => {
    try {
      const { text } = req.body;
      if (!text || typeof text !== "string" || text.trim().length < 50) {
        return res.status(400).json({ message: "Текст слишком короткий или пустой" });
      }
      const content = text.trim();
      if (!content.includes("youtube.com") && !content.includes(".youtube.com")) {
        return res.status(400).json({ message: "Текст не содержит cookies от YouTube" });
      }

      if (isVpsConfigured()) {
        const result = await vpsUploadCookies(content);
        log(`Cookies (text) uploaded to VPS: ${result.entries} entries`, "routes");
        res.json({ ok: true, entries: result.entries, vps: true });
      } else {
        const cookiesPath = path.join(process.cwd(), "cookies.txt");
        fs.writeFileSync(cookiesPath, content, "utf-8");
        const entries = content.split("\n").filter((l: string) => l.trim() && !l.startsWith("#")).length;
        res.json({ ok: true, entries, vps: false });
      }
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.delete("/api/cookies", async (_req, res) => {
    try {
      if (isVpsConfigured()) {
        await vpsDeleteCookies();
      }
      const cookiesPath = path.join(process.cwd(), "cookies.txt");
      if (fs.existsSync(cookiesPath)) fs.unlinkSync(cookiesPath);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // === Sounds (background audio) API ===
  app.get("/api/sounds", async (_req, res) => {
    try {
      if (!isVpsConfigured()) return res.json({ sounds: [] });
      const data = await vpsSoundsList();
      res.json(data);
    } catch (err: any) {
      log(`Sounds list error: ${err.message}`, "sounds");
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/sounds/upload", multer({ dest: path.join(process.cwd(), "private_uploads"), limits: { fileSize: 50 * 1024 * 1024 } }).single("file"), async (req, res) => {
    try {
      if (!isVpsConfigured()) return res.status(400).json({ message: "VPS not configured" });
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });
      const fileBuffer = fs.readFileSync(req.file.path);
      const customName = typeof req.body.name === "string" ? req.body.name : undefined;
      const result = await vpsSoundsUpload(fileBuffer, req.file.originalname, customName);
      try { fs.unlinkSync(req.file.path); } catch {}
      res.json(result);
    } catch (err: any) {
      log(`Sounds upload error: ${err.message}`, "sounds");
      if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
      res.status(500).json({ message: err.message });
    }
  });

  app.delete("/api/sounds/:soundId", async (req, res) => {
    try {
      if (!isVpsConfigured()) return res.status(400).json({ message: "VPS not configured" });
      await vpsSoundsDelete(req.params.soundId);
      res.json({ ok: true });
    } catch (err: any) {
      log(`Sounds delete error: ${err.message}`, "sounds");
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/sounds/file/:filename", async (req, res) => {
    try {
      if (!isVpsConfigured()) return res.status(400).json({ message: "VPS not configured" });
      const filename = req.params.filename;
      const vpsUrl = `${getVpsUrl()}/sounds/file/${encodeURIComponent(filename)}`;
      const vpsRes = await fetch(vpsUrl, {
        headers: { "Authorization": `Bearer ${getVpsToken()}` },
      });
      if (!vpsRes.ok) return res.status(vpsRes.status).json({ message: "Sound not found" });
      const contentType = vpsRes.headers.get("content-type") || "audio/mpeg";
      const contentLength = vpsRes.headers.get("content-length");
      res.setHeader("Content-Type", contentType);
      if (contentLength) res.setHeader("Content-Length", contentLength);
      res.setHeader("Accept-Ranges", "bytes");
      const { Readable } = await import("stream");
      Readable.fromWeb(vpsRes.body as any).pipe(res);
    } catch (err: any) {
      log(`Sounds file proxy error: ${err.message}`, "sounds");
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/sounds/download-url", async (req, res) => {
    try {
      if (!isVpsConfigured()) return res.status(400).json({ message: "VPS not configured" });
      const { url, name } = req.body;
      if (!url) return res.status(400).json({ message: "URL is required" });
      const result = await vpsDownloadSoundUrl(url, name);
      res.json(result);
    } catch (err: any) {
      log(`Sounds download-url error: ${err.message}`, "sounds");
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/sounds/search-download", async (req, res) => {
    try {
      if (!isVpsConfigured()) return res.status(400).json({ message: "VPS not configured" });
      const { query, name } = req.body;
      if (!query) return res.status(400).json({ message: "Query is required" });
      const result = await vpsSearchDownloadSound(query, name);
      res.json(result);
    } catch (err: any) {
      log(`Sounds search-download error: ${err.message}`, "sounds");
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/sounds/batch-download", async (req, res) => {
    try {
      if (!isVpsConfigured()) return res.status(400).json({ message: "VPS not configured" });
      const { tracks } = req.body;
      if (!Array.isArray(tracks) || tracks.length === 0) return res.status(400).json({ message: "tracks array is required" });
      
      const results: Array<{ query: string; success: boolean; filename?: string; error?: string }> = [];
      for (const track of tracks) {
        const query = typeof track === "string" ? track : track.query;
        const name = typeof track === "string" ? undefined : track.name;
        try {
          const result = await vpsSearchDownloadSound(query, name);
          results.push({ query, success: true, filename: result.filename });
          log(`Batch download OK: "${query}" -> ${result.filename}`, "sounds");
        } catch (err: any) {
          results.push({ query, success: false, error: err.message });
          log(`Batch download FAIL: "${query}" -> ${err.message}`, "sounds");
        }
      }
      const succeeded = results.filter(r => r.success).length;
      res.json({ results, total: tracks.length, succeeded, failed: tracks.length - succeeded });
    } catch (err: any) {
      log(`Batch download error: ${err.message}`, "sounds");
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/videos/youtube", async (req, res) => {
    try {
      const { url, profileId, contentType, maxHeight } = req.body;
      if (!url) return res.status(400).json({ message: "URL required" });

      const ytUrlRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//;
      if (!ytUrlRegex.test(url)) {
        return res.status(400).json({ message: "Invalid YouTube URL" });
      }

      const video = await storage.createVideo({
        filename: "pending_download",
        originalName: url,
        filepath: "pending",
        fileSize: null,
        youtubeUrl: url,
        duration: null,
        width: null,
        height: null,
        profileId: profileId || null,
        contentType: contentType || "poker",
        status: "queued",
        thumbnailPath: null,
        transcription: null,
        highlights: null,
        pipelineStep: "queued",
        pipelineProgress: 0,
        pipelineError: null,
      });

      res.json(video);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/videos/twitch", async (req, res) => {
    try {
      const { url: rawUrl, profileId, contentType } = req.body;
      if (!rawUrl) return res.status(400).json({ message: "URL required" });

      let url = rawUrl.trim();
      if (!/^https?:\/\//i.test(url)) {
        url = `https://${url}`;
      }

      try {
        const parsed = new URL(url);
        const allowedHosts = ["www.twitch.tv", "twitch.tv", "clips.twitch.tv"];
        if (!allowedHosts.includes(parsed.hostname)) {
          return res.status(400).json({ message: "Invalid Twitch URL" });
        }
      } catch {
        return res.status(400).json({ message: "Invalid Twitch URL" });
      }

      const video = await storage.createVideo({
        filename: "pending_download",
        originalName: url,
        filepath: "pending",
        fileSize: null,
        youtubeUrl: url,
        duration: null,
        width: null,
        height: null,
        profileId: profileId || null,
        contentType: contentType || "poker",
        status: "queued",
        thumbnailPath: null,
        transcription: null,
        highlights: null,
        pipelineStep: "queued",
        pipelineProgress: 0,
        pipelineError: null,
      });

      res.json(video);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/videos/kick", async (req, res) => {
    try {
      const { url: rawUrl, profileId, contentType } = req.body;
      if (!rawUrl) return res.status(400).json({ message: "URL required" });

      let url = rawUrl.trim();
      if (!/^https?:\/\//i.test(url)) {
        url = `https://${url}`;
      }

      try {
        const parsed = new URL(url);
        const allowedHosts = ["www.kick.com", "kick.com"];
        if (!allowedHosts.includes(parsed.hostname)) {
          return res.status(400).json({ message: "Invalid Kick URL" });
        }
      } catch {
        return res.status(400).json({ message: "Invalid Kick URL" });
      }

      const video = await storage.createVideo({
        filename: "pending_download",
        originalName: url,
        filepath: "pending",
        fileSize: null,
        youtubeUrl: url,
        duration: null,
        width: null,
        height: null,
        profileId: profileId || null,
        contentType: contentType || "poker",
        status: "queued",
        thumbnailPath: null,
        transcription: null,
        highlights: null,
        pipelineStep: "queued",
        pipelineProgress: 0,
        pipelineError: null,
      });

      res.json(video);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/videos/vkvideo", async (req, res) => {
    try {
      const { url: rawUrl, profileId, contentType } = req.body;
      if (!rawUrl) return res.status(400).json({ message: "URL required" });

      let url = rawUrl.trim();
      if (!/^https?:\/\//i.test(url)) {
        url = `https://${url}`;
      }

      try {
        const parsed = new URL(url);
        const allowedHosts = ["vkvideo.ru", "www.vkvideo.ru", "vk.com", "www.vk.com"];
        if (!allowedHosts.includes(parsed.hostname)) {
          return res.status(400).json({ message: "Invalid VK Video URL" });
        }
      } catch {
        return res.status(400).json({ message: "Invalid VK Video URL" });
      }

      const video = await storage.createVideo({
        filename: "pending_download",
        originalName: url,
        filepath: "pending",
        fileSize: null,
        youtubeUrl: url,
        duration: null,
        width: null,
        height: null,
        profileId: profileId || null,
        contentType: contentType || "streamer",
        status: "queued",
        thumbnailPath: null,
        transcription: null,
        highlights: null,
        pipelineStep: "queued",
        pipelineProgress: 0,
        pipelineError: null,
      });

      res.json(video);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/videos/gdrive", async (req, res) => {
    try {
      const { url: rawUrl, profileId, contentType } = req.body;
      if (!rawUrl) return res.status(400).json({ message: "URL required" });

      let url = rawUrl.trim();

      const gdriveRegex = /^(https?:\/\/)?(drive\.google\.com|docs\.google\.com)\//;
      if (!gdriveRegex.test(url)) {
        return res.status(400).json({ message: "Invalid Google Drive URL" });
      }

      const fileIdMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
      if (!fileIdMatch) {
        return res.status(400).json({ message: "Could not extract file ID from Google Drive URL" });
      }

      const video = await storage.createVideo({
        filename: "pending_download",
        originalName: url,
        filepath: "pending",
        fileSize: null,
        youtubeUrl: url,
        duration: null,
        width: null,
        height: null,
        profileId: profileId || null,
        contentType: contentType || "poker",
        status: "queued",
        thumbnailPath: null,
        transcription: null,
        highlights: null,
        pipelineStep: "queued",
        pipelineProgress: 0,
        pipelineError: null,
      });

      res.json(video);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/videos/:id/process", async (req, res) => {
    try {
      const video = await storage.getVideo(paramId(req));
      if (!video) return res.status(404).json({ message: "Video not found" });

      if (video.status === "processing") {
        return res.status(400).json({ message: "Already processing" });
      }

      const analysisMode = req.body?.analysisMode === "all" ? "all" : "highlights";
      const maxHeight = req.body?.maxHeight ? parseInt(req.body.maxHeight) : undefined;
      const trimStart = req.body?.trimStart != null ? Number(req.body.trimStart) : undefined;
      const trimEnd = req.body?.trimEnd != null ? Number(req.body.trimEnd) : undefined;

      await storage.updateVideo(video.id, {
        status: "processing",
        pipelineStep: "queued",
        pipelineProgress: 0,
        pipelineError: null,
        analysisMode,
      });

      const transcribeOnly = req.body?.transcribeOnly === true;

      res.json({ message: "Pipeline started", videoId: video.id, analysisMode });

      runPipeline(video.id, video.youtubeUrl || undefined, analysisMode as "highlights" | "all", maxHeight, trimStart, trimEnd, false, transcribeOnly).catch((err) => {
        log(`Pipeline error for ${video.id}: ${err.message}`, "pipeline");
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/videos/:id/cancel", async (req, res) => {
    try {
      const video = await storage.getVideo(paramId(req));
      if (!video) return res.status(404).json({ message: "Video not found" });

      if (video.status !== "processing") {
        return res.status(400).json({ message: "Not processing" });
      }

      cancelPipeline(video.id);
      res.json({ message: "Cancel requested", videoId: video.id });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/videos/:id/resume-runpod", async (req, res) => {
    try {
      const video = await storage.getVideo(paramId(req));
      if (!video) return res.status(404).json({ message: "Video not found" });

      const runpodMatch = video.pipelineError?.match(/^runpod_(whisperx_)?job:([^:]+)(:transcribe_only)?$/);
      if (!runpodMatch) {
        return res.status(400).json({ message: "No RunPod job to resume" });
      }

      const isWhisperXJob = !!runpodMatch[1];
      const jobId = runpodMatch[2];
      const isTranscribeOnly = !!runpodMatch[3];
      log(`Manual resume RunPod ${isWhisperXJob ? 'WhisperX' : 'Faster Whisper'} job ${jobId} for video ${video.id} (transcribeOnly: ${isTranscribeOnly})`);
      resumeRunPodPipeline(video.id, video.vpsVideoId!, jobId, isWhisperXJob, isTranscribeOnly).catch((err: any) => {
        log(`RunPod resume failed for ${video.id}: ${err.message}`);
      });

      res.json({ message: "Resume started", jobId });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/videos/:id/reanalyze", async (req, res) => {
    try {
      const video = await storage.getVideo(paramId(req));
      if (!video) return res.status(404).json({ message: "Video not found" });

      if (video.status === "processing") {
        return res.status(400).json({ message: "Already processing" });
      }

      if (!video.transcription) {
        return res.status(400).json({ message: "No transcription — use full process instead" });
      }

      const analysisMode = req.body?.mode === "all" ? "all" : "highlights";

      await storage.updateVideo(video.id, {
        status: "processing",
        pipelineStep: "queued",
        pipelineProgress: 0,
        pipelineError: null,
        analysisMode,
      });

      res.json({ message: "Re-analysis started", videoId: video.id, mode: analysisMode });

      reanalyzePipeline(video.id, analysisMode as "highlights" | "all").catch((err) => {
        log(`Re-analysis error for ${video.id}: ${err.message}`, "pipeline");
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/videos/:id/resplit-segments", async (req, res) => {
    try {
      const video = await storage.getVideo(paramId(req));
      if (!video) return res.status(404).json({ message: "Video not found" });

      const segments = (video as any).transcriptionSegments || [];
      if (!segments.length) return res.status(400).json({ message: "No segments to split" });

      const before = segments.length;
      const split = splitLongSegments(segments);
      await storage.updateVideo(paramId(req), { transcriptionSegments: split });

      res.json({ message: "Segments resplit", before, after: split.length });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/videos/:id/realign", async (req, res) => {
    try {
      const video = await storage.getVideo(paramId(req));
      if (!video) return res.status(404).json({ message: "Video not found" });

      if (video.status === "processing") {
        return res.status(400).json({ message: "Already processing" });
      }

      if (!video.transcription || !video.transcriptionSegments) {
        return res.status(400).json({ message: "No transcription — use full process instead" });
      }

      const analysisMode = req.body?.mode === "all" ? "all" : "highlights";

      res.json({ message: "Realign+Analyze started", videoId: video.id, mode: analysisMode });

      realignAndAnalyzePipeline(video.id, analysisMode as "highlights" | "all").catch((err) => {
        log(`Realign+Analyze error for ${video.id}: ${err.message}`, "pipeline");
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.patch("/api/videos/:id/transcript", async (req, res) => {
    try {
      const video = await storage.getVideo(paramId(req));
      if (!video) return res.status(404).json({ message: "Video not found" });

      const { segments } = req.body;
      if (!Array.isArray(segments)) {
        return res.status(400).json({ message: "segments must be an array" });
      }

      const updated = await storage.updateVideo(video.id, {
        transcriptionSegments: segments,
        transcription: segments.map((s: any) => s.text).join(" "),
      } as any);

      res.json({ message: "Transcript updated", segmentCount: segments.length });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/videos/:id/rewhisper", async (req, res) => {
    try {
      const video = await storage.getVideo(paramId(req));
      if (!video) return res.status(404).json({ message: "Video not found" });

      if (video.status === "processing") {
        return res.status(400).json({ message: "Already processing" });
      }

      const analysisMode = req.body?.mode === "all" ? "all" : "highlights";
      const transcribeOnly = req.body?.transcribeOnly === true;

      const updateFields: any = {
        status: "processing",
        pipelineStep: "starting",
        pipelineProgress: 5,
        pipelineError: null,
        analysisMode,
        transcription: null,
        transcriptionSegments: null,
      };
      if (!transcribeOnly) {
        updateFields.highlights = null;
      }
      await storage.updateVideo(video.id, updateFields);

      res.json({ message: "Re-whisper started", videoId: video.id, mode: analysisMode });

      rewhisperPipeline(video.id, analysisMode as "highlights" | "all", transcribeOnly).catch((err) => {
        log(`Re-whisper error for ${video.id}: ${err.message}`, "pipeline");
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/videos/:id/clip-thumbnail", async (req, res) => {
    try {
      const video = await storage.getVideo(paramId(req));
      if (!video) return res.status(404).json({ message: "Video not found" });
      if (!isVpsConfigured() || !video.vpsVideoId) {
        return res.status(400).json({ message: "VPS not configured or video not on VPS" });
      }
      const { startTime, endTime, calibration, contentType, text, frameTime } = req.body;
      if (startTime == null || endTime == null) {
        return res.status(400).json({ message: "Missing startTime or endTime" });
      }
      const buffer = await vpsGenerateClipThumbnail(
        video.vpsVideoId, startTime, endTime, calibration,
        contentType || video.contentType || undefined, text, frameTime
      );
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Content-Disposition", `attachment; filename="thumbnail_${paramId(req)}.jpg"`);
      res.send(buffer);
    } catch (err: any) {
      log(`Clip thumbnail error: ${err.message}`, "routes");
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/videos/:id/preview-clip", async (req, res) => {
    try {
      const video = await storage.getVideo(paramId(req));
      if (!video) return res.status(404).json({ message: "Video not found" });
      if (!isVpsConfigured() || !video.vpsVideoId) {
        return res.status(400).json({ message: "VPS not configured or video not on VPS" });
      }
      const { startTime, endTime, calibration, subtitleSegments: reqSubtitleSegments, bgAudioFilename, bgAudioVolume, muteOriginalAudio, musicDropTime, musicDropVolumeBefore, captionPositionY, uniqualize, filterPreset, subtitleOffsetMs, captionStyle, bleepProfanity, videoFilter, musicStartOffset, voiceVolume } = req.body;
      if (startTime == null || endTime == null || !calibration || (!calibration.table && !calibration.webcam)) {
        return res.status(400).json({ message: "Missing startTime, endTime, or calibration (need table or webcam)" });
      }
      let subtitleSegments = reqSubtitleSegments;
      if (bleepProfanity && (!subtitleSegments || subtitleSegments.length === 0) && video.transcriptionSegments) {
        subtitleSegments = (video.transcriptionSegments as any[]).filter(
          (seg: any) => seg.end >= startTime && seg.start <= endTime
        );
        log(`Preview-clip: enriched ${subtitleSegments.length} subtitle segments from stored transcription for bleep`, "routes");
      }
      const result = await vpsPreviewClip(video.vpsVideoId, startTime, endTime, calibration, video.contentType || undefined, subtitleSegments, bgAudioFilename, bgAudioVolume, muteOriginalAudio, musicDropTime, musicDropVolumeBefore, captionPositionY, uniqualize, filterPreset, subtitleOffsetMs, captionStyle, bleepProfanity === true, videoFilter, musicStartOffset, voiceVolume);
      const vpsBaseUrl = getVpsUrl();
      const cacheBust = `t=${Date.now()}`;
      const directUrl = result.publicUrl ? `${vpsBaseUrl}${result.publicUrl}?${cacheBust}` : `/api/videos/${paramId(req)}/preview-clip-file?vpsPath=${encodeURIComponent(result.url)}&${cacheBust}`;
      res.json({ url: directUrl });
    } catch (err: any) {
      log(`Preview clip error: ${err.message}`, "routes");
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/videos/:id/preview-clip-file", async (req, res) => {
    try {
      const video = await storage.getVideo(paramId(req));
      if (!video) return res.status(404).json({ message: "Video not found" });
      const vpsPath = req.query.vpsPath as string;
      if (!vpsPath) return res.status(400).json({ message: "Missing vpsPath" });
      const vpsUrl = getVpsUrl();
      const vpsToken = getVpsToken();
      const fullUrl = `${vpsUrl}${vpsPath}`;
      const response = await fetch(fullUrl, {
        headers: { "Authorization": `Bearer ${vpsToken}`, ...(req.headers.range ? { "Range": req.headers.range } : {}) },
      });
      if (!response.ok) return res.status(response.status).json({ message: "VPS error" });
      res.setHeader("Content-Type", "video/mp4");
      if (response.headers.get("content-length")) res.setHeader("Content-Length", response.headers.get("content-length")!);
      if (response.headers.get("content-range")) {
        res.status(206);
        res.setHeader("Content-Range", response.headers.get("content-range")!);
        res.setHeader("Accept-Ranges", "bytes");
      }
      const reader = response.body as any;
      if (reader?.pipe) {
        reader.pipe(res);
      } else if (reader?.getReader) {
        const r = reader.getReader();
        const pump = async () => {
          while (true) {
            const { done, value } = await r.read();
            if (done) { res.end(); break; }
            res.write(value);
          }
        };
        pump().catch(() => res.end());
      } else {
        const buf = Buffer.from(await response.arrayBuffer());
        res.end(buf);
      }
    } catch (err: any) {
      log(`Preview clip file proxy error: ${err.message}`, "routes");
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/videos/:id/correct-clip", async (req, res) => {
    try {
      const video = await storage.getVideo(paramId(req));
      if (!video) return res.status(404).json({ message: "Video not found" });

      const { startTime, endTime } = req.body;
      if (typeof startTime !== "number" || typeof endTime !== "number" ||
          !Number.isFinite(startTime) || !Number.isFinite(endTime) ||
          startTime >= endTime || endTime - startTime > 600) {
        return res.status(400).json({ message: "Invalid startTime/endTime (must be finite numbers, startTime < endTime, max 10 min)" });
      }

      const segments = (video.transcriptionSegments || []) as TranscriptSegment[];
      if (segments.length === 0) {
        return res.status(400).json({ message: "No transcript segments" });
      }

      if (!video.vpsVideoId) {
        return res.status(400).json({ message: "Video not uploaded to VPS" });
      }

      const { correctClipWithGpt4oTranscribe } = await import("./ai-pipeline");
      log(`AI correct clip: ${video.id} (${startTime}-${endTime}s)`, "routes");

      const { updatedSegments, correctedCount } = await correctClipWithGpt4oTranscribe(segments, startTime, endTime, video.vpsVideoId);

      await storage.updateVideo(video.id, {
        transcriptionSegments: updatedSegments,
        transcription: updatedSegments.map((s: TranscriptSegment) => s.text).join(" "),
      } as any);

      log(`AI correct clip done: ${correctedCount} segments corrected`, "routes");
      res.json({ correctedCount, totalSegments: updatedSegments.length });
    } catch (err: any) {
      log(`AI correct clip error: ${err.message}`, "routes");
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/videos/:id/align-clip", async (req, res) => {
    try {
      const video = await storage.getVideo(paramId(req));
      if (!video) return res.status(404).json({ message: "Video not found" });

      const { startTime, endTime } = req.body;
      if (typeof startTime !== "number" || typeof endTime !== "number") {
        return res.status(400).json({ message: "startTime and endTime required" });
      }

      const vpsVideoId = video.vpsVideoId;
      if (!vpsVideoId || !isVpsConfigured()) {
        return res.status(400).json({ message: "VPS required for alignment" });
      }

      const segments = (video.transcriptionSegments || []) as TranscriptSegment[];
      const clipSegments = segments.filter(
        (s: TranscriptSegment) => s.end > startTime && s.start < endTime && s.text.trim().length > 0
      );

      if (clipSegments.length === 0) {
        return res.status(400).json({ message: "No transcript segments in this range" });
      }

      const { vpsAlignClip } = await import("./vps-client");
      const inputSegs = clipSegments.map((s: TranscriptSegment) => ({ start: s.start, end: s.end, text: s.text }));

      log(`Align clip: ${vpsVideoId} (${startTime}-${endTime}s, ${inputSegs.length} segments)`, "routes");
      const alignedSegments = await vpsAlignClip(vpsVideoId, startTime, endTime, inputSegs);

      if (!alignedSegments || alignedSegments.length === 0) {
        return res.status(500).json({ message: "WhisperX returned no results" });
      }

      const allAlignedWords: { word: string; start: number; end: number }[] = [];
      for (const aseg of alignedSegments) {
        if (aseg.words) {
          for (const w of aseg.words) {
            if (typeof w.start === "number" && typeof w.end === "number") {
              allAlignedWords.push({ word: w.word, start: w.start, end: w.end });
            }
          }
        }
      }
      allAlignedWords.sort((a, b) => a.start - b.start);

      log(`Align clip: ${allAlignedWords.length} total aligned words, range ${allAlignedWords[0]?.start?.toFixed(1)}-${allAlignedWords[allAlignedWords.length-1]?.end?.toFixed(1)}`, "routes");

      const updatedSegments: TranscriptSegment[] = [];
      for (const seg of segments) {
        if (seg.end <= startTime || seg.start >= endTime || seg.text.trim().length === 0) {
          updatedSegments.push(seg);
          continue;
        }

        const segWords = allAlignedWords.filter(w => w.start >= seg.start - 0.5 && w.end <= seg.end + 0.5);

        if (segWords.length === 0) {
          updatedSegments.push(seg);
          continue;
        }

        const segTextWords = seg.text.split(/\s+/).filter((w: string) => w.trim());
        if (Math.abs(segWords.length - segTextWords.length) <= 3 || segTextWords.length <= segWords.length + 5) {
          updatedSegments.push({
            ...seg,
            words: segWords.map(w => ({ word: w.word, start: w.start, end: w.end })),
          });
        } else {
          const newSegs: TranscriptSegment[] = [];
          let chunkStart = 0;
          const CHUNK_SIZE = 15;
          while (chunkStart < segWords.length) {
            const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, segWords.length);
            const chunkWords = segWords.slice(chunkStart, chunkEnd);
            const text = chunkWords.map(w => w.word).join(" ");
            newSegs.push({
              start: chunkWords[0].start,
              end: chunkWords[chunkWords.length - 1].end,
              text,
              words: chunkWords.map(w => ({ word: w.word, start: w.start, end: w.end })),
            } as TranscriptSegment);
            chunkStart = chunkEnd;
          }
          updatedSegments.push(...newSegs);
        }
      }

      await storage.updateVideo(video.id, { transcriptionSegments: updatedSegments });

      const enrichedCount = updatedSegments.filter(
        (s: TranscriptSegment) => s.words && s.words.length > 0 && s.end > startTime && s.start < endTime
      ).length;
      const totalWords = updatedSegments.reduce((sum: number, s: TranscriptSegment) => sum + (s.words?.length || 0), 0);

      log(`Align clip done: ${enrichedCount} segments enriched, ${totalWords} words`, "routes");
      res.json({ enrichedSegments: enrichedCount, totalWords, segments: updatedSegments });
    } catch (err: any) {
      log(`Align clip error: ${err.message}`, "routes");
      res.status(500).json({ message: err.message });
    }
  });

  app.delete("/api/videos/:id", async (req, res) => {
    try {
      const video = await storage.getVideo(paramId(req));
      if (video) {
        if (video.filepath && video.filepath !== "pending" && fs.existsSync(video.filepath)) {
          fs.unlinkSync(video.filepath);
        }
        if (video.thumbnailPath && fs.existsSync(video.thumbnailPath)) {
          fs.unlinkSync(video.thumbnailPath);
        }
      }
      await storage.deleteVideo(paramId(req));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/videos/:id/frame", async (req, res) => {
    try {
      const video = await storage.getVideo(paramId(req));
      if (!video) return res.status(404).json({ message: "Video not found" });

      const time = parseFloat((req.query.t as string) || "10");
      const frameFile = `frame_${video.id}_${Math.round(time)}.jpg`;
      const framePath = path.join(FRAMES_DIR, frameFile);

      if (!fs.existsSync(framePath)) {
        if (video.vpsVideoId && video.filepath === "vps" && isVpsConfigured()) {
          await vpsExtractFrame(video.vpsVideoId, time, framePath);
        } else if (video.filepath && video.filepath !== "pending" && video.filepath !== "vps") {
          await extractFrame(video.filepath, framePath, time);
        } else {
          return res.status(400).json({ message: "Video not available for frame extraction" });
        }
      }

      res.sendFile(framePath);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/videos/:id/regenerate-preview", async (req, res) => {
    try {
      const video = await storage.getVideo(paramId(req));
      if (!video) return res.status(404).json({ message: "Video not found" });
      if (!video.vpsVideoId || !isVpsConfigured()) {
        return res.status(400).json({ message: "VPS not configured or no VPS video" });
      }
      const result = await vpsRegeneratePreview(video.vpsVideoId);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to regenerate preview" });
    }
  });

  app.post("/api/videos/:id/stop-preview", async (req, res) => {
    try {
      const video = await storage.getVideo(paramId(req));
      if (!video) return res.status(404).json({ message: "Video not found" });
      if (!video.vpsVideoId || !isVpsConfigured()) {
        return res.json({ status: "not_configured" });
      }
      const result = await vpsStopPreview(video.vpsVideoId);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/videos/:id/preview-progress", async (req, res) => {
    try {
      const video = await storage.getVideo(paramId(req));
      if (!video) return res.status(404).json({ message: "Video not found" });
      if (!video.vpsVideoId || !isVpsConfigured()) {
        return res.json({ status: "none" });
      }
      const vpsUrl = getVpsUrl();
      const vpsToken = getVpsToken();
      const checkRes = await fetch(`${vpsUrl}/preview/${video.vpsVideoId}`, {
        headers: { "Authorization": `Bearer ${vpsToken}`, "Range": "bytes=0-0" },
      });
      if (checkRes.status === 202) {
        const data = await checkRes.json() as any;
        return res.json({ status: "generating", progress: data.progress || 0 });
      }
      if (checkRes.status === 200 || checkRes.status === 206) {
        return res.json({ status: "ready" });
      }
      return res.json({ status: "none" });
    } catch (err: any) {
      res.json({ status: "error", message: err.message });
    }
  });

  app.post("/api/videos/:id/auto-calibrate", async (req, res) => {
    try {
      const video = await storage.getVideo(paramId(req));
      if (!video) return res.status(404).json({ message: "Video not found" });

      const time = parseFloat((req.query.t as string) || "10");
      const frameFile = `frame_${video.id}_${Math.round(time)}.jpg`;
      const framePath = path.join(FRAMES_DIR, frameFile);

      if (!fs.existsSync(framePath)) {
        if (video.vpsVideoId && video.filepath === "vps" && isVpsConfigured()) {
          await vpsExtractFrame(video.vpsVideoId, time, framePath);
        } else if (video.filepath && video.filepath !== "pending" && video.filepath !== "vps") {
          await extractFrame(video.filepath, framePath, time);
        } else {
          return res.status(400).json({ message: "Видео недоступно" });
        }
      }

      let hint: { table?: any; webcam?: any } | undefined;
      const profileId = req.query.profileId as string;
      if (profileId) {
        const profile = await storage.getProfile(profileId);
        if (profile?.calibration) {
          const cal = profile.calibration as CalibrationData;
          hint = { table: cal.table, webcam: cal.webcam };
        }
      }

      const contentType = (req.query.contentType as string) || video.contentType || "poker";
      const result = await detectRegionsWithAI(framePath, hint, contentType);

      const TARGET_ASPECT = (886 - 12) / (827 - 236);
      function adjustToAspect(box: any) {
        if (!box || !box.width || !box.height) return box;
        const currentAspect = box.width / box.height;
        let w = box.width, h = box.height, x = box.x, y = box.y;
        if (currentAspect > TARGET_ASPECT) {
          const newW = Math.round(h * TARGET_ASPECT);
          x = x + Math.round((w - newW) / 2);
          w = newW;
        } else {
          const newH = Math.round(w / TARGET_ASPECT);
          y = y + Math.round((h - newH) / 2);
          h = newH;
        }
        return { x, y, width: w, height: h };
      }
      if (result.table) result.table = adjustToAspect(result.table);
      if (result.webcam) result.webcam = adjustToAspect(result.webcam);

      res.json(result);
    } catch (err: any) {
      log(`Auto-calibrate error: ${err.message}`, "routes");
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/files/thumbnail/:id", async (req, res) => {
    try {
      const video = await storage.getVideo(paramId(req));
      if (!video || !video.thumbnailPath || !fs.existsSync(video.thumbnailPath)) {
        return res.status(404).json({ message: "Thumbnail not found" });
      }
      res.sendFile(video.thumbnailPath);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/files/export-thumbnail/:exportId", async (req, res) => {
    try {
      const exportJob = await storage.getExportJob(req.params.exportId);
      if (!exportJob || !exportJob.thumbnailPath || !fs.existsSync(exportJob.thumbnailPath)) {
        return res.status(404).json({ message: "Thumbnail not found" });
      }
      res.sendFile(exportJob.thumbnailPath);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/files/clean-export/:exportId", async (req, res) => {
    try {
      const exportJob = await storage.getExportJob(req.params.exportId);
      if (!exportJob || !exportJob.cleanOutputPath || !fs.existsSync(exportJob.cleanOutputPath)) {
        return res.status(404).json({ message: "Clean export not found" });
      }
      const clip = await storage.getClip(exportJob.clipId);
      const rawName = clip?.title ? `clean_${clip.title.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 60)}.mp4` : `clean_${exportJob.id}.mp4`;
      const utfName = clip?.title ? `clean_${clip.title.substring(0, 60)}.mp4` : rawName;
      const isDownload = req.query.download === "1";
      if (isDownload) {
        res.setHeader("Content-Disposition", `attachment; filename="${rawName}"; filename*=UTF-8''${encodeURIComponent(utfName)}`);
      } else {
        res.setHeader("Content-Disposition", `inline; filename="${rawName}"; filename*=UTF-8''${encodeURIComponent(utfName)}`);
      }
      res.setHeader("Content-Type", "video/mp4");
      res.sendFile(path.resolve(exportJob.cleanOutputPath));
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/exports/:id/clean", async (req, res) => {
    try {
      const job = await storage.getExportJob(paramId(req));
      if (!job) return res.status(404).json({ message: "Export not found" });
      if (job.cleanOutputPath && fs.existsSync(job.cleanOutputPath)) {
        return res.json({ status: "exists", path: job.cleanOutputPath });
      }
      if (cleanExportInProgress.has(String(job.id))) {
        return res.json({ status: "in_progress" });
      }
      triggerCleanExport(String(job.id), storage).catch(() => {});
      res.json({ status: "started" });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  let cleanQueueRunning = false;
  async function runCleanQueue() {
    if (cleanQueueRunning) return;
    cleanQueueRunning = true;
    try {
      const jobs = await storage.getExportJobs();
      const candidates = jobs.filter(j =>
        j.status === "completed" &&
        j.publishedTo && j.publishedTo.length > 0 &&
        !j.isPreview &&
        j.cleanOutputPath !== "skip" &&
        (!j.cleanOutputPath || !fs.existsSync(j.cleanOutputPath))
      );
      log(`[clean-export] Queue: ${candidates.length} pending clean exports`, "exporter");
      for (const job of candidates) {
        await triggerCleanExport(String(job.id), storage);
      }
      log(`[clean-export] Queue finished: ${candidates.length} processed`, "exporter");
    } catch (err: any) {
      log(`[clean-export] Queue error: ${err.message}`, "exporter");
    } finally {
      cleanQueueRunning = false;
    }
  }

  app.post("/api/exports/clean-all", async (_req, res) => {
    try {
      const jobs = await storage.getExportJobs();
      const candidates = jobs.filter(j =>
        j.status === "completed" &&
        j.publishedTo && j.publishedTo.length > 0 &&
        !j.isPreview &&
        j.cleanOutputPath !== "skip" &&
        (!j.cleanOutputPath || !fs.existsSync(j.cleanOutputPath))
      );
      if (cleanQueueRunning) {
        return res.json({ started: 0, total: candidates.length, message: "Already running" });
      }
      runCleanQueue().catch(() => {});
      res.json({ started: candidates.length, total: candidates.length });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  setTimeout(() => {
    console.log("[clean-export] Auto-starting clean queue for published exports...");
    runCleanQueue().catch((e) => console.error("[clean-export] Queue failed:", e));
  }, 10000);

  app.get("/api/clips", async (req, res) => {
    try {
      const videoId = req.query.videoId as string;
      if (videoId) {
        const clips = await storage.getClipsByVideoId(videoId);
        res.json(clips);
      } else {
        const clips = await storage.getClips();
        res.json(clips);
      }
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/clips", async (req, res) => {
    try {
      const { videoId, startTime, endTime, title } = req.body;
      if (!videoId || startTime === undefined || endTime === undefined) {
        return res.status(400).json({ message: "videoId, startTime, endTime required" });
      }
      if (endTime <= startTime) {
        return res.status(400).json({ message: "endTime must be greater than startTime" });
      }
      if (endTime - startTime < 3) {
        return res.status(400).json({ message: "Minimum clip duration is 3 seconds" });
      }
      if (endTime - startTime > 120) {
        return res.status(400).json({ message: "Максимальная длина клипа — 120 секунд" });
      }

      const video = await storage.getVideo(videoId);
      if (!video) return res.status(404).json({ message: "Video not found" });

      const clip = await storage.createClip({
        videoId,
        startTime,
        endTime,
        confidence: 1.0,
        title: title || `Ручной клип ${formatTimeShort(startTime)} - ${formatTimeShort(endTime)}`,
        description: "Создан вручную",
        reasons: ["manual"],
        signals: { manual: 1 },
        status: "approved",
        adjustedStartTime: null,
        adjustedEndTime: null,
      });

      res.json(clip);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.patch("/api/clips/:id", async (req, res) => {
    try {
      const { status, adjustedStartTime, adjustedEndTime, title } = req.body;
      const updates: any = {};
      if (status) updates.status = status;
      if (adjustedStartTime !== undefined) updates.adjustedStartTime = adjustedStartTime;
      if (adjustedEndTime !== undefined) updates.adjustedEndTime = adjustedEndTime;
      if (title !== undefined) updates.title = title;

      const clip = await storage.updateClip(paramId(req), updates);
      res.json(clip);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.delete("/api/clips/:id", async (req, res) => {
    try {
      const clip = await storage.getClip(paramId(req));
      if (!clip) return res.status(404).json({ message: "Clip not found" });
      await storage.deleteClip(paramId(req));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/clips/:id/restore", async (req, res) => {
    try {
      const clip = await storage.restoreClip(paramId(req));
      res.json(clip);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/clips/deleted", async (req, res) => {
    try {
      const videoId = req.query.videoId as string;
      if (!videoId) return res.status(400).json({ message: "videoId required" });
      const clips = await storage.getDeletedClipsByVideoId(videoId);
      res.json(clips);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/clips/:id/export", async (req, res) => {
    try {
      log(`[EXPORT-DEBUG] Received export request for clip ${paramId(req)}, body keys: ${Object.keys(req.body).join(",")}, bleepProfanity=${req.body.bleepProfanity}, isPreview=${req.body.isPreview}`, "exporter");
      const clip = await storage.getClip(paramId(req));
      if (!clip) return res.status(404).json({ message: "Clip not found" });

      const video = await storage.getVideo(clip.videoId);
      if (!video) return res.status(404).json({ message: "Video not found" });

      const { profileId } = req.body;
      if (!profileId) return res.status(400).json({ message: "profileId required" });

      const profile = await storage.getProfile(profileId);
      if (!profile) {
        return res.status(400).json({ message: "Profile not found" });
      }

      const isPreview = req.body.isPreview === true;
      const prefix = isPreview ? "preview" : "short";

      const wantSquare = req.body.aspectRatio === "1:1";
      const ratiosToExport: Array<"9:16" | "1:1"> = wantSquare ? ["9:16", "1:1"] : ["9:16"];

      const allJobs = [];
      for (const ar of ratiosToExport) {
        const outputFile = `${prefix}_${uuidv4()}.mp4`;
        const outputPath = path.join(EXPORTS_DIR, outputFile);
        const job = await storage.createExportJob({
          videoId: video.id,
          clipId: clip.id,
          profileId,
          status: "processing",
          outputPath,
          subtitlesEnabled: false,
          isPreview,
          aspectRatio: ar,
          progress: 0,
          error: null,
        });
        allJobs.push({ job, outputPath, aspectRatio: ar });
      }

      res.json(allJobs.length === 1 ? allJobs[0].job : allJobs.map(j => j.job));

      const startTime = typeof req.body.overrideStartTime === "number" ? req.body.overrideStartTime : (clip.adjustedStartTime ?? clip.startTime);
      const endTime = typeof req.body.overrideEndTime === "number" ? req.body.overrideEndTime : (clip.adjustedEndTime ?? clip.endTime);
      const subtitlesEnabled = !isPreview && req.body.subtitlesEnabled === true;
      const captionEnabled = req.body.captionEnabled === true;
      const muteAudio = req.body.muteAudio === true;
      const bleepProfanity = req.body.bleepProfanity === true;
      const uniqualize = req.body.uniqualize === true;
      const filterPreset = ["subtle", "medium", "strong"].includes(req.body.filterPreset) ? req.body.filterPreset : "medium";
      const videoFilter = typeof req.body.videoFilter === "string" ? req.body.videoFilter : undefined;
      const resolution = req.body.resolution || "1080p";
      const crawlText = typeof req.body.crawlText === "string" ? req.body.crawlText.trim() : undefined;
      const bgAudioFilename = typeof req.body.bgAudioFilename === "string" ? req.body.bgAudioFilename : undefined;
      const bgAudioVolume = typeof req.body.bgAudioVolume === "number" ? req.body.bgAudioVolume : undefined;
      const musicDropTime = typeof req.body.musicDropTime === "number" ? req.body.musicDropTime : undefined;
      const musicDropVolumeBefore = typeof req.body.musicDropVolumeBefore === "number" ? req.body.musicDropVolumeBefore : undefined;
      const musicStartOffset = typeof req.body.musicStartOffset === "number" ? req.body.musicStartOffset : undefined;
      const voiceVolume = typeof req.body.voiceVolume === "number" ? req.body.voiceVolume : undefined;
      const captionPositionY = typeof req.body.captionPositionY === "number" ? req.body.captionPositionY : undefined;
      const subtitleOffsetMs = typeof req.body.subtitleOffsetMs === "number" ? req.body.subtitleOffsetMs : undefined;
      const captionStyle = typeof req.body.captionStyle === "string" ? req.body.captionStyle : undefined;
      const renderEngine = typeof req.body.renderEngine === "string" ? req.body.renderEngine as "vps" | "runpod" : undefined;
      const enableDynamicCamera = req.body.enableDynamicCamera === true;
      const cameraMode: "auto" | "smooth" | "cuts" = (req.body.cameraMode === "smooth" || req.body.cameraMode === "cuts") ? req.body.cameraMode : "auto";
      const useVps = video.vpsVideoId && video.filepath === "vps" && isVpsConfigured();
      const useAiCalibration = req.body.useAiCalibration === true;

      let clipCalibration: CalibrationData | null = null;

      for (const { job, outputPath, aspectRatio } of allJobs) {
        try {
          log(`Export settings: subtitlesEnabled=${subtitlesEnabled}, muteAudio=${muteAudio}, aspectRatio=${aspectRatio}, captionPositionY=${captionPositionY}, startTime=${startTime}, endTime=${endTime}, overrideStart=${req.body.overrideStartTime}, overrideEnd=${req.body.overrideEndTime}`, "exporter");

          await storage.updateExportJob(job.id, { progress: 10 });

          if (!clipCalibration) {
            if (clip.calibration && !useAiCalibration) {
              clipCalibration = clip.calibration as CalibrationData;
              if (video.width && video.height) {
                clipCalibration = scaleCalibration(clipCalibration, video.width, video.height);
              }
              log(`Using clip-specific calibration: table=${JSON.stringify(clipCalibration.table)}, webcam=${JSON.stringify(clipCalibration.webcam)}`, "exporter");
            } else if (profile.calibration && !useAiCalibration) {
              clipCalibration = profile.calibration as CalibrationData;
              if (video.width && video.height) {
                clipCalibration = scaleCalibration(clipCalibration, video.width, video.height);
              }
              log(`Using profile calibration: table=${JSON.stringify(clipCalibration.table)}, webcam=${JSON.stringify(clipCalibration.webcam)}`, "exporter");
            } else {
              const clipMidTime = startTime + Math.min(3, (endTime - startTime) / 2);
              const clipFrameFile = `frame_clip_${clip.id}_${Math.round(clipMidTime)}.jpg`;
              const clipFramePath = path.join(FRAMES_DIR, clipFrameFile);

              log(`Per-clip AI calibration: extracting frame at ${clipMidTime}s for clip ${clip.id}`, "exporter");

              if (!fs.existsSync(clipFramePath)) {
                if (video.vpsVideoId && video.filepath === "vps" && isVpsConfigured()) {
                  await vpsExtractFrame(video.vpsVideoId, clipMidTime, clipFramePath);
                } else if (video.filepath && video.filepath !== "pending" && video.filepath !== "vps") {
                  await extractFrame(video.filepath, clipFramePath, clipMidTime);
                } else {
                  throw new Error("Video not available for frame extraction");
                }
              }

              try {
                const profileHint = profile.calibration ? { table: (profile.calibration as CalibrationData).table, webcam: (profile.calibration as CalibrationData).webcam } : undefined;
                const aiResult = await detectRegionsWithAI(clipFramePath, profileHint);
                clipCalibration = {
                  table: aiResult.table,
                  webcam: aiResult.webcam,
                  chat: aiResult.chat,
                  sourceWidth: aiResult.sourceWidth,
                  sourceHeight: aiResult.sourceHeight,
                };
                log(`Per-clip AI calibration result: table=${JSON.stringify(clipCalibration.table)}, webcam=${JSON.stringify(clipCalibration.webcam)}`, "exporter");
              } catch (aiErr: any) {
                log(`Per-clip AI calibration failed, falling back to profile: ${aiErr.message}`, "exporter");
                if (!profile.calibration) {
                  throw new Error("AI авто-калибровка не удалась и профиль не откалиброван");
                }
                clipCalibration = profile.calibration as CalibrationData;
                if (video.width && video.height) {
                  clipCalibration = scaleCalibration(clipCalibration, video.width, video.height);
                }
              }
            }
          }

          await storage.updateExportJob(job.id, { progress: 10 });

          let resolvedVideoPath = video.filepath;
          if (!useVps && video.vpsVideoId && video.filepath === "vps") {
            resolvedVideoPath = await downloadFromVps(video.vpsVideoId);
          }

          await storage.updateExportJob(job.id, { progress: 15 });

          let effectiveRenderEngine = renderEngine;
          if (effectiveRenderEngine === "runpod") {
            log(`[EXPORT] GPU render requested, ensuring RunPod Pod is running...`, "exporter");
            await storage.updateExportJob(job.id, { progress: 20 });
            try {
              await ensurePodRunning();
              acquireGpuLease();
              log(`[EXPORT] RunPod Pod is ready`, "exporter");
            } catch (podErr: any) {
              log(`[EXPORT] Failed to start RunPod Pod: ${podErr.message}, falling back to VPS`, "exporter");
              effectiveRenderEngine = "vps";
            }
          }

          let clipCameraKfs: CameraKeyframe[] | undefined;
          if (enableDynamicCamera && !isPreview && (video.contentType === "streamer") && clipCalibration?.webcam && useVps && video.vpsVideoId) {
            try {
              log(`[EXPORT] Generating dynamic camera keyframes for clip ${clip.id}`, "exporter");
              clipCameraKfs = await analyzeCameraKeyframes(
                video.vpsVideoId,
                startTime,
                endTime,
                clipCalibration.webcam as any,
                clipCalibration.sourceWidth || video.width || 1920,
                clipCalibration.sourceHeight || video.height || 1080,
              );
              if (clipCameraKfs.length < 2) clipCameraKfs = undefined;
              else {
                if (cameraMode === "smooth") clipCameraKfs = clipCameraKfs.map(kf => ({ ...kf, cut: false }));
                else if (cameraMode === "cuts") clipCameraKfs = clipCameraKfs.map((kf, i) => ({ ...kf, cut: i > 0 }));
                log(`[EXPORT] Got ${clipCameraKfs.length} camera keyframes, mode=${cameraMode}`, "exporter");
              }
            } catch (camErr: any) {
              log(`[EXPORT] Dynamic camera failed: ${camErr.message}, using static crop`, "exporter");
              clipCameraKfs = undefined;
            }
          }

          log(`[EXPORT-DEBUG] Calling exportShort: bleepProfanity=${bleepProfanity}, muteAudio=${muteAudio}, isPreview=${isPreview}, useVps=${useVps}, vpsVideoId=${useVps ? video.vpsVideoId : 'N/A'}, hasSegments=${!!(video.transcriptionSegments?.length)}, dynamicCamera=${!!clipCameraKfs}`, "exporter");
          try {
            await exportShort({
              videoPath: resolvedVideoPath,
              outputPath,
              startTime,
              endTime,
              calibration: clipCalibration,
              subtitlesEnabled: true,
              transcriptSegments: video.transcriptionSegments || undefined,
              vpsVideoId: useVps ? video.vpsVideoId! : undefined,
              isPreview,
              muteAudio,
              bleepProfanity,
              uniqualize,
              filterPreset,
              videoFilter,
              resolution,
              crawlText: (crawlText && crawlText !== "__whisper__") ? crawlText : undefined,
              bgAudioFilename,
              bgAudioVolume,
              musicStartOffset,
              voiceVolume,
              musicDropTime,
              musicDropVolumeBefore,
              captionPositionY,
              subtitleOffsetMs,
              captionStyle,
              renderEngine: effectiveRenderEngine,
              aspectRatio,
              contentType: video.contentType || "poker",
              jobId: String(job.id),
              cameraKeyframes: clipCameraKfs,
              onProgress: async (percent: number) => {
                await storage.updateExportJob(job.id, { progress: percent });
              },
            });
          } finally {
            if (effectiveRenderEngine === "runpod") {
              releaseGpuLease();
            }
          }

          const currentJob = await storage.getExportJob(job.id);
          if (currentJob && currentJob.status !== "error") {
            await storage.updateExportJob(job.id, { status: "completed", progress: 100 });
            log(`Export job ${job.id}${isPreview ? " (preview)" : ""} (${aspectRatio}) completed`, "exporter");

            if (!isPreview && isVpsConfigured() && video.vpsVideoId) {
              try {
                const thumbBuffer = await vpsGenerateClipThumbnail(
                  video.vpsVideoId, startTime, endTime,
                  clipCalibration, video.contentType || "poker"
                );
                const thumbFile = `thumb_${job.id}.jpg`;
                const thumbPath = path.join(THUMBNAILS_DIR, thumbFile);
                fs.writeFileSync(thumbPath, thumbBuffer);
                await storage.updateExportJob(job.id, { thumbnailPath: thumbPath });
                log(`Auto-thumbnail generated for export ${job.id}`, "exporter");
              } catch (thumbErr: any) {
                log(`Auto-thumbnail failed (non-critical): ${thumbErr.message}`, "exporter");
              }
            }
          }
        } catch (err: any) {
          log(`Export job ${job.id} (${aspectRatio}) failed: ${err.message}`, "exporter");
          const currentJob = await storage.getExportJob(job.id);
          if (currentJob && currentJob.status !== "error") {
            await storage.updateExportJob(job.id, { status: "error", error: err.message });
          }
        }
      }
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/exports", async (req, res) => {
    try {
      const videoId = req.query.videoId as string;
      const jobs = await storage.getExportJobs();
      if (videoId) {
        res.json(jobs.filter((j) => j.videoId === videoId));
      } else {
        res.json(jobs);
      }
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/exports/clean", async (_req, res) => {
    try {
      const jobs = await storage.getExportJobs();
      const cleanJobs = jobs.filter(j => j.cleanOutputPath && fs.existsSync(j.cleanOutputPath) && !j.isPreview);
      const clips = await storage.getClips();
      const videos = await storage.getVideos();
      const profiles = await storage.getProfiles();

      const clipsMap = new Map(clips.map(c => [c.id, c]));
      const videosMap = new Map(videos.map(v => [v.id, v]));
      const profilesMap = new Map(profiles.map(p => [p.id, p]));

      const result = cleanJobs.map(j => {
        const clip = clipsMap.get(j.clipId);
        const video = videosMap.get(j.videoId);
        const profile = profilesMap.get(j.profileId);
        const stats = j.cleanOutputPath ? (() => { try { return fs.statSync(j.cleanOutputPath!); } catch { return null; } })() : null;
        return {
          exportId: j.id,
          clipId: j.clipId,
          clipTitle: clip?.title || "Без названия",
          clipStartTime: clip?.startTime,
          clipEndTime: clip?.endTime,
          videoTitle: video?.originalName || video?.filename || "",
          profileId: j.profileId,
          profileName: profile?.name || "Неизвестный",
          aspectRatio: j.aspectRatio || "9:16",
          publishedTo: j.publishedTo || [],
          publishedAt: j.publishedAt,
          createdAt: j.createdAt,
          fileSizeMb: stats ? Math.round(stats.size / 1024 / 1024 * 10) / 10 : null,
        };
      });

      result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/exports/published-today", async (_req, res) => {
    try {
      const jobs = await storage.getExportJobs();
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const published = jobs.filter(j =>
        j.publishedTo && j.publishedTo.length > 0 && !j.isPreview &&
        (j.publishedAt ? new Date(j.publishedAt) >= todayStart : false)
      );
      const total = published.length;
      const byPlatform: Record<string, number> = {};
      for (const j of published) {
        for (const p of (j.publishedTo || [])) {
          byPlatform[p] = (byPlatform[p] || 0) + 1;
        }
      }
      res.json({ total, byPlatform });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/exports/:id/retry", async (req, res) => {
    try {
      const job = await storage.getExportJob(paramId(req));
      if (!job) return res.status(404).json({ message: "Export not found" });
      if (job.status !== "error") {
        return res.status(400).json({ message: "Only failed exports can be retried" });
      }

      const retryMuteAudio = req.body.muteAudio === true;
      const retryBleepProfanity = req.body.bleepProfanity === true;
      const retryAspectRatio = req.body.aspectRatio === "1:1" ? "1:1" : (job.aspectRatio || "9:16");
      const retrySubtitlesEnabled = req.body.subtitlesEnabled === true;
      const retryBgAudioFilename = typeof req.body.bgAudioFilename === "string" ? req.body.bgAudioFilename : undefined;
      const retryBgAudioVolume = typeof req.body.bgAudioVolume === "number" ? req.body.bgAudioVolume : undefined;
      const retryMusicDropVolumeBefore = typeof req.body.musicDropVolumeBefore === "number" ? req.body.musicDropVolumeBefore : undefined;
      const retryMusicStartOffset = typeof req.body.musicStartOffset === "number" ? req.body.musicStartOffset : undefined;
      const retryVoiceVolume = typeof req.body.voiceVolume === "number" ? req.body.voiceVolume : undefined;
      const retryCaptionPositionY = typeof req.body.captionPositionY === "number" ? req.body.captionPositionY : undefined;
      const retrySubtitleOffsetMs = typeof req.body.subtitleOffsetMs === "number" ? req.body.subtitleOffsetMs : undefined;
      const retryCaptionStyle = typeof req.body.captionStyle === "string" ? req.body.captionStyle : undefined;
      const retryRenderEngine = typeof req.body.renderEngine === "string" ? req.body.renderEngine as "vps" | "runpod" : undefined;
      const retryUniqualize = req.body.uniqualize === true;
      const retryFilterPreset = typeof req.body.filterPreset === "string" ? req.body.filterPreset : undefined;
      const retryVideoFilter = typeof req.body.videoFilter === "string" ? req.body.videoFilter : undefined;
      const retryResolution = typeof req.body.resolution === "string" ? req.body.resolution : undefined;
      await storage.updateExportJob(job.id, { status: "processing", progress: 0, error: null });

      res.json({ success: true, jobId: job.id });

      try {
        const clip = await storage.getClip(job.clipId);
        if (!clip) throw new Error("Clip not found");
        const video = await storage.getVideo(job.videoId);
        if (!video) throw new Error("Video not found");
        const profile = await storage.getProfile(job.profileId);
        if (!profile) throw new Error("Profile not found");

        const startTime = clip.adjustedStartTime ?? clip.startTime;
        const endTime = clip.adjustedEndTime ?? clip.endTime;
        const isPreview = job.isPreview === true;
        const useVps = video.vpsVideoId && video.filepath === "vps" && isVpsConfigured();

        await storage.updateExportJob(job.id, { progress: 10 });

        let clipCalibration: CalibrationData;
        if (clip.calibration) {
          clipCalibration = clip.calibration as CalibrationData;
          if (video.width && video.height) {
            clipCalibration = scaleCalibration(clipCalibration, video.width, video.height);
          }
        } else if (profile.calibration) {
          clipCalibration = profile.calibration as CalibrationData;
          if (video.width && video.height) {
            clipCalibration = scaleCalibration(clipCalibration, video.width, video.height);
          }
        } else {
          throw new Error("Profile not calibrated");
        }

        await storage.updateExportJob(job.id, { progress: 10 });

        let resolvedVideoPath = video.filepath;
        if (!useVps && video.vpsVideoId && video.filepath === "vps") {
          resolvedVideoPath = await downloadFromVps(video.vpsVideoId);
        }

        await storage.updateExportJob(job.id, { progress: 15 });

        const outputPath = path.join(EXPORTS_DIR, `${isPreview ? "preview" : "short"}_${uuidv4()}.mp4`);

        const retryDropTime = (retryMusicDropVolumeBefore != null && clip.dropTime != null) ? clip.dropTime : undefined;

        let effectiveRetryEngine = retryRenderEngine;
        if (effectiveRetryEngine === "runpod") {
          try {
            await ensurePodRunning();
            acquireGpuLease();
          } catch (podErr: any) {
            log(`[RETRY] Failed to start RunPod Pod: ${podErr.message}, falling back to VPS`, "exporter");
            effectiveRetryEngine = "vps";
          }
        }

        try {
          await exportShort({
            videoPath: resolvedVideoPath,
            outputPath,
            startTime,
            endTime,
            calibration: clipCalibration,
            subtitlesEnabled: retrySubtitlesEnabled,
            transcriptSegments: video.transcriptionSegments || undefined,
            vpsVideoId: useVps ? video.vpsVideoId! : undefined,
            isPreview,
            muteAudio: retryMuteAudio,
            bleepProfanity: retryBleepProfanity,
            aspectRatio: retryAspectRatio as "9:16" | "1:1",
            uniqualize: retryUniqualize,
            filterPreset: retryFilterPreset,
            videoFilter: retryVideoFilter,
            resolution: retryResolution,
            bgAudioFilename: retryBgAudioFilename,
            bgAudioVolume: retryBgAudioVolume,
            musicStartOffset: retryMusicStartOffset,
            voiceVolume: retryVoiceVolume,
            musicDropTime: retryDropTime,
            musicDropVolumeBefore: retryMusicDropVolumeBefore,
            captionPositionY: retryCaptionPositionY,
            subtitleOffsetMs: retrySubtitleOffsetMs,
            captionStyle: retryCaptionStyle,
            renderEngine: effectiveRetryEngine,
            contentType: video.contentType || "poker",
            jobId: String(job.id),
            onProgress: async (percent: number) => {
              await storage.updateExportJob(job.id, { progress: percent });
            },
          });
        } finally {
          if (effectiveRetryEngine === "runpod") {
            releaseGpuLease();
          }
        }

        await storage.updateExportJob(job.id, { status: "completed", progress: 100, outputPath });
        log(`Retry export job ${job.id} completed`, "exporter");

        if (!job.isPreview && isVpsConfigured() && video.vpsVideoId) {
          try {
            const startTime2 = clip.adjustedStartTime ?? clip.startTime;
            const endTime2 = clip.adjustedEndTime ?? clip.endTime;
            const thumbBuffer = await vpsGenerateClipThumbnail(
              video.vpsVideoId, startTime2, endTime2,
              clipCalibration, video.contentType || "poker"
            );
            const thumbFile = `thumb_${job.id}.jpg`;
            const thumbPath = path.join(THUMBNAILS_DIR, thumbFile);
            fs.writeFileSync(thumbPath, thumbBuffer);
            await storage.updateExportJob(job.id, { thumbnailPath: thumbPath });
            log(`Auto-thumbnail generated for retry export ${job.id}`, "exporter");
          } catch (thumbErr: any) {
            log(`Auto-thumbnail failed (non-critical): ${thumbErr.message}`, "exporter");
          }
        }
      } catch (err: any) {
        log(`Retry export job ${job.id} failed: ${err.message}`, "exporter");
        await storage.updateExportJob(job.id, { status: "error", error: err.message });
      }
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/exports/:id/cancel", async (req, res) => {
    try {
      const jobId = String(paramId(req));
      const job = await storage.getExportJob(paramId(req));
      if (!job) return res.status(404).json({ message: "Export not found" });

      if (job.status !== "processing") {
        return res.status(400).json({ message: "Export is not in progress" });
      }

      const cancelled = cancelExport(jobId);
      await storage.updateExportJob(paramId(req), { status: "error", error: "Cancelled by user" });
      
      if (job.outputPath && fs.existsSync(job.outputPath)) {
        try { fs.unlinkSync(job.outputPath); } catch {}
      }

      res.json({ success: true, cancelled });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/exports/:id/download", async (req, res) => {
    try {
      const job = await storage.getExportJob(paramId(req));
      if (!job || !job.outputPath) {
        return res.status(404).json({ message: "Export not found" });
      }

      if (!fs.existsSync(job.outputPath)) {
        const video = job.videoId ? await storage.getVideo(job.videoId) : null;
        if (video?.vpsVideoId && isVpsConfigured()) {
          const clipId = path.basename(job.outputPath, ".mp4");
          try {
            const dir = path.dirname(job.outputPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            await vpsDownloadExport(video.vpsVideoId, clipId, job.outputPath);
          } catch (e: any) {
            return res.status(404).json({ message: "Export file not available" });
          }
        } else {
          return res.status(404).json({ message: "Export not found" });
        }
      }

      res.download(job.outputPath, `poker_short_${job.id.slice(0, 8)}.mp4`);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/exports/:id/stream", async (req, res) => {
    try {
      const job = await storage.getExportJob(paramId(req));
      if (!job || !job.outputPath) {
        return res.status(404).json({ message: "Export not found" });
      }

      if (!fs.existsSync(job.outputPath)) {
        const video = job.videoId ? await storage.getVideo(job.videoId) : null;
        if (video?.vpsVideoId && isVpsConfigured()) {
          const clipId = path.basename(job.outputPath, ".mp4");
          try {
            log(`Re-downloading export from VPS: ${video.vpsVideoId}/${clipId}`, "routes");
            const dir = path.dirname(job.outputPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            await vpsDownloadExport(video.vpsVideoId, clipId, job.outputPath);
            log(`Re-download complete: ${job.outputPath}`, "routes");
          } catch (e: any) {
            log(`VPS re-download failed: ${e.message}`, "routes");
            return res.status(404).json({ message: "Export file not available" });
          }
        } else {
          return res.status(404).json({ message: "Export not found" });
        }
      }

      const stat = fs.statSync(job.outputPath);
      const fileSize = stat.size;
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunkSize,
          "Content-Type": "video/mp4",
        });
        fs.createReadStream(job.outputPath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          "Content-Length": fileSize,
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes",
        });
        fs.createReadStream(job.outputPath).pipe(res);
      }
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/videos/:id/stream-url", async (req, res) => {
    try {
      const video = await storage.getVideo(paramId(req));
      if (!video) {
        return res.status(404).json({ message: "Video not found" });
      }

      const vpsUrl = getVpsUrl();
      const vpsToken = getVpsToken();

      if (video.vpsVideoId && vpsUrl && vpsToken) {
        const clipStart = req.query.start ? parseFloat(req.query.start as string) : undefined;
        const clipEnd = req.query.end ? parseFloat(req.query.end as string) : undefined;

        if (clipStart !== undefined && clipEnd !== undefined && !isNaN(clipStart) && !isNaN(clipEnd)) {
          const pad = 120;
          const segStart = Math.max(0, clipStart - pad);
          return res.json({
            type: "vps",
            url: `${vpsUrl}/clip-segment/${video.vpsVideoId}?start=${clipStart}&end=${clipEnd}&pad=${pad}`,
            token: vpsToken,
            clipOffset: segStart,
          });
        }

        vpsRemux(video.vpsVideoId).catch((e: any) => {
          log(`Remux warning (non-fatal): ${e.message}`, "routes");
        });
        return res.json({
          type: "vps",
          url: `${vpsUrl}/download/${video.vpsVideoId}`,
          token: vpsToken,
        });
      }

      return res.json({
        type: "proxy",
        url: `/api/videos/${video.id}/stream`,
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/videos/:id/stream", async (req, res) => {
    try {
      const video = await storage.getVideo(paramId(req));
      if (!video) {
        return res.status(404).json({ message: "Video not found" });
      }

      const vpsUrl = getVpsUrl();
      const vpsToken = getVpsToken();

      if (video.vpsVideoId && vpsUrl && vpsToken) {
        vpsRemux(video.vpsVideoId).catch((e: any) => {
          log(`Remux warning: ${e.message}`, "routes");
        });

        const downloadUrl = `${vpsUrl}/download/${video.vpsVideoId}`;
        const vpsUrlObj = new URL(downloadUrl);
        const isHttps = vpsUrlObj.protocol === "https:";
        const httpMod = isHttps ? await import("https") : await import("http");

        const proxyHeaders: Record<string, string> = {
          "Authorization": `Bearer ${vpsToken}`,
        };
        if (req.headers.range) {
          proxyHeaders["Range"] = req.headers.range;
        }

        const proxyReq = httpMod.request(
          {
            hostname: vpsUrlObj.hostname,
            port: vpsUrlObj.port || (isHttps ? 443 : 80),
            path: vpsUrlObj.pathname,
            method: "GET",
            headers: proxyHeaders,
            timeout: 3600000,
          },
          (proxyRes: any) => {
            const headers: Record<string, string> = {
              "Content-Type": "video/mp4",
              "Accept-Ranges": "bytes",
            };
            if (proxyRes.headers["content-length"]) {
              headers["Content-Length"] = proxyRes.headers["content-length"];
            }
            if (proxyRes.headers["content-range"]) {
              headers["Content-Range"] = proxyRes.headers["content-range"];
            }
            res.writeHead(proxyRes.statusCode, headers);
            proxyRes.pipe(res);
          }
        );

        proxyReq.on("error", (err: Error) => {
          if (!res.headersSent) {
            res.status(502).json({ message: `VPS stream error: ${err.message}` });
          }
        });

        req.on("close", () => proxyReq.destroy());
        proxyReq.end();
        return;
      }

      if (!video.filepath || video.filepath === "pending" || video.filepath === "vps" || !fs.existsSync(video.filepath)) {
        return res.status(404).json({ message: "Video file not found" });
      }

      const stat = fs.statSync(video.filepath);
      const fileSize = stat.size;
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        const stream = fs.createReadStream(video.filepath, { start, end });
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunkSize,
          "Content-Type": "video/mp4",
        });
        stream.pipe(res);
      } else {
        res.writeHead(200, {
          "Content-Length": fileSize,
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes",
        });
        fs.createReadStream(video.filepath).pipe(res);
      }
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  const LOGOS_DIR = path.join(process.cwd(), "private_logos");
  if (!fs.existsSync(LOGOS_DIR)) fs.mkdirSync(LOGOS_DIR, { recursive: true });

  const logoUpload = multer({
    storage: multer.diskStorage({
      destination: LOGOS_DIR,
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `logo_${uuidv4()}${ext}`);
      },
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const allowed = [".png", ".jpg", ".jpeg", ".webp"];
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, allowed.includes(ext));
    },
  });

  app.post("/api/profiles/:id/logo", logoUpload.single("logo"), async (req, res) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ message: "No logo file" });

      const profile = await storage.getProfile(paramId(req));
      if (!profile) return res.status(404).json({ message: "Profile not found" });

      if (profile.logoPath && fs.existsSync(profile.logoPath)) {
        try { fs.unlinkSync(profile.logoPath); } catch {}
      }

      const updated = await storage.updateProfileLogo(paramId(req), file.path);
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/profiles/:id/logo", async (req, res) => {
    try {
      const profile = await storage.getProfile(paramId(req));
      if (!profile || !profile.logoPath || !fs.existsSync(profile.logoPath)) {
        return res.status(404).json({ message: "Logo not found" });
      }
      res.sendFile(profile.logoPath);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/clips/export-all", async (req, res) => {
    try {
      const { videoId, profileId, subtitlesEnabled, useAiCalibration, muteAudio, bleepProfanity, aspectRatio: reqAspectRatio, uniqualize, resolution, crawlText: rawCrawlText, bgAudioFilename: rawBgAudioFilename, bgAudioVolume: rawBgAudioVolume, captionEnabled: rawCaptionEnabled, filterPreset: rawFilterPreset, videoFilter: rawVideoFilter, musicDropVolumeBefore: rawMusicDropVolumeBefore, musicStartOffset: rawMusicStartOffset, voiceVolume: rawVoiceVolume, captionPositionY: rawCaptionPositionY, subtitleOffsetMs: rawSubtitleOffsetMs, captionStyle: rawCaptionStyle, renderEngine: rawRenderEngine, enableDynamicCamera: rawEnableDynamicCamera } = req.body;
      const batchEnableDynamicCamera = rawEnableDynamicCamera === true;
      const batchCameraMode: "auto" | "smooth" | "cuts" = (req.body.cameraMode === "smooth" || req.body.cameraMode === "cuts") ? req.body.cameraMode : "auto";
      const batchCrawlTextRaw = typeof rawCrawlText === "string" ? rawCrawlText.trim() : undefined;
      const batchCaptionEnabled = rawCaptionEnabled === true;
      const batchBgAudioFilename = typeof rawBgAudioFilename === "string" ? rawBgAudioFilename : undefined;
      const batchBgAudioVolume = typeof rawBgAudioVolume === "number" ? rawBgAudioVolume : undefined;
      const batchMusicDropVolumeBefore = typeof rawMusicDropVolumeBefore === "number" ? rawMusicDropVolumeBefore : undefined;
      const batchMusicStartOffset = typeof rawMusicStartOffset === "number" ? rawMusicStartOffset : undefined;
      const batchVoiceVolume = typeof rawVoiceVolume === "number" ? rawVoiceVolume : undefined;
      const batchCaptionPositionY = typeof rawCaptionPositionY === "number" ? rawCaptionPositionY : undefined;
      if (!videoId || !profileId) return res.status(400).json({ message: "videoId and profileId required" });

      const video = await storage.getVideo(videoId);
      if (!video) return res.status(404).json({ message: "Video not found" });

      const profile = await storage.getProfile(profileId);
      if (!profile) {
        return res.status(400).json({ message: "Profile not found" });
      }

      const clips = await storage.getClipsByVideoId(videoId);
      const approvedClips = clips.filter((c) => c.status === "approved");
      if (approvedClips.length === 0) return res.status(400).json({ message: "No approved clips" });

      const wantSquare = reqAspectRatio === "1:1";
      const ratiosToExport: Array<"9:16" | "1:1"> = wantSquare ? ["9:16", "1:1"] : ["9:16"];

      const jobs: Array<{ job: any; clipId: string; aspectRatio: "9:16" | "1:1" }> = [];
      for (const clip of approvedClips) {
        const existingExports = (await storage.getExportJobs()).filter(
          (e) => e.clipId === clip.id && (e.status === "processing" || e.status === "queued")
        );
        if (existingExports.length > 0) continue;

        for (const ar of ratiosToExport) {
          const outputFile = `short_${uuidv4()}.mp4`;
          const outputPath = path.join(EXPORTS_DIR, outputFile);

          const job = await storage.createExportJob({
            videoId: video.id,
            clipId: clip.id,
            profileId,
            status: "queued",
            outputPath,
            subtitlesEnabled: subtitlesEnabled === true,
            aspectRatio: ar,
            progress: 0,
            error: null,
          });
          jobs.push({ job, clipId: clip.id, aspectRatio: ar });
        }
      }

      res.json({ jobs: jobs.map(j => j.job), count: jobs.length });

      const useVpsBatch = video.vpsVideoId && video.filepath === "vps" && isVpsConfigured();
      let resolvedBatchVideoPath = video.filepath;
      if (!useVpsBatch && video.vpsVideoId && video.filepath === "vps") {
        resolvedBatchVideoPath = await downloadFromVps(video.vpsVideoId);
      }

      for (const { job, clipId, aspectRatio: batchAr } of jobs) {
        const clip = approvedClips.find((c) => c.id === clipId);
        if (!clip) continue;

        try {
          await storage.updateExportJob(job.id, { status: "processing", progress: 10 });
          const startTime = clip.adjustedStartTime ?? clip.startTime;
          const endTime = clip.adjustedEndTime ?? clip.endTime;

          let clipCalibration: CalibrationData;

          if (clip.calibration && useAiCalibration !== true) {
            clipCalibration = clip.calibration as CalibrationData;
            if (video.width && video.height) {
              clipCalibration = scaleCalibration(clipCalibration, video.width, video.height);
            }
            log(`Batch: using clip-specific calibration for clip ${clip.id} (${batchAr})`, "exporter");
          } else if (profile.calibration && useAiCalibration !== true) {
            clipCalibration = profile.calibration as CalibrationData;
            if (video.width && video.height) {
              clipCalibration = scaleCalibration(clipCalibration, video.width, video.height);
            }
            log(`Batch: using profile calibration for clip ${clip.id} (${batchAr})`, "exporter");
          } else {
            const clipMidTime = startTime + Math.min(3, (endTime - startTime) / 2);
            const clipFrameFile = `frame_clip_${clip.id}_${Math.round(clipMidTime)}.jpg`;
            const clipFramePath = path.join(FRAMES_DIR, clipFrameFile);

            log(`Batch export: per-clip AI calibration for clip ${clip.id} at ${clipMidTime}s`, "exporter");

            if (!fs.existsSync(clipFramePath)) {
              if (video.vpsVideoId && video.filepath === "vps" && isVpsConfigured()) {
                await vpsExtractFrame(video.vpsVideoId, clipMidTime, clipFramePath);
              } else if (video.filepath && video.filepath !== "pending" && video.filepath !== "vps") {
                await extractFrame(video.filepath, clipFramePath, clipMidTime);
              }
            }

            if (fs.existsSync(clipFramePath)) {
              try {
                const profileHint = profile.calibration ? { table: (profile.calibration as CalibrationData).table, webcam: (profile.calibration as CalibrationData).webcam } : undefined;
                const aiResult = await detectRegionsWithAI(clipFramePath, profileHint);
                clipCalibration = {
                  table: aiResult.table,
                  webcam: aiResult.webcam,
                  chat: aiResult.chat,
                  sourceWidth: aiResult.sourceWidth,
                  sourceHeight: aiResult.sourceHeight,
                };
                log(`Batch: AI calibration for clip ${clip.id}: table=${JSON.stringify(clipCalibration.table)}, webcam=${JSON.stringify(clipCalibration.webcam)}`, "exporter");
              } catch (aiErr: any) {
                log(`Batch: AI calibration failed for clip ${clip.id}, using profile: ${aiErr.message}`, "exporter");
                if (!profile.calibration) throw new Error("AI авто-калибровка не удалась и профиль не откалиброван");
                clipCalibration = profile.calibration as CalibrationData;
                if (video.width && video.height) {
                  clipCalibration = scaleCalibration(clipCalibration, video.width, video.height);
                }
              }
            } else {
              if (!profile.calibration) throw new Error("Невозможно извлечь кадр и профиль не откалиброван");
              clipCalibration = profile.calibration as CalibrationData;
              if (video.width && video.height) {
                clipCalibration = scaleCalibration(clipCalibration, video.width, video.height);
              }
            }
          }

          await storage.updateExportJob(job.id, { progress: 15 });

          let effectiveBatchEngine = typeof rawRenderEngine === "string" ? rawRenderEngine as "vps" | "runpod" : undefined;
          if (effectiveBatchEngine === "runpod") {
            try {
              await ensurePodRunning();
              acquireGpuLease();
            } catch (podErr: any) {
              log(`[BATCH] Failed to start RunPod Pod: ${podErr.message}, falling back to VPS`, "exporter");
              effectiveBatchEngine = "vps";
            }
          }

          let batchCameraKfs: CameraKeyframe[] | undefined;
          if (batchEnableDynamicCamera && (video.contentType === "streamer") && clipCalibration?.webcam && useVpsBatch && video.vpsVideoId) {
            try {
              log(`[BATCH] Generating dynamic camera for clip ${clip.id}`, "exporter");
              batchCameraKfs = await analyzeCameraKeyframes(
                video.vpsVideoId, startTime, endTime,
                clipCalibration.webcam as any,
                clipCalibration.sourceWidth || video.width || 1920,
                clipCalibration.sourceHeight || video.height || 1080,
              );
              if (batchCameraKfs.length < 2) batchCameraKfs = undefined;
              else {
                if (batchCameraMode === "smooth") batchCameraKfs = batchCameraKfs.map(kf => ({ ...kf, cut: false }));
                else if (batchCameraMode === "cuts") batchCameraKfs = batchCameraKfs.map((kf, i) => ({ ...kf, cut: i > 0 }));
                log(`[BATCH] Got ${batchCameraKfs.length} camera keyframes, mode=${batchCameraMode}`, "exporter");
              }
            } catch (camErr: any) {
              log(`[BATCH] Dynamic camera failed: ${camErr.message}`, "exporter");
              batchCameraKfs = undefined;
            }
          }

          try {
            await exportShort({
              videoPath: resolvedBatchVideoPath,
              outputPath: job.outputPath!,
              startTime,
              endTime,
              calibration: clipCalibration,
              subtitlesEnabled: subtitlesEnabled === true || batchCaptionEnabled,
              transcriptSegments: video.transcriptionSegments || undefined,
              vpsVideoId: useVpsBatch ? video.vpsVideoId! : undefined,
              muteAudio: muteAudio === true,
              bleepProfanity: bleepProfanity === true,
              uniqualize: uniqualize === true,
              filterPreset: ["subtle", "medium", "strong"].includes(rawFilterPreset) ? rawFilterPreset : "medium",
              videoFilter: typeof rawVideoFilter === "string" ? rawVideoFilter : undefined,
              resolution: resolution || "1080p",
              crawlText: (batchCrawlTextRaw && batchCrawlTextRaw !== "__whisper__") ? batchCrawlTextRaw : undefined,
              bgAudioFilename: batchBgAudioFilename,
              bgAudioVolume: batchBgAudioVolume,
              musicStartOffset: batchMusicStartOffset,
              voiceVolume: batchVoiceVolume,
              musicDropTime: clip.dropTime != null ? clip.dropTime : undefined,
              musicDropVolumeBefore: batchMusicDropVolumeBefore,
              captionPositionY: batchCaptionPositionY,
              subtitleOffsetMs: typeof rawSubtitleOffsetMs === "number" ? rawSubtitleOffsetMs : undefined,
              captionStyle: typeof rawCaptionStyle === "string" ? rawCaptionStyle : undefined,
              renderEngine: effectiveBatchEngine,
              aspectRatio: batchAr,
              contentType: video.contentType || "poker",
              jobId: String(job.id),
              cameraKeyframes: batchCameraKfs,
              onProgress: async (percent: number) => {
                await storage.updateExportJob(job.id, { progress: percent });
              },
            });
          } finally {
            if (effectiveBatchEngine === "runpod") {
              releaseGpuLease();
            }
          }

          const currentJob = await storage.getExportJob(job.id);
          if (currentJob && currentJob.status !== "error") {
            await storage.updateExportJob(job.id, { status: "completed", progress: 100 });
            log(`Export job ${job.id} (${batchAr}) completed`, "exporter");
          }
        } catch (err: any) {
          log(`Export job ${job.id} (${batchAr}) failed: ${err.message}`, "exporter");
          const currentJob = await storage.getExportJob(job.id);
          if (currentJob && currentJob.status !== "error") {
            await storage.updateExportJob(job.id, { status: "error", error: err.message });
          }
        }
      }
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  const autoCutRunning = new Set<string>();
  const autoCutCancelled = new Set<string>();

  app.get("/api/videos/:id/auto-cut/status", async (_req, res) => {
    const videoId = paramId(_req);
    res.json({ running: autoCutRunning.has(videoId) });
  });

  app.post("/api/videos/:id/auto-cut/stop", async (req, res) => {
    try {
      const videoId = paramId(req);
      autoCutCancelled.add(videoId);
      autoCutRunning.delete(videoId);
      const pendingCuts = await storage.getAutoCutsByVideoId(videoId);
      let cancelled = 0;
      for (const cut of pendingCuts) {
        if (cut.status === "queued" || cut.status === "processing") {
          await storage.updateAutoCut(cut.id, { status: "error", error: "Остановлено пользователем" });
          cancelled++;
        }
      }
      log(`[auto-cut] Stop requested for video ${videoId}, cancelled ${cancelled} pending cuts`, "exporter");
      res.json({ ok: true, cancelled });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/videos/:id/auto-cut", async (req, res) => {
    try {
      const videoId = paramId(req);
      if (autoCutRunning.has(videoId)) {
        return res.status(409).json({ message: "Auto-cut already running for this video" });
      }
      const video = await storage.getVideo(videoId);
      if (!video) return res.status(404).json({ message: "Video not found" });
      if (!video.highlights || (video.highlights as any[]).length === 0) {
        return res.status(400).json({ message: "No highlights detected. Run AI analysis first." });
      }
      if (!video.vpsVideoId || video.filepath !== "vps") {
        return res.status(400).json({ message: "Video must be on VPS" });
      }
      autoCutRunning.add(videoId);

      const profileId = req.body.profileId || video.profileId;
      if (!profileId) {
        autoCutRunning.delete(videoId);
        return res.status(400).json({ message: "profileId required" });
      }
      const profile = await storage.getProfile(profileId);
      if (!profile) {
        autoCutRunning.delete(videoId);
        return res.status(400).json({ message: "Profile not found" });
      }

      const maxClips = typeof req.body.maxClips === "number" ? req.body.maxClips : 10;
      const minExcitement = typeof req.body.minExcitement === "number" ? req.body.minExcitement : 6;
      const captionStyle = typeof req.body.captionStyle === "string" ? req.body.captionStyle : "mrbeast";
      const captionPositionY = typeof req.body.captionPositionY === "number" ? req.body.captionPositionY : 82;
      const bgAudioFilenameFromBody = typeof req.body.bgAudioFilename === "string" ? req.body.bgAudioFilename : undefined;
      const bgAudioVolume = typeof req.body.bgAudioVolume === "number" ? req.body.bgAudioVolume : 0.3;
      const voiceVolume = typeof req.body.voiceVolume === "number" ? req.body.voiceVolume : 1.4;
      const bleepProfanity = true; // always bleep profanity in auto-cut
      // Dynamic camera: ON by default for streamer content, OFF only if explicitly disabled
      const enableDynamicCamera = video.contentType === "streamer"
        ? req.body.enableDynamicCamera !== false
        : false;
      const autoCutCameraMode: "auto" | "smooth" | "cuts" = (req.body.cameraMode === "smooth" || req.body.cameraMode === "cuts") ? req.body.cameraMode : "auto";

      // Sort by excitement but don't slice yet — we need to skip already-completed ones first
      const allHighlights = (video.highlights as any[])
        .filter(h => (h.excitement || 0) >= minExcitement)
        .sort((a, b) => (b.excitement || 0) - (a.excitement || 0));

      if (allHighlights.length === 0) {
        autoCutRunning.delete(videoId);
        return res.status(400).json({ message: `No highlights with excitement >= ${minExcitement}` });
      }

      // AI music selection if user didn't specify a track
      let bgAudioFilename = bgAudioFilenameFromBody;
      if (!bgAudioFilename && isVpsConfigured()) {
        try {
          const { sounds } = await vpsSoundsList();
          if (sounds.length > 0) {
            const soundNames = sounds.map((s: any) => s.filename);
            const topClips = allHighlights.slice(0, 5).map((h: any) => `"${h.title}" [${(h.tags || []).join(", ")}]`).join("\n");
            const { openai: aiClient } = await import("./replit_integrations/audio/client");
            const gptResp = await aiClient.chat.completions.create({
              model: "gpt-4.1-mini",
              messages: [{
                role: "user",
                content: `Выбери лучший фоновый музыкальный трек для нарезки клипов.\nТип контента: ${video.contentType || "streamer"}\nТоп клипы:\n${topClips}\n\nДоступные треки:\n${soundNames.join("\n")}\n\nОтветь ТОЛЬКО точным именем файла из списка. Без объяснений.`,
              }],
              temperature: 0.3,
              max_tokens: 100,
            });
            const chosen = (gptResp.choices[0]?.message?.content || "").trim();
            bgAudioFilename = soundNames.find((n: string) => n === chosen) || soundNames[0];
            log(`[auto-cut] AI selected music: "${bgAudioFilename}"`, "exporter");
          }
        } catch (err: any) {
          log(`[auto-cut] AI music selection failed: ${err.message}`, "exporter");
        }
      }

      const existingAutoCuts = await storage.getAutoCutsByVideoId(video.id);
      // Only skip truly completed cuts — queued/error cuts will be re-processed
      const completedTimes = new Set(existingAutoCuts.filter(c => c.status === "completed").map(c => `${c.startTime}-${c.endTime}`));
      const allExistingTimes = new Set(existingAutoCuts.map(c => `${c.startTime}-${c.endTime}`));

      // Pick up existing queued/error cuts that were interrupted (e.g. server restart)
      const pendingExisting = existingAutoCuts.filter(c => c.status === "queued" || c.status === "error");
      const cuts: any[] = [...pendingExisting];

      for (const h of allHighlights) {
        if (cuts.length >= maxClips) break;
        const key = `${h.startTime}-${h.endTime}`;
        if (allExistingTimes.has(key)) continue; // Skip ones already in DB (any status)

        const outputFile = `autocut_${uuidv4()}.mp4`;
        const outputPath = path.join(EXPORTS_DIR, outputFile);
        const cut = await storage.createAutoCut({
          videoId: video.id,
          profileId,
          startTime: h.startTime,
          endTime: h.endTime,
          title: h.title || `Клип ${h.startTime}s`,
          description: h.description || "",
          excitement: h.excitement || 0,
          tags: h.tags || [],
          hookLine: h.hookLine || null,
          dropTime: h.dropTime || null,
          status: "queued",
          outputPath,
          captionStyle,
          aspectRatio: "9:16",
          renderEngine: "runpod",
          progress: 0,
          error: null,
        });
        cuts.push(cut);
      }

      log(`[auto-cut] Video ${video.id}: ${cuts.length} cuts to process (${pendingExisting.length} resumed, ${cuts.length - pendingExisting.length} new, ${completedTimes.size} already completed, maxClips=${maxClips})`, "exporter");
      res.json({ total: cuts.length, ids: cuts.map(c => c.id) });

      autoCutCancelled.delete(video.id);
      for (const cut of cuts) {
        if (autoCutCancelled.has(video.id)) {
          log(`[auto-cut] Cancelled, skipping remaining cuts for ${video.id}`, "exporter");
          break;
        }
        // Skip clips that were deleted from the queue before rendering started
        const preRenderCheck = await storage.getAutoCut(cut.id);
        if (!preRenderCheck) {
          log(`[auto-cut] ${cut.id} was deleted before render, skipping`, "exporter");
          continue;
        }
        try {
          await storage.updateAutoCut(cut.id, { status: "processing", progress: 5 });

          let clipCalibration: CalibrationData;
          // Calibration priority: video's own profile > publishing profile > AI detection
          // The publishing profile is for WHERE to post, the video's profile defines the LAYOUT
          const videoProfile = video.profileId && video.profileId !== profileId
            ? await storage.getProfile(video.profileId)
            : null;
          const calibrationSource = videoProfile?.calibration
            ? (videoProfile.calibration as CalibrationData)
            : profile.calibration
              ? (profile.calibration as CalibrationData)
              : null;
          if (calibrationSource) {
            clipCalibration = calibrationSource;
            if (video.width && video.height) {
              clipCalibration = scaleCalibration(clipCalibration, video.width, video.height);
            }
            log(`[auto-cut] Calibration from ${videoProfile ? `video profile (${videoProfile.name})` : `publishing profile (${profile.name})`}: table=${!!clipCalibration.table}, webcam=${!!clipCalibration.webcam}`, "exporter");
          } else {
            const clipMidTime = cut.startTime + Math.min(3, (cut.endTime - cut.startTime) / 2);
            const clipFrameFile = `frame_autocut_${cut.id}_${Math.round(clipMidTime)}.jpg`;
            const clipFramePath = path.join(FRAMES_DIR, clipFrameFile);

            if (!fs.existsSync(clipFramePath) && video.vpsVideoId) {
              await vpsExtractFrame(video.vpsVideoId, clipMidTime, clipFramePath);
            }

            if (fs.existsSync(clipFramePath)) {
              const aiResult = await detectRegionsWithAI(clipFramePath);
              clipCalibration = {
                table: aiResult.table,
                webcam: aiResult.webcam,
                chat: aiResult.chat,
                sourceWidth: aiResult.sourceWidth,
                sourceHeight: aiResult.sourceHeight,
              };
            } else {
              throw new Error("No calibration available and frame extraction failed");
            }
          }

          let cameraKfs: CameraKeyframe[] | undefined;
          log(`[auto-cut] Dynamic camera check: enableDynamicCamera=${enableDynamicCamera}, contentType=${video.contentType}, hasWebcam=${!!clipCalibration.webcam}, hasVpsId=${!!video.vpsVideoId}`, "exporter");
          if (enableDynamicCamera && (video.contentType === "streamer") && clipCalibration.webcam && video.vpsVideoId) {
            try {
              await storage.updateAutoCut(cut.id, { progress: 8 });
              log(`[auto-cut] Generating dynamic camera keyframes for clip ${cut.id}`, "exporter");
              cameraKfs = await analyzeCameraKeyframes(
                video.vpsVideoId,
                cut.startTime,
                cut.endTime,
                clipCalibration.webcam as any,
                clipCalibration.sourceWidth || video.width || 1920,
                clipCalibration.sourceHeight || video.height || 1080,
              );
              if (cameraKfs.length >= 2) {
                if (autoCutCameraMode === "smooth") cameraKfs = cameraKfs.map(kf => ({ ...kf, cut: false }));
                else if (autoCutCameraMode === "cuts") cameraKfs = cameraKfs.map((kf, i) => ({ ...kf, cut: i > 0 }));
                log(`[auto-cut] Got ${cameraKfs.length} camera keyframes for clip ${cut.id}, mode=${autoCutCameraMode}`, "exporter");
              } else {
                cameraKfs = undefined;
              }
            } catch (camErr: any) {
              log(`[auto-cut] Dynamic camera failed for clip ${cut.id}: ${camErr.message}, using static crop`, "exporter");
              cameraKfs = undefined;
            }
          }

          // AI Whisper correction before render
          let clipTranscriptSegments = ((video.transcriptionSegments || []) as TranscriptSegment[]);
          if (video.vpsVideoId) {
            try {
              await storage.updateAutoCut(cut.id, { progress: 10 });
              log(`[auto-cut] gpt-4o-mini-transcribe correction for clip ${cut.id} (${cut.startTime}-${cut.endTime}s)`, "exporter");
              const { correctClipWithGpt4oTranscribe } = await import("./ai-pipeline");
              const { updatedSegments, correctedCount } = await correctClipWithGpt4oTranscribe(
                clipTranscriptSegments,
                cut.startTime,
                cut.endTime,
                video.vpsVideoId,
              );
              clipTranscriptSegments = updatedSegments;
              // Save corrected transcript back to video so next clips benefit from it
              await storage.updateVideo(video.id, {
                transcriptionSegments: updatedSegments,
                transcription: updatedSegments.map((s: TranscriptSegment) => s.text).join(" "),
              } as any);
              (video as any).transcriptionSegments = updatedSegments;
              log(`[auto-cut] Whisper correction done: ${correctedCount} segments corrected for clip ${cut.id}`, "exporter");
            } catch (corrErr: any) {
              log(`[auto-cut] Whisper correction failed for clip ${cut.id}: ${corrErr.message}, using original transcript`, "exporter");
            }
          }

          let effectiveEngine: "vps" | "runpod" = "runpod";
          try {
            await ensurePodRunning();
            acquireGpuLease();
          } catch (podErr: any) {
            log(`[auto-cut] GPU unavailable: ${podErr.message}, falling back to VPS`, "exporter");
            effectiveEngine = "vps";
          }

          try {
            await exportShort({
              videoPath: video.filepath,
              outputPath: cut.outputPath!,
              startTime: cut.startTime,
              endTime: cut.endTime,
              calibration: clipCalibration,
              subtitlesEnabled: true,
              transcriptSegments: clipTranscriptSegments.length > 0 ? clipTranscriptSegments : undefined,
              vpsVideoId: video.vpsVideoId!,
              muteAudio: false,
              bleepProfanity,
              uniqualize: false,
              renderEngine: effectiveEngine,
              aspectRatio: "9:16",
              contentType: video.contentType || "poker",
              jobId: String(cut.id),
              captionPositionY,
              captionStyle,
              bgAudioFilename,
              bgAudioVolume,
              voiceVolume,
              cameraKeyframes: cameraKfs,
              onProgress: async (percent: number) => {
                try { await storage.updateAutoCut(cut.id, { progress: percent }); } catch {}
              },
            });
          } finally {
            if (effectiveEngine === "runpod") releaseGpuLease();
          }

          const currentCut = await storage.getAutoCut(cut.id);
          if (!currentCut) {
            log(`[auto-cut] ${cut.id} was deleted during render, discarding result`, "exporter");
            if (cut.outputPath && fs.existsSync(cut.outputPath)) {
              try { fs.unlinkSync(cut.outputPath); } catch {}
            }
          } else if (currentCut.status === "error") {
            log(`[auto-cut] ${cut.id} was cancelled during render, keeping error status`, "exporter");
          } else {
            await storage.updateAutoCut(cut.id, { status: "completed", progress: 100, renderEngine: effectiveEngine });
            log(`[auto-cut] ${cut.id} completed: "${cut.title}"`, "exporter");
          }
        } catch (err: any) {
          log(`[auto-cut] ${cut.id} failed: ${err.message}`, "exporter");
          try { await storage.updateAutoCut(cut.id, { status: "error", error: err.message }); } catch {}
        }
      }
      log(`[auto-cut] Finished: ${cuts.length} renders for video ${video.id}`, "exporter");
      autoCutRunning.delete(video.id);
      autoCutCancelled.delete(video.id);
    } catch (err: any) {
      autoCutRunning.delete(paramId(req));
      autoCutCancelled.delete(paramId(req));
      if (!res.headersSent) res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/auto-cuts", async (_req, res) => {
    try {
      const cuts = await storage.getAutoCuts();
      res.json(cuts);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/auto-cuts/video/:videoId", async (req, res) => {
    try {
      const cuts = await storage.getAutoCutsByVideoId(req.params.videoId);
      res.json(cuts);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/auto-cuts/:id", async (req, res) => {
    try {
      const cut = await storage.getAutoCut(req.params.id);
      if (!cut) return res.status(404).json({ message: "Not found" });
      res.json(cut);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.delete("/api/auto-cuts/video/:videoId", async (req, res) => {
    try {
      const videoId = req.params.videoId;
      autoCutCancelled.add(videoId);
      autoCutRunning.delete(videoId);
      const allCuts = await storage.getAutoCutsByVideoId(videoId);
      let deleted = 0;
      for (const cut of allCuts) {
        if (cut.outputPath && fs.existsSync(cut.outputPath)) {
          try { fs.unlinkSync(cut.outputPath); } catch {}
        }
        await storage.deleteAutoCut(cut.id);
        deleted++;
      }
      log(`[auto-cut] Deleted ${deleted} auto-cuts for video ${videoId}`, "exporter");
      res.json({ ok: true, deleted });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.delete("/api/auto-cuts/:id", async (req, res) => {
    try {
      const cut = await storage.getAutoCut(req.params.id);
      if (!cut) return res.status(404).json({ message: "Not found" });
      if (cut.outputPath && fs.existsSync(cut.outputPath)) {
        fs.unlinkSync(cut.outputPath);
      }
      await storage.deleteAutoCut(req.params.id);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/auto-cuts/:id/rerender", async (req, res) => {
    try {
      const cut = await storage.getAutoCut(req.params.id);
      if (!cut) return res.status(404).json({ message: "Not found" });
      // Generate new outputPath so there's no file cache confusion
      const newOutputFile = `autocut_${uuidv4()}.mp4`;
      const newOutputPath = path.join(EXPORTS_DIR, newOutputFile);
      await storage.updateAutoCut(req.params.id, {
        status: "queued",
        progress: 0,
        error: null,
        outputPath: newOutputPath,
      } as any);
      log(`[auto-cut] ${req.params.id} reset to queued for re-render → ${newOutputFile}`, "exporter");
      res.json({ ok: true, videoId: cut.videoId });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/auto-cuts/:id/video", async (req, res) => {
    try {
      const cut = await storage.getAutoCut(req.params.id);
      if (!cut) return res.status(404).json({ message: "Not found" });
      if (!cut.outputPath) return res.status(404).json({ message: "No output file" });

      const filePath = path.resolve(cut.outputPath);
      if (!fs.existsSync(filePath)) return res.status(404).json({ message: "File not found" });

      const stat = fs.statSync(filePath);
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": end - start + 1,
          "Content-Type": "video/mp4",
          "Cache-Control": "no-cache, no-store, must-revalidate",
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          "Content-Length": stat.size,
          "Content-Type": "video/mp4",
          "Content-Disposition": "inline",
          "Cache-Control": "no-cache, no-store, must-revalidate",
        });
        fs.createReadStream(filePath).pipe(res);
      }
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ==================== Auto-Cut Social Publishing ====================

  function resolveAutoCutFilePath(cut: any): string | null {
    if (!cut.outputPath) return null;
    let filePath = cut.outputPath;
    if (!fs.existsSync(filePath)) {
      filePath = path.join(EXPORTS_DIR, path.basename(filePath));
      if (!fs.existsSync(filePath)) return null;
    }
    return filePath;
  }

  app.post("/api/auto-cuts/:id/publish/youtube", async (req, res) => {
    try {
      const cut = await storage.getAutoCut(req.params.id);
      if (!cut) return res.status(404).json({ message: "Auto-cut not found" });
      if (cut.status !== "completed") return res.status(400).json({ message: "Auto-cut not ready" });
      const filePath = resolveAutoCutFilePath(cut);
      if (!filePath) return res.status(400).json({ message: "Auto-cut file not found on disk" });

      const title = (req.body.title as string) || cut.title || "Short";
      const rawDescription = (req.body.description as string) || "";
      const description = appendHashtags(rawDescription, title, cut.tags as string[] | undefined);
      const clipDuration = cut.endTime - cut.startTime;

      const postmypostProjectId = await resolvePostmypostProjectIdForAutoCut(cut, storage);
      let result: any;
      if (postmypostProjectId && isPostmypostConfigured()) {
        const safeTitle = (title || "Short").substring(0, 150);
        log(`[auto-cut-youtube] Publishing via Postmypost project=${postmypostProjectId}`, "social");
        const pmpResult = await uploadViaPostmypost(filePath, "youtube", safeTitle, description, postmypostProjectId);
        result = { publicationId: pmpResult.publicationId, url: "https://www.youtube.com/", method: "postmypost" };
      } else {
        result = await uploadToYouTube(filePath, title, description, clipDuration);
      }

      const urls: Record<string, string> = { youtube: result.url || "" };
      if (result.publicationId) urls.youtube_publicationId = String(result.publicationId);
      await addPublishedPlatformAutoCut(cut.id, "youtube", urls, storage);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/auto-cuts/:id/publish/vk", async (req, res) => {
    try {
      const cut = await storage.getAutoCut(req.params.id);
      if (!cut) return res.status(404).json({ message: "Auto-cut not found" });
      if (cut.status !== "completed") return res.status(400).json({ message: "Auto-cut not ready" });
      const filePath = resolveAutoCutFilePath(cut);
      if (!filePath) return res.status(400).json({ message: "Auto-cut file not found on disk" });

      const title = (req.body.title as string) || cut.title || "Short";
      const rawDescription = (req.body.description as string) || "";
      const description = appendHashtags(rawDescription, title, cut.tags as string[] | undefined);

      const postmypostProjectId = await resolvePostmypostProjectIdForAutoCut(cut, storage);
      let result: any;
      if (postmypostProjectId && isPostmypostConfigured()) {
        log(`[auto-cut-vk] Publishing via Postmypost project=${postmypostProjectId}`, "social");
        const pmResult = await uploadViaPostmypost(filePath, "vk", title, description, postmypostProjectId);
        result = { videoId: String(pmResult.publicationId), url: "", method: "postmypost", message: pmResult.message };
      } else {
        result = await uploadToVk(filePath, title, description);
        result.method = "direct";
      }

      const urls: Record<string, string> = { vk: result.url || "" };
      if (result.videoId) urls.vk_publicationId = String(result.videoId);
      await addPublishedPlatformAutoCut(cut.id, "vk", urls, storage);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/auto-cuts/:id/publish/tiktok", async (req, res) => {
    try {
      const cut = await storage.getAutoCut(req.params.id);
      if (!cut) return res.status(404).json({ message: "Auto-cut not found" });
      if (cut.status !== "completed") return res.status(400).json({ message: "Auto-cut not ready" });
      const filePath = resolveAutoCutFilePath(cut);
      if (!filePath) return res.status(400).json({ message: "Auto-cut file not found on disk" });

      const title = (req.body.title as string) || cut.title || "Short";
      const rawDescription = (req.body.description as string) || "";
      const description = appendHashtags(rawDescription, title, cut.tags as string[] | undefined);
      const clipDuration = cut.endTime - cut.startTime;

      const postmypostProjectId = await resolvePostmypostProjectIdForAutoCut(cut, storage);
      let result: any;
      if (postmypostProjectId && isPostmypostConfigured()) {
        const safeTitle = (title || "Short").substring(0, 150);
        log(`[auto-cut-tiktok] Publishing via Postmypost project=${postmypostProjectId}`, "social");
        const pmpResult = await uploadViaPostmypost(filePath, "tiktok", safeTitle, description, postmypostProjectId);
        result = { publicationId: pmpResult.publicationId, url: "https://www.tiktok.com/", method: "postmypost" };
      } else {
        result = await uploadToTikTok(filePath, title, description, clipDuration);
      }

      const urls: Record<string, string> = { tiktok: result.url || "" };
      if (result.publicationId) urls.tiktok_publicationId = String(result.publicationId);
      await addPublishedPlatformAutoCut(cut.id, "tiktok", urls, storage);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/auto-cuts/:id/publish/instagram", async (req, res) => {
    try {
      const cut = await storage.getAutoCut(req.params.id);
      if (!cut) return res.status(404).json({ message: "Auto-cut not found" });
      if (cut.status !== "completed") return res.status(400).json({ message: "Auto-cut not ready" });
      const filePath = resolveAutoCutFilePath(cut);
      if (!filePath) return res.status(400).json({ message: "Auto-cut file not found on disk" });

      const titlePart = (req.body.title as string) || cut.title || "Short";
      const descPart = (req.body.description as string) || "";
      const captionRaw = descPart ? `${titlePart}\n\n${descPart}` : titlePart;
      const caption = appendHashtags(captionRaw, titlePart, cut.tags as string[] | undefined);
      const clipDuration = cut.endTime - cut.startTime;

      const postmypostProjectId = await resolvePostmypostProjectIdForAutoCut(cut, storage);
      let result: any;
      if (postmypostProjectId && isPostmypostConfigured()) {
        const safeTitle = (titlePart || "Short").substring(0, 150);
        log(`[auto-cut-instagram] Publishing via Postmypost project=${postmypostProjectId}`, "social");
        const pmpResult = await uploadViaPostmypost(filePath, "instagram", safeTitle, caption, postmypostProjectId);
        result = { publicationId: pmpResult.publicationId, url: "https://www.instagram.com/", method: "postmypost" };
      } else {
        result = await uploadToInstagram(filePath, caption, clipDuration);
      }

      const urls: Record<string, string> = { instagram: result.url || "" };
      if (result.publicationId) urls.instagram_publicationId = String(result.publicationId);
      await addPublishedPlatformAutoCut(cut.id, "instagram", urls, storage);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/auto-cuts/:id/publish/facebook", async (req, res) => {
    try {
      const cut = await storage.getAutoCut(req.params.id);
      if (!cut) return res.status(404).json({ message: "Auto-cut not found" });
      if (cut.status !== "completed") return res.status(400).json({ message: "Auto-cut not ready" });
      const filePath = resolveAutoCutFilePath(cut);
      if (!filePath) return res.status(400).json({ message: "Auto-cut file not found on disk" });

      const title = (req.body.title as string) || cut.title || "Short";
      const rawDescription = (req.body.description as string) || "";
      const description = appendHashtags(rawDescription, title, cut.tags as string[] | undefined);
      const clipDuration = cut.endTime - cut.startTime;

      const postmypostProjectId = await resolvePostmypostProjectIdForAutoCut(cut, storage);
      let result: any;
      if (postmypostProjectId && isPostmypostConfigured()) {
        const safeTitle = (title || "Short").substring(0, 150);
        log(`[auto-cut-facebook] Publishing via Postmypost project=${postmypostProjectId}`, "social");
        const pmpResult = await uploadViaPostmypost(filePath, "facebook", safeTitle, description, postmypostProjectId);
        result = { publicationId: pmpResult.publicationId, url: "https://www.facebook.com/", method: "postmypost" };
      } else {
        result = await uploadToFacebook(filePath, title, description, clipDuration);
      }

      const urls: Record<string, string> = { facebook: result.url || "" };
      if (result.publicationId) urls.facebook_publicationId = String(result.publicationId);
      await addPublishedPlatformAutoCut(cut.id, "facebook", urls, storage);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/auto-cuts/:id/publish/threads", async (req, res) => {
    try {
      const cut = await storage.getAutoCut(req.params.id);
      if (!cut) return res.status(404).json({ message: "Auto-cut not found" });
      if (cut.status !== "completed") return res.status(400).json({ message: "Auto-cut not ready" });
      const filePath = resolveAutoCutFilePath(cut);
      if (!filePath) return res.status(400).json({ message: "Auto-cut file not found on disk" });

      const titlePart = (req.body.title as string) || cut.title || "Short";
      const descPart = (req.body.description as string) || "";
      const threadCaption = descPart ? `${titlePart}\n\n${descPart}` : titlePart;
      const clipDuration = cut.endTime - cut.startTime;

      const result = await uploadToThreads(filePath, threadCaption, clipDuration);

      await addPublishedPlatformAutoCut(cut.id, "threads", { threads: result.url || "" }, storage);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/auto-cuts/:id/unpublish/:platform", async (req, res) => {
    try {
      const cut = await storage.getAutoCut(req.params.id);
      if (!cut) return res.status(404).json({ message: "Auto-cut not found" });
      const current = (cut.publishedTo as string[]) || [];
      const platform = req.params.platform;
      if (!current.includes(platform)) {
        return res.json({ message: `${platform} not in publishedTo`, publishedTo: current });
      }
      await storage.updateAutoCut(cut.id, {
        publishedTo: current.filter(p => p !== platform),
      });
      res.json({ ok: true, publishedTo: current.filter(p => p !== platform) });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/youtube/status", async (_req, res) => {
    try {
      if (isUploadPostConfigured()) {
        const platforms = await getConnectedPlatforms();
        if (platforms.youtube) {
          return res.json({ connected: true, channelTitle: platforms.accountNames.youtube || "YouTube (Upload-Post)" });
        }
      }
      const status = await getYouTubeStatus();
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/youtube/auth", async (req, res) => {
    try {
      const proto = req.get("x-forwarded-proto") || req.protocol;
      const origin = `${proto}://${req.get("host")}`;
      const result = getAuthUrl(origin);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/youtube/callback", async (req, res) => {
    try {
      const code = req.query.code as string;
      const state = req.query.state as string;
      if (!code) return res.status(400).send("Missing code parameter");
      await handleCallback(code, state);
      res.send(`<html><body><script>window.close();</script><p>YouTube подключён! Можете закрыть эту вкладку.</p></body></html>`);
    } catch (err: any) {
      res.status(500).send(`Ошибка: ${err.message}`);
    }
  });

  app.post("/api/youtube/disconnect", async (_req, res) => {
    try {
      await disconnectYouTube();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/youtube/upload/:exportId", async (req, res) => {
    try {
      const exportJob = await storage.getExportJob(req.params.exportId);
      if (!exportJob) return res.status(404).json({ message: "Export not found" });
      if (exportJob.status !== "completed" || !exportJob.outputPath) {
        return res.status(400).json({ message: "Export not ready" });
      }

      const clip = await storage.getClip(exportJob.clipId);
      const title = (req.body.title as string) || clip?.title || "Poker Short";
      const rawDescription = (req.body.description as string) || "";
      const description = appendHashtags(rawDescription, title, clip?.reasons);

      let filePath = exportJob.outputPath;
      if (!fs.existsSync(filePath)) {
        filePath = path.join(EXPORTS_DIR, path.basename(filePath));
        if (!fs.existsSync(filePath)) {
          return res.status(400).json({ message: "Export file not found on disk" });
        }
      }

      const clipDuration = clip ? (clip.endTime - clip.startTime) : undefined;
      const thumbOffsetMs = clipDuration ? Math.round((clipDuration / 2) * 1000) : undefined;

      const postmypostProjectId = await resolvePostmypostProjectId(exportJob, storage);
      let result: { url?: string; publishId?: string; publicationId?: number; method?: string };
      if (postmypostProjectId && isPostmypostConfigured()) {
        const safeTitle = (title || "Poker Short").substring(0, 150);
        log(`[youtube-upload] Publishing via Postmypost project=${postmypostProjectId}`, "social");
        const pmpResult = await uploadViaPostmypost(filePath, "youtube", safeTitle, description, postmypostProjectId);
        result = { publicationId: pmpResult.publicationId, url: "https://www.youtube.com/", method: "postmypost" };
      } else {
        const ytResult = await uploadToYouTube(filePath, title, description, clipDuration);
        result = ytResult;

        if (ytResult.videoId && exportJob.thumbnailPath && fs.existsSync(exportJob.thumbnailPath)) {
          try {
            await setYouTubeThumbnail(ytResult.videoId, exportJob.thumbnailPath);
            log(`[youtube-upload] Custom thumbnail set for ${ytResult.videoId}`, "social");
          } catch (thumbErr: any) {
            log(`[youtube-upload] Thumbnail set failed (non-critical): ${thumbErr.message}`, "social");
          }
        }
      }

      const ytUrls: Record<string, string> = { youtube: result.url || "" };
      if (result.publicationId) ytUrls.youtube_publicationId = String(result.publicationId);
      await addPublishedPlatform(exportJob.id, "youtube", ytUrls, storage);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/youtube/thumbnail",
    multer({ dest: path.join(process.cwd(), "private_uploads"), limits: { fileSize: 5 * 1024 * 1024 } }).single("file"),
    async (req, res) => {
      try {
        const youtubeVideoId = req.body.youtubeVideoId as string;
        if (!youtubeVideoId) return res.status(400).json({ message: "Missing youtubeVideoId" });
        if (!req.file) return res.status(400).json({ message: "No image file uploaded" });

        await setYouTubeThumbnail(youtubeVideoId, req.file.path);

        try { fs.unlinkSync(req.file.path); } catch {}

        res.json({ ok: true });
      } catch (err: any) {
        if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
        log(`YouTube thumbnail error: ${err.message}`, "routes");
        res.status(500).json({ message: err.message });
      }
    }
  );

  // ==================== VK ====================
  app.get("/api/social/vk/status", async (_req, res) => {
    try {
      if (isPostmypostConfigured()) {
        const pmStatus = await getPostmypostVkStatus();
        if (pmStatus.connected) {
          res.json({
            connected: true,
            accountName: pmStatus.accountName,
            method: "postmypost",
          });
          return;
        }
      }
      const status = await getVkStatus();
      res.json({ ...status, method: "direct" });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/social/vk/auth", async (_req, res) => {
    try {
      const url = getVkAuthUrl();
      res.json({ url });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/social/vk/save-token", async (req, res) => {
    try {
      const { accessToken, userId, expiresIn, groupId } = req.body;
      if (!accessToken) return res.status(400).json({ success: false, message: "Missing accessToken" });
      const result = await saveVkToken(accessToken, userId || "", expiresIn || null, groupId || null);
      res.json({ success: true, accountName: result.accountName });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post("/api/social/vk/disconnect", async (_req, res) => {
    try {
      await disconnectVk();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/social/vk/group", async (req, res) => {
    try {
      const groupId = String(req.body.groupId || "").trim();
      if (!groupId) return res.status(400).json({ message: "groupId обязателен" });
      const result = await setVkGroup(groupId);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.delete("/api/social/vk/group", async (_req, res) => {
    try {
      await clearVkGroup();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/social/vk/upload/:exportId", async (req, res) => {
    try {
      const exportJob = await storage.getExportJob(req.params.exportId);
      if (!exportJob) return res.status(404).json({ message: "Export not found" });
      if (exportJob.status !== "completed" || !exportJob.outputPath) {
        return res.status(400).json({ message: "Export not ready" });
      }
      const clip = await storage.getClip(exportJob.clipId);
      const title = (req.body.title as string) || clip?.title || "Poker Short";
      const rawDescription = (req.body.description as string) || "";
      const description = appendHashtags(rawDescription, title, clip?.reasons);
      let filePath = exportJob.outputPath;
      if (!fs.existsSync(filePath)) {
        filePath = path.join(EXPORTS_DIR, path.basename(filePath));
        if (!fs.existsSync(filePath)) {
          return res.status(400).json({ message: "Export file not found on disk" });
        }
      }

      let result: any;
      const postmypostProjectId = await resolvePostmypostProjectId(exportJob, storage);
      if (postmypostProjectId && isPostmypostConfigured()) {
        log(`[vk-upload] Publishing via Postmypost project=${postmypostProjectId}`, "social");
        const pmResult = await uploadViaPostmypost(filePath, "vk", title, description, postmypostProjectId);
        result = { videoId: String(pmResult.publicationId), url: "", method: "postmypost", message: pmResult.message };
      }
      if (!result) {
        result = await uploadToVk(filePath, title, description);
        result.method = "direct";
      }

      const vkUrls: Record<string, string> = { vk: result.url || "" };
      if (result.videoId) vkUrls.vk_publicationId = String(result.videoId);
      await addPublishedPlatform(exportJob.id, "vk", vkUrls, storage);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/social/vk/publication-status/:publicationId", async (req, res) => {
    try {
      if (!isPostmypostConfigured()) {
        return res.status(400).json({ message: "Postmypost не настроен" });
      }
      const publicationId = parseInt(req.params.publicationId, 10);
      if (isNaN(publicationId)) {
        return res.status(400).json({ message: "Некорректный ID публикации" });
      }
      const status = await getPublicationStatus(publicationId);
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/social/postmypost/publication-status/:publicationId", async (req, res) => {
    try {
      if (!isPostmypostConfigured()) {
        return res.status(400).json({ message: "Postmypost не настроен" });
      }
      const publicationId = parseInt(req.params.publicationId, 10);
      if (isNaN(publicationId)) {
        return res.status(400).json({ message: "Некорректный ID публикации" });
      }
      const status = await getPublicationStatus(publicationId);
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ==================== TikTok ====================
  app.get("/api/social/tiktok/status", async (_req, res) => {
    try {
      const status = await getTikTokStatus();
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/social/tiktok/auth", async (req, res) => {
    try {
      const proto = req.get("x-forwarded-proto") || req.protocol;
      const origin = `${proto}://${req.get("host")}`;
      const result = getTikTokAuthUrl(origin);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/social/tiktok/callback", async (req, res) => {
    try {
      const code = req.query.code as string;
      const state = req.query.state as string;
      if (!code) return res.status(400).send("Missing code parameter");
      await handleTikTokCallback(code, state);
      res.send(`<html><body><script>window.close();</script><p>TikTok подключён! Можете закрыть эту вкладку.</p></body></html>`);
    } catch (err: any) {
      res.status(500).send(`Ошибка: ${err.message}`);
    }
  });

  app.post("/api/social/tiktok/disconnect", async (_req, res) => {
    try {
      await disconnectTikTok();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/social/tiktok/upload/:exportId", async (req, res) => {
    try {
      log(`[tiktok-upload] Starting TikTok upload for export ${req.params.exportId}`, "social");
      const exportJob = await storage.getExportJob(req.params.exportId);
      if (!exportJob) return res.status(404).json({ message: "Export not found" });
      if (exportJob.status !== "completed" || !exportJob.outputPath) {
        return res.status(400).json({ message: "Export not ready" });
      }
      const clip = await storage.getClip(exportJob.clipId);
      const title = (req.body.title as string) || clip?.title || "Poker Short";
      const rawDescription = (req.body.description as string) || "";
      const description = appendHashtags(rawDescription, title, clip?.reasons);
      let filePath = exportJob.outputPath;
      if (!fs.existsSync(filePath)) {
        filePath = path.join(EXPORTS_DIR, path.basename(filePath));
        if (!fs.existsSync(filePath)) {
          log(`[tiktok-upload] File not found: ${exportJob.outputPath}`, "social");
          return res.status(400).json({ message: "Export file not found on disk" });
        }
      }
      const clipDuration = clip ? (clip.endTime - clip.startTime) : undefined;

      const postmypostProjectId = await resolvePostmypostProjectId(exportJob, storage);
      let result: any;
      if (postmypostProjectId && isPostmypostConfigured()) {
        const safeTitle = (title || "Poker Short").substring(0, 150);
        log(`[tiktok-upload] Publishing via Postmypost project=${postmypostProjectId}`, "social");
        const pmpResult = await uploadViaPostmypost(filePath, "tiktok", safeTitle, description, postmypostProjectId);
        result = { publicationId: pmpResult.publicationId, url: "https://www.tiktok.com/", method: "postmypost" };
      } else {
        log(`[tiktok-upload] Using direct TikTok upload`, "social");
        result = await uploadToTikTok(filePath, title, description, clipDuration);
      }

      const ttUrls: Record<string, string> = { tiktok: result.url || "" };
      if (result.publicationId) ttUrls.tiktok_publicationId = String(result.publicationId);
      await addPublishedPlatform(exportJob.id, "tiktok", ttUrls, storage);
      res.json(result);
    } catch (err: any) {
      log(`[tiktok-upload] ERROR: ${err.message}`, "social");
      res.status(500).json({ message: err.message });
    }
  });

  // ==================== Instagram ====================
  app.get("/api/social/instagram/status", async (_req, res) => {
    try {
      const status = await getInstagramStatus();
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/social/instagram/auth", async (req, res) => {
    try {
      const proto = req.get("x-forwarded-proto") || req.protocol;
      const origin = `${proto}://${req.get("host")}`;
      const result = getInstagramAuthUrl(origin);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/social/instagram/callback", async (req, res) => {
    try {
      const code = req.query.code as string;
      const state = req.query.state as string;
      if (!code) return res.status(400).send("Missing code parameter");
      await handleInstagramCallback(code, state);
      res.send(`<html><body><script>window.close();</script><p>Instagram подключён! Можете закрыть эту вкладку.</p></body></html>`);
    } catch (err: any) {
      res.status(500).send(`Ошибка: ${err.message}`);
    }
  });

  app.post("/api/social/instagram/disconnect", async (_req, res) => {
    try {
      await disconnectInstagram();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/social/instagram/upload/:exportId", async (req, res) => {
    try {
      const exportJob = await storage.getExportJob(req.params.exportId);
      if (!exportJob) return res.status(404).json({ message: "Export not found" });
      if (exportJob.status !== "completed" || !exportJob.outputPath) {
        return res.status(400).json({ message: "Export not ready" });
      }
      const clip = await storage.getClip(exportJob.clipId);
      const titlePart = (req.body.title as string) || clip?.title || "Poker Short";
      const descPart = (req.body.description as string) || "";
      const captionRaw = descPart ? `${titlePart}\n\n${descPart}` : titlePart;
      const caption = appendHashtags(captionRaw, titlePart, clip?.reasons);
      let filePath = exportJob.outputPath;
      if (!fs.existsSync(filePath)) {
        filePath = path.join(EXPORTS_DIR, path.basename(filePath));
        if (!fs.existsSync(filePath)) {
          return res.status(400).json({ message: "Export file not found on disk" });
        }
      }
      const clipDuration = clip ? (clip.endTime - clip.startTime) : undefined;

      const postmypostProjectId = await resolvePostmypostProjectId(exportJob, storage);
      let result: any;
      if (postmypostProjectId && isPostmypostConfigured()) {
        log(`[instagram-upload] Publishing via Postmypost project=${postmypostProjectId}`, "social");
        const pmpResult = await uploadViaPostmypost(filePath, "instagram", caption, "", postmypostProjectId);
        result = { publicationId: pmpResult.publicationId, url: "https://www.instagram.com/", method: "postmypost" };
      } else {
        const videoForType = await storage.getVideo(exportJob.videoId);
        result = await uploadToInstagram(filePath, caption, clipDuration, videoForType?.contentType);
      }

      const igUrls: Record<string, string> = { instagram: result.url || "" };
      if (result.publicationId) igUrls.instagram_publicationId = String(result.publicationId);
      await addPublishedPlatform(exportJob.id, "instagram", igUrls, storage);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ==================== Facebook ====================
  app.get("/api/social/facebook/status", async (_req, res) => {
    try {
      const status = await getFacebookStatus();
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/social/facebook/upload/:exportId", async (req, res) => {
    try {
      const exportJob = await storage.getExportJob(req.params.exportId);
      if (!exportJob) return res.status(404).json({ message: "Export not found" });
      if (exportJob.status !== "completed" || !exportJob.outputPath) {
        return res.status(400).json({ message: "Export not ready" });
      }
      const clip = await storage.getClip(exportJob.clipId);
      const title = (req.body.title as string) || clip?.title || "Poker Short";
      const rawDescription = (req.body.description as string) || "";
      const description = appendHashtags(rawDescription, title, clip?.reasons);
      let filePath = exportJob.outputPath;
      if (!fs.existsSync(filePath)) {
        filePath = path.join(EXPORTS_DIR, path.basename(filePath));
        if (!fs.existsSync(filePath)) {
          return res.status(400).json({ message: "Export file not found on disk" });
        }
      }
      const clipDuration = clip ? (clip.endTime - clip.startTime) : undefined;

      const postmypostProjectId = await resolvePostmypostProjectId(exportJob, storage);
      let result: any;
      if (postmypostProjectId && isPostmypostConfigured()) {
        const safeTitle = (title || "Poker Short").substring(0, 150);
        log(`[facebook-upload] Publishing via Postmypost project=${postmypostProjectId}`, "social");
        const pmpResult = await uploadViaPostmypost(filePath, "facebook", safeTitle, description, postmypostProjectId);
        result = { publicationId: pmpResult.publicationId, url: "https://www.facebook.com/", method: "postmypost" };
      } else {
        result = await uploadToFacebook(filePath, title, description, clipDuration);
      }

      const fbUrls: Record<string, string> = { facebook: result.url || "" };
      if (result.publicationId) fbUrls.facebook_publicationId = String(result.publicationId);
      await addPublishedPlatform(exportJob.id, "facebook", fbUrls, storage);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ==================== Threads ====================
  app.get("/api/social/threads/status", async (_req, res) => {
    try {
      const status = await getThreadsStatus();
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/social/threads/upload/:exportId", async (req, res) => {
    try {
      const exportJob = await storage.getExportJob(req.params.exportId);
      if (!exportJob) return res.status(404).json({ message: "Export not found" });
      if (exportJob.status !== "completed" || !exportJob.outputPath) {
        return res.status(400).json({ message: "Export not ready" });
      }
      const clip = await storage.getClip(exportJob.clipId);
      const titlePart = (req.body.title as string) || clip?.title || "Poker Short";
      const descPart = (req.body.description as string) || "";
      const threadCaption = descPart ? `${titlePart}\n\n${descPart}` : titlePart;
      let filePath = exportJob.outputPath;
      if (!fs.existsSync(filePath)) {
        filePath = path.join(EXPORTS_DIR, path.basename(filePath));
        if (!fs.existsSync(filePath)) {
          return res.status(400).json({ message: "Export file not found on disk" });
        }
      }
      const clipDuration = clip ? (clip.endTime - clip.startTime) : undefined;

      let result: any;
      result = await uploadToThreads(filePath, threadCaption, clipDuration);

      await addPublishedPlatform(exportJob.id, "threads", { threads: result.url || "" }, storage);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ==================== Upload-Post Status ====================
  app.get("/api/social/upload-post/status", async (_req, res) => {
    try {
      const configured = isUploadPostConfigured();
      if (!configured) {
        return res.json({ configured: false, platforms: {} });
      }
      const platforms = await getConnectedPlatforms();
      res.json({ configured: true, platforms });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/social/upload-post/refresh", async (_req, res) => {
    try {
      clearPlatformCache();
      const platforms = await getConnectedPlatforms();
      res.json({ success: true, platforms });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/social/upload-post/refresh-urls/:exportId", async (req, res) => {
    try {
      const exportJob = await storage.getExportJob(req.params.exportId);
      if (!exportJob) return res.status(404).json({ message: "Export not found" });
      const currentUrls = (exportJob.publishedUrls as Record<string, string>) || {};
      const publishedTo = exportJob.publishedTo || [];
      const uploadPostPlatforms = ["instagram", "tiktok", "facebook", "threads"];
      const updated: Record<string, string> = { ...currentUrls };
      let anyUpdated = false;

      for (const platform of uploadPostPlatforms) {
        if (!publishedTo.includes(platform)) continue;
        if (currentUrls[platform] && currentUrls[platform] !== genericPlatformUrl(platform)) continue;
        const storedRequestId = currentUrls[`${platform}_requestId`];
        if (!storedRequestId) continue;
        const postUrl = await findPostUrlByRequestId(storedRequestId, platform);
        if (postUrl) {
          updated[platform] = postUrl;
          anyUpdated = true;
        }
      }

      if (anyUpdated) {
        await storage.updateExportJob(exportJob.id, { publishedUrls: updated });
      }
      res.json({ success: true, publishedUrls: updated, updated: anyUpdated });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/social/upload-post/job-status", async (req, res) => {
    try {
      const requestId = req.query.request_id as string | undefined;
      const jobId = req.query.job_id as string | undefined;
      const result = await getUploadPostStatus(requestId, jobId);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Static serving for generated videos
  const generatedDir = path.join(process.cwd(), "uploads", "generated");
  if (!fs.existsSync(generatedDir)) fs.mkdirSync(generatedDir, { recursive: true });
  app.get("/uploads/generated/:filename", (req, res) => {
    const filePath = path.join(generatedDir, req.params.filename);
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      res.status(404).json({ message: "File not found" });
    }
  });

  app.get("/uploads/generated/images/:filename", (req, res) => {
    const filePath = path.join(generatedDir, "images", req.params.filename);
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      res.status(404).json({ message: "File not found" });
    }
  });

  // ===== Generated Videos (Grok AI) =====

  app.get("/api/xai/status", async (_req, res) => {
    res.json({ configured: isXaiConfigured() });
  });

  app.get("/api/generated-videos", async (_req, res) => {
    try {
      const items = await storage.getGeneratedVideos();
      res.json(items);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/generated-videos/:id", async (req, res) => {
    try {
      const item = await storage.getGeneratedVideo(req.params.id);
      if (!item) return res.status(404).json({ message: "Not found" });
      res.json(item);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.patch("/api/generated-videos/:id", async (req, res) => {
    try {
      const video = await storage.getGeneratedVideo(req.params.id);
      if (!video) return res.status(404).json({ message: "Not found" });
      const { title, profileId } = req.body;
      const updates: Record<string, any> = {};
      if (title !== undefined) updates.title = title;
      if (profileId !== undefined) updates.profileId = profileId || null;
      const updated = await storage.updateGeneratedVideo(video.id, updates);
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/generated-videos", async (req, res) => {
    try {
      const { title, profileId } = req.body;
      const item = await storage.createGeneratedVideo({
        title: title || "Новое видео",
        status: "draft",
        clips: [],
        profileId: profileId || null,
      });
      res.json(item);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.delete("/api/generated-videos/:id", async (req, res) => {
    try {
      await storage.deleteGeneratedVideo(req.params.id);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/generated-videos/:id/generate-clip", async (req, res) => {
    try {
      const { prompt } = req.body;
      if (!prompt) return res.status(400).json({ message: "Prompt required" });

      const video = await storage.getGeneratedVideo(req.params.id);
      if (!video) return res.status(404).json({ message: "Not found" });

      const clipId = uuidv4();
      const newClip: GeneratedClip = {
        id: clipId,
        prompt,
        status: "generating",
        createdAt: new Date().toISOString(),
      };

      const currentClips = (video.clips as GeneratedClip[]) || [];
      await storage.updateGeneratedVideo(video.id, {
        clips: [...currentClips, newClip],
      });

      const provider = req.body.provider || (isFalConfigured() ? "fal" : isVeoConfigured() ? "veo" : "xai");
      const veoModel = req.body.model || "veo-3.0-generate-001";
      const falModel = req.body.falModel || "fal-ai/kling-video/v2.1/standard/image-to-video";
      const sceneIndex = req.body.sceneIndex;
      const imagePath = req.body.imagePath;

      res.json({ clipId, status: "generating", provider });

      (async () => {
        try {
          const outputDir = path.join("uploads", "generated");
          const filename = `${clipId}.mp4`;
          let localPath: string;

          if (provider === "fal") {
            const result = await generateFalVideo(prompt, {
              imagePath: imagePath || undefined,
              model: falModel,
              aspectRatio: "9:16",
              duration: "5",
            });
            localPath = await downloadFalVideo(result.videoUrl, path.join(outputDir, filename));
          } else if (provider === "veo") {
            const result = await generateVeoVideo(prompt, { model: veoModel, aspectRatio: "9:16" });
            localPath = await downloadVeoVideo(result.videoUrl, outputDir, filename);
          } else {
            const result = await generateVideo(prompt);
            localPath = await downloadVideo(result.videoUrl, outputDir, filename);
          }

          const updated = await storage.getGeneratedVideo(video.id);
          if (!updated) return;
          const clips = (updated.clips as GeneratedClip[]) || [];
          const idx = clips.findIndex(c => c.id === clipId);
          if (idx >= 0) {
            clips[idx] = {
              ...clips[idx],
              status: "completed",
              localPath,
            };
            await storage.updateGeneratedVideo(video.id, { clips });
          }
          log(`[veo] Clip ${clipId} generated successfully (${provider})`, "veo");
        } catch (err: any) {
          log(`[veo] Clip ${clipId} generation failed (${provider}): ${err.message}`, "veo");
          const updated = await storage.getGeneratedVideo(video.id);
          if (!updated) return;
          const clips = (updated.clips as GeneratedClip[]) || [];
          const idx = clips.findIndex(c => c.id === clipId);
          if (idx >= 0) {
            clips[idx] = { ...clips[idx], status: "error", error: err.message };
            await storage.updateGeneratedVideo(video.id, { clips });
          }
        }
      })();
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.delete("/api/generated-videos/:id/clips/:clipId", async (req, res) => {
    try {
      const video = await storage.getGeneratedVideo(req.params.id);
      if (!video) return res.status(404).json({ message: "Not found" });

      const clips = ((video.clips as GeneratedClip[]) || []).filter(c => c.id !== req.params.clipId);
      await storage.updateGeneratedVideo(video.id, { clips });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ===== Auto Pipeline: Scenario → TTS → Generate clips → Assemble =====

  app.post("/api/generated-videos/:id/generate-scenario", async (req, res) => {
    try {
      const { topic, language = "en" } = req.body;
      if (!topic) return res.status(400).json({ message: "Topic required" });

      const video = await storage.getGeneratedVideo(req.params.id);
      if (!video) return res.status(404).json({ message: "Not found" });

      const OpenAI = (await import("openai")).default;
      const openai = new OpenAI({
        apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
        baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
      });

      const lang = language === "en" ? "English" : "Russian";

      const systemPrompt = `You are a viral short-form video scriptwriter for YouTube Shorts / TikTok / Reels.

Your job: Create a deeply realistic, human, emotionally engaging video scenario based on the user's concept.

CRITICAL RULES:
- Write in ${lang}
- Create 10-14 scenes — this is a DETAILED story with real-life progression
- Each scene needs: a vivid visual prompt for AI image generation, narration text for TTS voiceover, and a duration hint
- The SAME main character must appear in ALL scenes — EXACTLY same face, hair, skin tone, eye color. Describe her consistently every time.
- Narration must feel HUMAN and REAL — like someone talking to a friend, not a corporate script
- Each scene narration: 3-4 sentences with specific details (numbers, feelings, real situations)
- Include real-life struggles: cravings, bad days, plateaus, social pressure, motivation drops
- Show weekly/monthly progression with SPECIFIC changes (weight, measurements, energy levels, mood)
- First scene MUST be a strong emotional hook
- Last scene: satisfying result + call to action

NARRATION STYLE:
- Conversational, like a real person telling their story
- Include specific details: "На второй неделе весы показали минус 1.5 кг"
- Mention real feelings: frustration, excitement, doubt, pride
- Reference real situations: looking in the mirror, trying on old clothes, comments from friends

SCENE TYPES:
- "intro" — emotional hook, "before" state
- "progression" — weekly/monthly changes with details
- "climax" — breakthrough moment, biggest visible change
- "conclusion" — final result, reflection, call to action

Return ONLY a valid JSON array:
[
  {"sceneIndex":0,"sceneType":"intro","visualPrompt":"...","narrationText":"...","durationHint":6},
  {"sceneIndex":1,"sceneType":"progression","visualPrompt":"...","narrationText":"...","durationHint":7},
  ...
]

VISUAL PROMPT RULES:
- EVERY prompt must describe the SAME character with identical features (specify: hair color+length, skin tone, eye color, age, height)
- Show realistic body changes gradually — not dramatic overnight transformations
- Include environment details: kitchen, gym, mirror, bedroom, grocery store, park
- Art style: photorealistic 3D render, soft natural lighting, vertical 9:16 format, centered composition
- Include camera angle: "full body shot", "close-up face", "medium shot from waist up", "mirror selfie angle"
- Show emotions on face: tired, determined, surprised, proud, frustrated, happy`;

      const response = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Video concept: ${topic}` },
        ],
        temperature: 0.85,
        max_tokens: 6000,
      });

      const content = response.choices[0]?.message?.content || "";
      log(`[auto-pipeline] GPT scenario response: ${content.substring(0, 500)}`, "xai");

      let scenarios: SceneData[];
      try {
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error("No JSON array found in response");
        scenarios = JSON.parse(jsonMatch[0]);
      } catch (parseErr) {
        return res.status(500).json({ message: `Failed to parse GPT response: ${(parseErr as Error).message}`, raw: content });
      }

      const fullNarration = scenarios.map(s => s.narrationText).join(" ");

      await storage.updateGeneratedVideo(video.id, {
        scenario: scenarios,
        narrationText: fullNarration,
        title: video.title || topic.substring(0, 60),
      });

      res.json({ scenarios, narrationText: fullNarration });
    } catch (err: any) {
      log(`[auto-pipeline] Scenario error: ${err.message}`, "xai");
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/generated-videos/:id/generate-tts", async (req, res) => {
    try {
      const video = await storage.getGeneratedVideo(req.params.id);
      if (!video) return res.status(404).json({ message: "Not found" });

      const narration = video.narrationText || req.body.text;
      if (!narration) return res.status(400).json({ message: "No narration text" });

      const voice = req.body.voice || "nova";

      log(`[auto-pipeline] Generating TTS for ${narration.length} chars, voice: ${voice}`, "xai");

      const { textToSpeech } = await import("./replit_integrations/audio/client");
      const buffer = await textToSpeech(narration, voice, "mp3");

      const outputDir = path.join("uploads", "generated");
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      const ttsFilename = `tts_${video.id}.mp3`;
      const ttsPath = path.join(outputDir, ttsFilename);

      fs.writeFileSync(ttsPath, buffer);

      await storage.updateGeneratedVideo(video.id, { ttsPath });

      log(`[auto-pipeline] TTS saved: ${ttsPath} (${(buffer.length / 1024).toFixed(0)}KB)`, "xai");
      res.json({ ttsPath, size: buffer.length });
    } catch (err: any) {
      log(`[auto-pipeline] TTS error: ${err.message}`, "xai");
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/generated-videos/:id/generate-images", async (req, res) => {
    try {
      const video = await storage.getGeneratedVideo(req.params.id);
      if (!video) return res.status(404).json({ message: "Not found" });

      const scenarios = video.scenario as SceneData[];
      if (!scenarios || scenarios.length === 0) {
        return res.status(400).json({ message: "No scenario. Generate scenario first." });
      }

      const provider = req.body.provider || "openai";
      const imageModel = req.body.model;
      const imageQuality = req.body.quality || "medium";

      const referenceImagePath = req.body.referenceImagePath;
      let refBase64: string | undefined;
      let refMime: string | undefined;
      if (referenceImagePath && fs.existsSync(referenceImagePath)) {
        refBase64 = fs.readFileSync(referenceImagePath).toString("base64");
        refMime = referenceImagePath.endsWith(".jpg") || referenceImagePath.endsWith(".jpeg") ? "image/jpeg" : "image/png";
      }

      const outputDir = path.join("uploads", "generated", "images");
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

      res.json({ status: "started", total: scenarios.length, provider });

      (async () => {
        for (let i = 0; i < scenarios.length; i++) {
          const scene = scenarios[i];
          const prompt = scene.imagePrompt || scene.visualPrompt;

          try {
            log(`[auto-pipeline] Generating image ${i + 1}/${scenarios.length} via ${provider}: "${prompt.substring(0, 60)}..."`, "imagen");

            let imageData: { base64: string; mimeType: string };
            if (provider === "gemini") {
              imageData = await generateImageWithGemini(prompt, {
                referenceImageBase64: refBase64,
                referenceImageMimeType: refMime,
              });
            } else if (provider === "imagen") {
              imageData = await generateImage(prompt, {
                model: imageModel || "imagen-4.0-generate-001",
                aspectRatio: "9:16",
                referenceImageBase64: refBase64,
                referenceImageMimeType: refMime,
              });
            } else {
              imageData = await generateImageWithOpenAI(prompt, {
                model: imageModel || "gpt-image-1",
                size: "1024x1536",
                quality: imageQuality,
              });
            }

            const filename = `scene_${video.id}_${i}`;
            const imagePath = await saveBase64Image(imageData.base64, imageData.mimeType, outputDir, filename);

            scenarios[i] = { ...scene, imagePath };
            await storage.updateGeneratedVideo(video.id, { scenario: scenarios });

            log(`[auto-pipeline] Image ${i + 1}/${scenarios.length} saved: ${imagePath}`, "imagen");
          } catch (err: any) {
            log(`[auto-pipeline] Image ${i + 1} error: ${err.message}`, "imagen");
          }
        }
        log(`[auto-pipeline] All ${scenarios.length} images done`, "imagen");
      })();
    } catch (err: any) {
      log(`[auto-pipeline] Images error: ${err.message}`, "imagen");
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/generated-videos/:id/generate-all-clips", async (req, res) => {
    try {
      const video = await storage.getGeneratedVideo(req.params.id);
      if (!video) return res.status(404).json({ message: "Not found" });

      const scenarios = video.scenario as SceneData[];
      if (!scenarios || scenarios.length === 0) {
        return res.status(400).json({ message: "No scenario. Generate scenario first." });
      }

      const newClips: GeneratedClip[] = scenarios.map((scene, idx) => ({
        id: uuidv4(),
        prompt: scene.visualPrompt,
        sceneIndex: idx,
        status: "generating" as const,
        createdAt: new Date().toISOString(),
      }));

      await storage.updateGeneratedVideo(video.id, { clips: newClips });
      res.json({ clips: newClips.length, status: "generating" });

      const provider = req.body.provider || (isFalConfigured() ? "fal" : isVeoConfigured() ? "veo" : "xai");
      const veoModel = req.body.model || "veo-3.0-generate-001";
      const falModel = req.body.falModel || "fal-ai/kling-video/v2.1/standard/image-to-video";

      (async () => {
        for (let i = 0; i < newClips.length; i++) {
          const clip = newClips[i];
          const scene = scenarios[i];
          try {
            const hasImage = scene?.imagePath && fs.existsSync(scene.imagePath);
            const mode = hasImage ? "image-to-video" : "text-to-video";
            log(`[auto-pipeline] Generating clip ${i + 1}/${newClips.length} via ${provider} (${mode}): "${clip.prompt.substring(0, 60)}..."`, "veo");

            const outputDir = path.join("uploads", "generated");
            const filename = `${clip.id}.mp4`;
            let localPath: string;

            if (provider === "fal") {
              const result = await generateFalVideo(clip.prompt, {
                imagePath: hasImage ? scene.imagePath! : undefined,
                model: falModel,
                aspectRatio: "9:16",
                duration: "5",
              });
              localPath = await downloadFalVideo(result.videoUrl, path.join(outputDir, filename));
            } else if (provider === "veo") {
              const veoOptions: any = { model: veoModel, aspectRatio: "9:16" };
              if (hasImage) {
                const imgBuffer = fs.readFileSync(scene.imagePath!);
                veoOptions.imageBase64 = imgBuffer.toString("base64");
                veoOptions.imageMimeType = scene.imagePath!.endsWith(".jpg") || scene.imagePath!.endsWith(".jpeg") ? "image/jpeg" : "image/png";
              }
              const result = await generateVeoVideo(clip.prompt, veoOptions);
              localPath = await downloadVeoVideo(result.videoUrl, outputDir, filename);
            } else {
              const result = await generateVideo(clip.prompt);
              localPath = await downloadVideo(result.videoUrl, outputDir, filename);
            }

            const updated = await storage.getGeneratedVideo(video.id);
            if (!updated) break;
            const clips = (updated.clips as GeneratedClip[]) || [];
            const idx = clips.findIndex(c => c.id === clip.id);
            if (idx >= 0) {
              clips[idx] = { ...clips[idx], status: "completed", localPath };
              await storage.updateGeneratedVideo(video.id, { clips });
            }
            log(`[auto-pipeline] Clip ${i + 1}/${newClips.length} completed (${provider}, ${mode})`, "veo");
          } catch (err: any) {
            log(`[auto-pipeline] Clip ${i + 1} error (${provider}): ${err.message}`, "veo");
            const updated = await storage.getGeneratedVideo(video.id);
            if (!updated) break;
            const clips = (updated.clips as GeneratedClip[]) || [];
            const idx = clips.findIndex(c => c.id === clip.id);
            if (idx >= 0) {
              clips[idx] = { ...clips[idx], status: "error", error: err.message };
              await storage.updateGeneratedVideo(video.id, { clips });
            }
          }
        }
      })();
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/generated-videos/:id/assemble", async (req, res) => {
    try {
      const video = await storage.getGeneratedVideo(req.params.id);
      if (!video) return res.status(404).json({ message: "Not found" });

      const clips = (video.clips as GeneratedClip[]) || [];
      const completedClips = clips.filter(c => c.status === "completed" && c.localPath);
      if (completedClips.length === 0) {
        return res.status(400).json({ message: "No completed clips" });
      }

      await storage.updateGeneratedVideo(video.id, { status: "processing" });
      res.json({ ok: true, status: "processing" });

      const { execSync } = await import("child_process");
      const { textToSpeech } = await import("./replit_integrations/audio/client");
      const { openai: aiClient } = await import("./replit_integrations/audio/client");

      const outputDir = path.join("uploads", "generated");
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

      const getDuration = (filePath: string): number => {
        try {
          return parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`, { timeout: 10000 }).toString().trim()) || 0;
        } catch { return 0; }
      };

      (async () => {
        try {
          const scenarios = (video.scenario as SceneData[]) || [];
          const voice = req.body.voice || "nova";
          const scenarioClips = completedClips.filter(c => c.sceneIndex != null);
          const sortedClips = (scenarioClips.length > 0 ? scenarioClips : completedClips)
            .sort((a, b) => (a.sceneIndex ?? 0) - (b.sceneIndex ?? 0));

          const clipDurations = sortedClips.map(c => getDuration(c.localPath!));
          const clipStartTimes: number[] = [];
          let cumTime = 0;
          for (const d of clipDurations) { clipStartTimes.push(cumTime); cumTime += d; }
          const totalVideoDuration = cumTime;

          log(`[assemble] ${sortedClips.length} clips, total video: ${totalVideoDuration.toFixed(1)}s, clip durations: ${clipDurations.map(d => d.toFixed(1)).join(",")}`, "veo");

          log(`[assemble] Step 1: Generating TTS for ${sortedClips.length} scenes, voice: ${voice}`, "veo");

          const sceneTtsFiles: string[] = [];
          const sceneWordTimings: Array<Array<{ word: string; start: number; end: number }>> = [];

          for (let i = 0; i < sortedClips.length; i++) {
            const sceneIdx = sortedClips[i].sceneIndex ?? i;
            const scene = scenarios[sceneIdx];
            const narration = scene?.narrationText || "";
            if (!narration.trim()) {
              sceneTtsFiles.push("");
              sceneWordTimings.push([]);
              continue;
            }

            log(`[assemble] TTS scene ${i}: "${narration.substring(0, 60)}..."`, "veo");
            const ttsBuffer = await textToSpeech(narration, voice, "mp3");
            const ttsTempPath = path.join(outputDir, `tts_scene_${video.id}_${i}.mp3`);
            fs.writeFileSync(ttsTempPath, ttsBuffer);
            sceneTtsFiles.push(ttsTempPath);

            const ttsDur = getDuration(ttsTempPath);
            const sceneStart = clipStartTimes[i];

            let wordTimings: Array<{ word: string; start: number; end: number }> = [];
            try {
              const { toFile } = await import("openai");
              const file = await toFile(ttsBuffer, "audio.mp3");
              const transcription = await aiClient.audio.transcriptions.create({
                file,
                model: "gpt-4o-mini-transcribe",
                language: "ru",
              } as any);
              const ttsText = ((transcription as any).text || "").trim();
              const ttsWords = ttsText.split(/\s+/).filter((w: string) => w.trim());
              const ttsWordDur = ttsWords.length > 0 ? (ttsDur || 4) / ttsWords.length : 1;
              wordTimings = ttsWords.map((w: string, wi: number) => ({
                word: w,
                start: sceneStart + wi * ttsWordDur,
                end: sceneStart + (wi + 1) * ttsWordDur,
              }));
              log(`[assemble] Transcribe: ${wordTimings.length} words for scene ${i}, TTS ${ttsDur.toFixed(1)}s, clip ${clipDurations[i].toFixed(1)}s`, "veo");
            } catch (whisperErr: any) {
              log(`[assemble] Whisper failed for scene ${i}: ${whisperErr.message}, using fallback`, "veo");
              const words = narration.split(/\s+/);
              const wordDur = (ttsDur || 4) / words.length;
              wordTimings = words.map((w, wi) => ({
                word: w,
                start: sceneStart + wi * wordDur,
                end: sceneStart + (wi + 1) * wordDur,
              }));
            }
            sceneWordTimings.push(wordTimings);
          }

          log(`[assemble] Step 2: Concatenating ${sortedClips.length} video clips`, "veo");

          const concatListPath = path.join(outputDir, `concat_list_${video.id}.txt`);
          const concatVideoPath = path.join(outputDir, `concat_video_${video.id}.mp4`);

          const concatLines = sortedClips.map(c => `file '${path.resolve(c.localPath!)}'`).join("\n");
          fs.writeFileSync(concatListPath, concatLines);
          execSync(`ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c copy "${concatVideoPath}"`, { timeout: 120000 });
          try { fs.unlinkSync(concatListPath); } catch {}

          log(`[assemble] Step 3: Building aligned TTS audio track`, "veo");

          const mergedTtsPath = path.join(outputDir, `tts_merged_${video.id}.m4a`);
          const adelayParts: string[] = [];
          const ttsInputs: string[] = [];
          let inputIdx = 0;

          for (let i = 0; i < sortedClips.length; i++) {
            const ttsFile = sceneTtsFiles[i];
            if (!ttsFile) continue;
            ttsInputs.push(`-i "${ttsFile}"`);
            const delayMs = Math.round(clipStartTimes[i] * 1000);
            adelayParts.push(`[${inputIdx}:a]adelay=${delayMs}|${delayMs}[a${inputIdx}]`);
            inputIdx++;
          }

          if (ttsInputs.length > 0) {
            if (ttsInputs.length === 1 && clipStartTimes[0] === 0) {
              fs.copyFileSync(sceneTtsFiles.find(f => f)!, mergedTtsPath);
            } else {
              const mixInputs = Array.from({ length: inputIdx }, (_, i) => `[a${i}]`).join("");
              const weights = Array.from({ length: inputIdx }, () => "1").join(" ");
              const filterComplex = `${adelayParts.join(";")};${mixInputs}amix=inputs=${inputIdx}:duration=longest:dropout_transition=0:weights=${weights}:normalize=0[outa]`;
              execSync(`ffmpeg -y ${ttsInputs.join(" ")} -filter_complex "${filterComplex}" -map "[outa]" -c:a aac -b:a 128k "${mergedTtsPath}"`, { timeout: 120000 });
            }
            await storage.updateGeneratedVideo(video.id, { ttsPath: mergedTtsPath });
            log(`[assemble] TTS merged: ${getDuration(mergedTtsPath).toFixed(1)}s`, "veo");
          }

          log(`[assemble] Step 4: Generating ASS subtitles (karaoke style)`, "veo");

          const allWords = sceneWordTimings.flat();
          const assPath = path.join(outputDir, `subs_${video.id}.ass`);

          const formatAssTime = (seconds: number): string => {
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            const s = Math.floor(seconds % 60);
            const cs = Math.round((seconds % 1) * 100);
            return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
          };

          const assHeader = `[Script Info]
Title: Generated Video Subtitles
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Komika Title - Axis,80,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,-1,0,0,0,100,100,2,0,1,4,2,2,30,30,350,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

          let events = "";
          const phraseSize = 3;
          for (let wi = 0; wi < allWords.length; wi += phraseSize) {
            const phraseWords = allWords.slice(wi, wi + phraseSize);
            if (phraseWords.length === 0) continue;
            const phraseStart = phraseWords[0].start;
            const phraseEnd = phraseWords[phraseWords.length - 1].end + 0.1;

            const karaokeText = phraseWords.map(wt => {
              const durCs = Math.max(1, Math.round((wt.end - wt.start) * 100));
              const cleaned = wt.word.replace(/[{}\\]/g, "").trim();
              if (!cleaned) return "";
              return `{\\kf${durCs}}${cleaned}`;
            }).filter(t => t.length > 0).join(" ");

            if (karaokeText) {
              events += `Dialogue: 0,${formatAssTime(phraseStart)},${formatAssTime(phraseEnd)},Default,,0,0,0,,${karaokeText}\n`;
            }
          }

          fs.writeFileSync(assPath, assHeader + events, "utf-8");
          log(`[assemble] ASS: ${allWords.length} words, ${Math.ceil(allWords.length / phraseSize)} phrases`, "veo");

          log(`[assemble] Step 5: Final assembly (video + original audio + TTS + subtitles)`, "veo");

          const finalPath = path.join(outputDir, `final_${video.id}.mp4`);
          const escapedAssPath = assPath.replace(/\\/g, "/").replace(/:/g, "\\\\:");
          const fontDir = path.resolve("uploads/fonts").replace(/\\/g, "/");

          const hasOrigAudio = (() => {
            try {
              const probe = execSync(`ffprobe -v error -select_streams a -show_entries stream=codec_name -of csv=p=0 "${concatVideoPath}"`, { timeout: 5000 }).toString().trim();
              return probe.length > 0;
            } catch { return false; }
          })();
          const hasTts = fs.existsSync(mergedTtsPath);
          const bgmPath = req.body.bgmPath || path.join(outputDir, "bgm_track.mp3");
          const hasBgm = fs.existsSync(bgmPath);
          const bgmVolume = parseFloat(req.body.bgmVolume) || 0.30;
          log(`[assemble] Original audio: ${hasOrigAudio}, TTS: ${hasTts}, BGM: ${hasBgm} (vol=${bgmVolume})`, "veo");

          if (hasTts && hasOrigAudio) {
            const bgmInputs = hasBgm ? ` -i "${bgmPath}"` : "";
            const bgmIdx = hasBgm ? 2 : -1;
            const bgmFilter = hasBgm ? `;[${bgmIdx}:a]aresample=48000,volume=${bgmVolume},afade=t=out:st=${Math.max(0, clipDurations.reduce((a: number, b: number) => a + b, 0) - 3)}:d=3[bgm]` : "";
            const mixInputLabels = hasBgm ? "[orig][tts][bgm]" : "[orig][tts]";
            const mixCount = hasBgm ? 3 : 2;
            const mixWeights = hasBgm ? "2 8 3" : "2 8";
            try {
              execSync(
                `ffmpeg -y -i "${concatVideoPath}" -i "${mergedTtsPath}"${bgmInputs} -filter_complex "[0:a]volume=0.25[orig];[1:a]aresample=48000,volume=1.5[tts]${bgmFilter};${mixInputLabels}amix=inputs=${mixCount}:duration=first:weights=${mixWeights}:normalize=0[amixed];[amixed]alimiter=limit=0.95:attack=5:release=50[limited];[0:v]ass='${escapedAssPath}':fontsdir='${fontDir}'[subbed]" -map "[subbed]" -map "[limited]" -c:v libx264 -crf 18 -preset medium -profile:v high -level 4.2 -pix_fmt yuv420p -c:a aac -b:a 192k "${finalPath}"`,
                { timeout: 600000 }
              );
            } catch (assErr: any) {
              log(`[assemble] ASS+mix failed: ${assErr.message}, trying without subtitles`, "veo");
              try {
                execSync(
                  `ffmpeg -y -i "${concatVideoPath}" -i "${mergedTtsPath}"${bgmInputs} -filter_complex "[0:a]volume=0.25[orig];[1:a]aresample=48000,volume=1.5[tts]${bgmFilter};${mixInputLabels}amix=inputs=${mixCount}:duration=first:weights=${mixWeights}:normalize=0[amixed];[amixed]alimiter=limit=0.95:attack=5:release=50[limited]" -map 0:v -map "[limited]" -c:v libx264 -crf 18 -preset medium -profile:v high -level 4.2 -pix_fmt yuv420p -c:a aac -b:a 192k "${finalPath}"`,
                  { timeout: 300000 }
                );
              } catch {
                execSync(
                  `ffmpeg -y -i "${concatVideoPath}" -i "${mergedTtsPath}" -map 0:v -map 1:a -c:v copy -c:a aac -shortest "${finalPath}"`,
                  { timeout: 300000 }
                );
              }
            }
          } else if (hasTts) {
            const bgmInputs = hasBgm ? ` -i "${bgmPath}"` : "";
            const bgmIdx = hasBgm ? 2 : -1;
            if (hasBgm) {
              try {
                execSync(
                  `ffmpeg -y -i "${concatVideoPath}" -i "${mergedTtsPath}" -i "${bgmPath}" -filter_complex "[1:a]aresample=48000,volume=1.5[tts];[2:a]aresample=48000,volume=${bgmVolume},afade=t=out:st=${Math.max(0, clipDurations.reduce((a: number, b: number) => a + b, 0) - 3)}:d=3[bgm];[tts][bgm]amix=inputs=2:duration=first:weights=8 3:normalize=0[amixed];[amixed]alimiter=limit=0.95:attack=5:release=50[limited];[0:v]ass='${escapedAssPath}':fontsdir='${fontDir}'[subbed]" -map "[subbed]" -map "[limited]" -c:v libx264 -crf 18 -preset medium -profile:v high -level 4.2 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest "${finalPath}"`,
                  { timeout: 600000 }
                );
              } catch {
                execSync(
                  `ffmpeg -y -i "${concatVideoPath}" -i "${mergedTtsPath}" -map 0:v -map 1:a -c:v copy -c:a aac -shortest "${finalPath}"`,
                  { timeout: 300000 }
                );
              }
            } else {
              try {
                execSync(
                  `ffmpeg -y -i "${concatVideoPath}" -i "${mergedTtsPath}" -filter_complex "[0:v]ass='${escapedAssPath}':fontsdir='${fontDir}'[subbed]" -map "[subbed]" -map 1:a -c:v libx264 -crf 18 -preset medium -profile:v high -level 4.2 -pix_fmt yuv420p -c:a aac -shortest "${finalPath}"`,
                  { timeout: 600000 }
                );
              } catch {
                execSync(
                  `ffmpeg -y -i "${concatVideoPath}" -i "${mergedTtsPath}" -map 0:v -map 1:a -c:v copy -c:a aac -shortest "${finalPath}"`,
                  { timeout: 300000 }
                );
              }
            }
          } else if (hasOrigAudio) {
            try {
              execSync(
                `ffmpeg -y -i "${concatVideoPath}" -filter_complex "[0:v]ass='${escapedAssPath}':fontsdir='${fontDir}'[subbed]" -map "[subbed]" -map 0:a -c:v libx264 -crf 18 -preset medium -profile:v high -level 4.2 -pix_fmt yuv420p -c:a copy "${finalPath}"`,
                { timeout: 600000 }
              );
            } catch {
              fs.copyFileSync(concatVideoPath, finalPath);
            }
          } else {
            try {
              execSync(
                `ffmpeg -y -i "${concatVideoPath}" -filter_complex "[0:v]ass='${escapedAssPath}':fontsdir='${fontDir}'[subbed]" -map "[subbed]" -c:v libx264 -crf 18 -preset medium -profile:v high -level 4.2 -pix_fmt yuv420p -an "${finalPath}"`,
                { timeout: 600000 }
              );
            } catch {
              fs.renameSync(concatVideoPath, finalPath);
            }
          }

          try { if (fs.existsSync(concatVideoPath) && concatVideoPath !== finalPath) fs.unlinkSync(concatVideoPath); } catch {}
          for (const f of sceneTtsFiles) { try { if (f) fs.unlinkSync(f); } catch {} }

          const durationStr = getDuration(finalPath).toFixed(2);

          await storage.updateGeneratedVideo(video.id, {
            status: "completed",
            finalOutputPath: finalPath,
            finalDuration: parseFloat(durationStr) || 0,
          });

          log(`[assemble] Complete! ${finalPath} (${durationStr}s)`, "veo");
        } catch (err: any) {
          log(`[assemble] Assembly error: ${err.message}\n${err.stack}`, "veo");
          await storage.updateGeneratedVideo(video.id, { status: "error" });
        }
      })();
    } catch (err: any) {
      log(`[assemble] Error: ${err.message}`, "xai");
      const video = await storage.getGeneratedVideo(req.params.id);
      if (video) await storage.updateGeneratedVideo(video.id, { status: "error" });
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/generated-videos/:id/preview", async (req, res) => {
    try {
      const video = await storage.getGeneratedVideo(req.params.id);
      if (!video) return res.status(404).json({ message: "Not found" });

      const clips = (video.clips as GeneratedClip[]) || [];
      const completedClips = clips.filter(c => c.status === "completed" && c.localPath);
      if (completedClips.length === 0) {
        return res.status(400).json({ message: "No completed clips" });
      }

      const { execSync } = await import("child_process");
      const { textToSpeech } = await import("./replit_integrations/audio/client");

      const outputDir = path.join("uploads", "generated");
      const getDuration = (filePath: string): number => {
        try {
          return parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`, { timeout: 10000 }).toString().trim()) || 0;
        } catch { return 0; }
      };

      const maxScenes = parseInt(req.body.scenes as string) || 3;
      const voice = req.body.voice || "nova";
      const sortedClips = [...completedClips].sort((a, b) => (a.sceneIndex ?? 0) - (b.sceneIndex ?? 0)).slice(0, maxScenes);
      const scenarios = (video.scenario as SceneData[]) || [];

      log(`[preview] Building preview: ${sortedClips.length} scenes, voice: ${voice}`, "veo");

      res.json({ ok: true, status: "building preview", scenes: sortedClips.length });

      (async () => {
        try {
          const concatListPath = path.join(outputDir, `preview_list_${video.id}.txt`);
          const concatVideoPath = path.join(outputDir, `preview_concat_${video.id}.mp4`);
          const concatLines = sortedClips.map(c => `file '${path.resolve(c.localPath!)}'`).join("\n");
          fs.writeFileSync(concatListPath, concatLines);
          execSync(`ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c copy "${concatVideoPath}"`, { timeout: 60000 });
          try { fs.unlinkSync(concatListPath); } catch {}

          const clipDurations = sortedClips.map(c => getDuration(c.localPath!));
          const clipStartTimes: number[] = [];
          let cumTime = 0;
          for (const d of clipDurations) { clipStartTimes.push(cumTime); cumTime += d; }

          const ttsInputs: string[] = [];
          const adelayParts: string[] = [];
          const sceneTtsFiles: string[] = [];
          let inputIdx = 0;

          for (let i = 0; i < sortedClips.length; i++) {
            const sceneIdx = sortedClips[i].sceneIndex ?? i;
            const scene = scenarios[sceneIdx];
            const narration = scene?.narrationText || "";
            if (!narration.trim()) continue;

            const ttsBuffer = await textToSpeech(narration, voice, "mp3");
            const ttsTempPath = path.join(outputDir, `preview_tts_${video.id}_${i}.mp3`);
            fs.writeFileSync(ttsTempPath, ttsBuffer);
            sceneTtsFiles.push(ttsTempPath);

            ttsInputs.push(`-i "${ttsTempPath}"`);
            const delayMs = Math.round(clipStartTimes[i] * 1000);
            adelayParts.push(`[${inputIdx}:a]adelay=${delayMs}|${delayMs}[a${inputIdx}]`);
            inputIdx++;
          }

          const previewPath = path.join(outputDir, `preview_${video.id}.mp4`);
          const hasOrigAudio = (() => {
            try {
              return execSync(`ffprobe -v error -select_streams a -show_entries stream=codec_name -of csv=p=0 "${concatVideoPath}"`, { timeout: 5000 }).toString().trim().length > 0;
            } catch { return false; }
          })();

          if (ttsInputs.length > 0) {
            const mergedPreviewTts = path.join(outputDir, `preview_tts_merged_${video.id}.m4a`);
            if (ttsInputs.length === 1 && clipStartTimes[0] === 0) {
              fs.copyFileSync(sceneTtsFiles[0], mergedPreviewTts);
            } else {
              const mixInputs = Array.from({ length: inputIdx }, (_, i) => `[a${i}]`).join("");
              const previewWeights = Array.from({ length: inputIdx }, () => "1").join(" ");
              const filterComplex = `${adelayParts.join(";")};${mixInputs}amix=inputs=${inputIdx}:duration=longest:dropout_transition=0:weights=${previewWeights}:normalize=0[outa]`;
              execSync(`ffmpeg -y ${ttsInputs.join(" ")} -filter_complex "${filterComplex}" -map "[outa]" -c:a aac -b:a 128k "${mergedPreviewTts}"`, { timeout: 60000 });
            }

            if (hasOrigAudio) {
              execSync(
                `ffmpeg -y -i "${concatVideoPath}" -i "${mergedPreviewTts}" -filter_complex "[0:a]volume=0.08[orig];[1:a]aresample=48000,volume=1.5[tts];[orig][tts]amix=inputs=2:duration=first:weights=1 8:normalize=0[amixed]" -map 0:v -map "[amixed]" -c:v copy -c:a aac -b:a 128k "${previewPath}"`,
                { timeout: 60000 }
              );
            } else {
              execSync(`ffmpeg -y -i "${concatVideoPath}" -i "${mergedPreviewTts}" -map 0:v -map 1:a -c:v copy -c:a aac -shortest "${previewPath}"`, { timeout: 60000 });
            }
            try { fs.unlinkSync(mergedPreviewTts); } catch {}
          } else if (hasOrigAudio) {
            fs.copyFileSync(concatVideoPath, previewPath);
          } else {
            fs.copyFileSync(concatVideoPath, previewPath);
          }

          try { fs.unlinkSync(concatVideoPath); } catch {}
          for (const f of sceneTtsFiles) { try { fs.unlinkSync(f); } catch {} }

          const dur = getDuration(previewPath);
          log(`[preview] Done! ${previewPath} (${dur.toFixed(1)}s, ${sortedClips.length} scenes)`, "veo");
        } catch (err: any) {
          log(`[preview] Error: ${err.message}\n${err.stack}`, "veo");
        }
      })();
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/generated-videos/:id/preview", (req, res) => {
    const previewPath = path.join("uploads", "generated", `preview_${req.params.id}.mp4`);
    if (fs.existsSync(previewPath)) {
      res.sendFile(path.resolve(previewPath));
    } else {
      res.status(404).json({ message: "Preview not ready yet" });
    }
  });

  app.post("/api/generated-videos/:id/concatenate", async (req, res) => {
    try {
      const video = await storage.getGeneratedVideo(req.params.id);
      if (!video) return res.status(404).json({ message: "Not found" });

      const clips = (video.clips as GeneratedClip[]) || [];
      const completedClips = clips.filter(c => c.status === "completed" && c.localPath);
      if (completedClips.length === 0) {
        return res.status(400).json({ message: "Нет готовых клипов для объединения" });
      }

      await storage.updateGeneratedVideo(video.id, { status: "processing" });

      const outputDir = path.join("uploads", "generated");
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      const outputPath = path.join(outputDir, `final_${video.id}.mp4`);

      if (completedClips.length === 1) {
        fs.copyFileSync(completedClips[0].localPath!, outputPath);
      } else {
        const listFile = path.join(outputDir, `concat_${video.id}.txt`);
        const listContent = completedClips.map(c => `file '${path.resolve(c.localPath!)}'`).join("\n");
        fs.writeFileSync(listFile, listContent);

        const { execSync } = await import("child_process");
        execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${outputPath}"`, { timeout: 120000 });
        fs.unlinkSync(listFile);
      }

      const { execSync } = await import("child_process");
      const durationStr = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputPath}"`).toString().trim();

      await storage.updateGeneratedVideo(video.id, {
        status: "completed",
        finalOutputPath: outputPath,
        finalDuration: parseFloat(durationStr) || 0,
      });

      res.json({ ok: true, outputPath, duration: parseFloat(durationStr) });
    } catch (err: any) {
      const video = await storage.getGeneratedVideo(req.params.id);
      if (video) {
        await storage.updateGeneratedVideo(video.id, { status: "error" });
      }
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/generated-videos/:id/publish/:platform", async (req, res) => {
    try {
      const video = await storage.getGeneratedVideo(req.params.id);
      if (!video) return res.status(404).json({ message: "Not found" });
      if (!video.finalOutputPath || !fs.existsSync(video.finalOutputPath)) {
        return res.status(400).json({ message: "Видео не готово. Сначала объедините клипы." });
      }

      const platform = req.params.platform;
      const { title, description } = req.body;
      const safeTitle = title || video.title || "Generated Video";
      const safeDesc = description || "";

      let creds = { apiKey: process.env.UPLOAD_POST_API_KEY || null, user: null as string | null };
      if (video.profileId) {
        const profile = await storage.getProfile(video.profileId);
        if (profile?.uploadPostApiKey && profile?.uploadPostUser) {
          creds = {
            apiKey: profile.uploadPostApiKey === "GLOBAL" ? (process.env.UPLOAD_POST_API_KEY || null) : profile.uploadPostApiKey,
            user: profile.uploadPostUser,
          };
        }
      }

      const uploadPostPlatforms = ["instagram", "tiktok", "facebook", "threads", "youtube"];
      if (uploadPostPlatforms.includes(platform) && creds.apiKey && creds.user) {
        const upRes = await uploadToUploadPostForStreamer(video.finalOutputPath, platform, safeTitle, creds.apiKey, creds.user, {
          description: safeDesc,
        });
        const current = (video.publishedTo as string[]) || [];
        if (!current.includes(platform)) {
          await storage.updateGeneratedVideo(video.id, { publishedTo: [...current, platform] });
        }
        return res.json({ ok: true, ...upRes });
      }

      if (platform === "vk" && isPostmypostConfigured()) {
        const result = await uploadToVkViaPostmypost(video.finalOutputPath, safeTitle, safeDesc);
        const current = (video.publishedTo as string[]) || [];
        if (!current.includes("vk")) {
          await storage.updateGeneratedVideo(video.id, { publishedTo: [...current, "vk"] });
        }
        return res.json({ ok: true, method: "postmypost", videoId: String(result.publicationId), message: result.message });
      }

      return res.status(400).json({ message: `Платформа ${platform} не настроена` });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/exports/:exportId/unpublish/:platform", async (req, res) => {
    try {
      const { exportId, platform } = req.params;
      const exportJob = await storage.getExportJob(exportId);
      if (!exportJob) return res.status(404).json({ message: "Export not found" });

      const current = (exportJob.publishedTo as string[]) || [];
      if (!current.includes(platform)) {
        return res.json({ message: `${platform} not in publishedTo`, publishedTo: current });
      }

      const newPublishedTo = current.filter(p => p !== platform);
      const currentUrls = (exportJob.publishedUrls as Record<string, string>) || {};
      const newUrls = { ...currentUrls };
      delete newUrls[platform];
      delete newUrls[`${platform}_requestId`];

      await storage.updateExportJob(exportId, {
        publishedTo: newPublishedTo,
        publishedUrls: newUrls,
      });

      res.json({ message: `Removed ${platform} from publishedTo`, publishedTo: newPublishedTo });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  return httpServer;
}
