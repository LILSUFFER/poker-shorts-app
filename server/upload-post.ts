import fs from "fs";
import path from "path";
import { log } from "./index";

const UPLOAD_POST_API_URL = "https://api.upload-post.com";
const UPLOAD_POST_USER = "whoisfirst";

function getApiKey(): string {
  const key = process.env.UPLOAD_POST_API_KEY;
  if (!key) throw new Error("UPLOAD_POST_API_KEY не настроен");
  return key;
}

export function isUploadPostConfigured(): boolean {
  return !!process.env.UPLOAD_POST_API_KEY;
}

export interface UploadPostConnectedPlatforms {
  instagram: boolean;
  tiktok: boolean;
  facebook: boolean;
  threads: boolean;
  youtube: boolean;
  accountNames: Record<string, string | null>;
  platformUsers: Record<string, string>;
}

let cachedPlatforms: UploadPostConnectedPlatforms | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function getConnectedPlatforms(): Promise<UploadPostConnectedPlatforms> {
  const now = Date.now();
  if (cachedPlatforms && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedPlatforms;
  }

  const apiKey = getApiKey();

  const result: UploadPostConnectedPlatforms = {
    instagram: false,
    tiktok: false,
    facebook: false,
    threads: false,
    youtube: false,
    accountNames: {},
    platformUsers: {},
  };

  try {
    const resp = await fetch(`${UPLOAD_POST_API_URL}/api/uploadposts/users`, {
      headers: {
        "Authorization": `Apikey ${apiKey}`,
      },
    });

    if (!resp.ok) {
      log(`[upload-post] Failed to fetch connected platforms: HTTP ${resp.status}`, "social");
      return result;
    }

    const data = await resp.json();
    const profiles = data?.profiles || (data?.profile ? [data.profile] : []);

    for (const profile of profiles) {
      const username = profile.username || UPLOAD_POST_USER;
      const socialAccounts = profile?.social_accounts;
      if (!socialAccounts) continue;

      for (const platform of ["instagram", "tiktok", "facebook", "threads", "youtube"] as const) {
        if (result[platform]) continue;
        const account = socialAccounts[platform];
        if (account && typeof account === "object" && account !== null) {
          result[platform] = true;
          result.accountNames[platform] = account.display_name || account.handle || platform;
          result.platformUsers[platform] = username;
        }
      }
    }

    log(`[upload-post] Connected platforms: ${Object.entries(result).filter(([k, v]) => v === true && k !== "accountNames" && k !== "platformUsers").map(([k]) => `${k}(${result.platformUsers[k]})`).join(", ") || "none"}`, "social");
  } catch (err: any) {
    log(`[upload-post] Error fetching connected platforms: ${err.message}`, "social");
  }

  cachedPlatforms = result;
  cacheTimestamp = now;
  return result;
}

export function clearPlatformCache(): void {
  cachedPlatforms = null;
  cacheTimestamp = 0;
  streamerPlatformCache.clear();
}

const streamerPlatformCache = new Map<string, { data: UploadPostConnectedPlatforms; ts: number }>();

export async function getConnectedPlatformsForStreamer(apiKey: string, user: string): Promise<UploadPostConnectedPlatforms> {
  const cacheKey = `${apiKey}:${user}`;
  const now = Date.now();
  const cached = streamerPlatformCache.get(cacheKey);
  if (cached && (now - cached.ts) < CACHE_TTL_MS) {
    return cached.data;
  }

  const result: UploadPostConnectedPlatforms = {
    instagram: false,
    tiktok: false,
    facebook: false,
    threads: false,
    youtube: false,
    accountNames: {},
    platformUsers: {},
  };

  try {
    const resp = await fetch(`${UPLOAD_POST_API_URL}/api/uploadposts/users`, {
      headers: { "Authorization": `Apikey ${apiKey}` },
    });

    if (!resp.ok) {
      log(`[upload-post] Failed to fetch platforms for ${user}: HTTP ${resp.status}`, "social");
      return result;
    }

    const data = await resp.json();
    const profile = data?.profiles?.find((p: any) => p.username === user) || data?.profiles?.[0] || data?.profile;
    const socialAccounts = profile?.social_accounts;

    if (socialAccounts) {
      for (const platform of ["instagram", "tiktok", "facebook", "threads", "youtube"] as const) {
        const account = socialAccounts[platform];
        if (account && typeof account === "object" && account !== null) {
          result[platform] = true;
          result.accountNames[platform] = account.display_name || account.handle || platform;
          result.platformUsers[platform] = user;
        } else {
          result[platform] = false;
          result.accountNames[platform] = null;
        }
      }
    }

    log(`[upload-post] Streamer ${user} platforms: ${Object.entries(result).filter(([k, v]) => v === true && k !== "accountNames" && k !== "platformUsers").map(([k]) => k).join(", ") || "none"}`, "social");
  } catch (err: any) {
    log(`[upload-post] Error fetching platforms for ${user}: ${err.message}`, "social");
  }

  streamerPlatformCache.set(cacheKey, { data: result, ts: now });
  return result;
}

export interface UploadPostResult {
  success: boolean;
  requestId?: string;
  jobId?: string;
  platform: string;
  message?: string;
  error?: string;
}

export interface UploadPostStatusResult {
  requestId?: string;
  jobId?: string;
  status: "pending" | "in_progress" | "completed";
  completed: number;
  total: number;
  results: Array<{
    platform: string;
    success: boolean;
    message: string;
    upload_timestamp?: string;
  }>;
  lastUpdate?: string;
}

export type UploadPostPlatform = "instagram" | "tiktok" | "facebook" | "threads" | "youtube";

export async function uploadToUploadPostForStreamer(
  filePath: string,
  platform: UploadPostPlatform,
  title: string,
  streamerApiKey: string,
  streamerUser: string,
  options?: {
    description?: string;
    instagramShareMode?: string;
    thumbOffsetMs?: number;
    tiktokPrivacyLevel?: string;
    tiktokPostMode?: string;
    facebookPageId?: string;
    youtubePrivacy?: string;
  }
): Promise<UploadPostResult> {
  return _doUpload(filePath, platform, title, streamerApiKey, streamerUser, options);
}

export async function uploadToUploadPost(
  filePath: string,
  platform: UploadPostPlatform,
  title: string,
  options?: {
    description?: string;
    instagramShareMode?: string;
    thumbOffsetMs?: number;
    tiktokPrivacyLevel?: string;
    tiktokPostMode?: string;
    facebookPageId?: string;
    youtubePrivacy?: string;
  }
): Promise<UploadPostResult> {
  const apiKey = getApiKey();
  const platforms = await getConnectedPlatforms();
  const user = platforms.platformUsers[platform] || UPLOAD_POST_USER;
  return _doUpload(filePath, platform, title, apiKey, user, options);
}

async function _doUpload(
  filePath: string,
  platform: UploadPostPlatform,
  title: string,
  apiKey: string,
  user: string,
  options?: {
    description?: string;
    instagramShareMode?: string;
    thumbOffsetMs?: number;
    tiktokPrivacyLevel?: string;
    tiktokPostMode?: string;
    facebookPageId?: string;
    youtubePrivacy?: string;
  }
): Promise<UploadPostResult> {

  if (!fs.existsSync(filePath)) {
    throw new Error(`Файл не найден: ${filePath}`);
  }

  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  const formData = new FormData();
  formData.append("user", user);
  formData.append("profile_username", user);
  formData.append("platform[]", platform);
  formData.append("video", new Blob([fileBuffer], { type: "video/mp4" }), fileName);
  formData.append("title", title);
  formData.append("async_upload", "true");

  if (platform === "instagram") {
    formData.append("media_type", "REELS");
    formData.append("share_to_feed", "true");
    if (title) {
      formData.append("instagram_title", title);
    }
    if (options?.thumbOffsetMs) {
      formData.append("thumb_offset", String(options.thumbOffsetMs));
    }
    if (options?.instagramShareMode) {
      formData.append("share_mode", options.instagramShareMode);
    }
  }

  if (platform === "tiktok") {
    formData.append("privacy_level", options?.tiktokPrivacyLevel || "PUBLIC_TO_EVERYONE");
    formData.append("post_mode", options?.tiktokPostMode || "DIRECT_POST");
    if (options?.description) {
      formData.append("tiktok_title", options.description);
    }
    if (options?.thumbOffsetMs) {
      formData.append("thumb_offset", String(options.thumbOffsetMs));
    }
    if (options?.tiktokPostMode === "MEDIA_UPLOAD") {
      formData.append("is_aigc", "false");
    }
  }

  if (platform === "facebook") {
    formData.append("media_type", "REELS");
    if (options?.description) {
      formData.append("description", options.description);
    }
    if (options?.thumbOffsetMs) {
      formData.append("thumb_offset", String(options.thumbOffsetMs));
    }
  }

  if (platform === "threads") {
    formData.append("media_type", "VIDEO");
    if (options?.thumbOffsetMs) {
      formData.append("thumb_offset", String(options.thumbOffsetMs));
    }
  }

  if (platform === "youtube") {
    formData.append("privacy_status", options?.youtubePrivacy || "public");
    formData.append("made_for_kids", "false");
    if (options?.description) {
      formData.append("description", options.description);
    }
    if (options?.thumbOffsetMs) {
      formData.append("thumb_offset", String(options.thumbOffsetMs));
    }
  }

  log(`[upload-post] Uploading to ${platform} (user=${user}): ${fileName} (${(fileBuffer.length / 1024 / 1024).toFixed(1)}MB), title="${title.substring(0, 80)}"`, "social");

  const controller = new AbortController();
  const uploadTimeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);
  let resp: Response;
  try {
    resp = await fetch(`${UPLOAD_POST_API_URL}/api/upload`, {
      method: "POST",
      headers: {
        "Authorization": `Apikey ${apiKey}`,
      },
      body: formData,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(uploadTimeout);
  }

  let data: any;
  const rawText = await resp.text();
  try {
    data = JSON.parse(rawText);
  } catch {
    log(`[upload-post] Non-JSON response from ${platform}: ${rawText.substring(0, 500)}`, "social");
    throw new Error(`Upload-Post вернул некорректный ответ (${platform}): ${rawText.substring(0, 200)}`);
  }

  if (!resp.ok) {
    const errorMsg = data.error || data.message || `HTTP ${resp.status}`;
    log(`[upload-post] Error uploading to ${platform}: ${errorMsg} | Full response: ${JSON.stringify(data).substring(0, 500)}`, "social");
    throw new Error(`Upload-Post ошибка (${platform}): ${errorMsg}`);
  }

  log(`[upload-post] Upload initiated for ${platform}, request_id: ${data.request_id || "N/A"}, response: ${JSON.stringify(data).substring(0, 300)}`, "social");

  return {
    success: true,
    requestId: data.request_id,
    jobId: data.job_id,
    platform,
    message: data.message || "Загрузка начата",
  };
}

export interface UploadPostHistoryItem {
  platform: string;
  success: boolean;
  post_url: string | null;
  platform_post_id: string | null;
  request_id: string | null;
  upload_timestamp: string;
}

export async function getUploadPostHistory(page: number = 1, limit: number = 20): Promise<{ history: UploadPostHistoryItem[]; total: number }> {
  const apiKey = getApiKey();
  const resp = await fetch(`${UPLOAD_POST_API_URL}/api/uploadposts/history?page=${page}&limit=${limit}`, {
    headers: { "Authorization": `Apikey ${apiKey}` },
  });
  if (!resp.ok) {
    throw new Error(`Upload-Post history error: HTTP ${resp.status}`);
  }
  const data = await resp.json();
  return {
    history: data.history || [],
    total: data.total || 0,
  };
}

export async function findPostUrlByRequestId(requestId: string, platform: string): Promise<string | null> {
  try {
    const { history } = await getUploadPostHistory(1, 50);
    const match = history.find((h: any) =>
      h.request_id === requestId && h.platform === platform && h.success && h.post_url
    );
    return match?.post_url || null;
  } catch (err: any) {
    return null;
  }
}

export async function getUploadPostStatus(requestId?: string, jobId?: string): Promise<UploadPostStatusResult> {
  const apiKey = getApiKey();

  if (!requestId && !jobId) {
    throw new Error("request_id или job_id обязателен");
  }

  const params = new URLSearchParams();
  if (requestId) params.set("request_id", requestId);
  if (jobId) params.set("job_id", jobId);

  const resp = await fetch(`${UPLOAD_POST_API_URL}/api/uploadposts/status?${params.toString()}`, {
    headers: {
      "Authorization": `Apikey ${apiKey}`,
    },
  });

  const data = await resp.json();

  if (!resp.ok) {
    throw new Error(`Upload-Post status error: ${data.error || resp.status}`);
  }

  return {
    requestId: data.request_id,
    jobId: data.job_id,
    status: data.status,
    completed: data.completed || 0,
    total: data.total || 0,
    results: data.results || [],
    lastUpdate: data.last_update,
  };
}
