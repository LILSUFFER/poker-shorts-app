import fs from "fs";
import path from "path";
import { log } from "./index";

const POSTMYPOST_API_URL = "https://api.postmypost.io/v4";
const DEFAULT_PROJECT_ID = 336392;

const CHANEL_IDS: Record<string, number> = {
  instagram: 1,
  vk: 2,
  facebook: 3,
  tiktok: 9,
  youtube: 16,
};

const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram Reels",
  vk: "VK Clips",
  facebook: "Facebook Reels",
  tiktok: "TikTok",
  youtube: "YouTube Shorts",
};

function getToken(): string {
  const token = process.env.POSTMYPOST_API_TOKEN;
  if (!token) throw new Error("POSTMYPOST_API_TOKEN не настроен");
  return token;
}

export function isPostmypostConfigured(): boolean {
  return !!process.env.POSTMYPOST_API_TOKEN;
}

export interface PostmypostAccountInfo {
  connected: boolean;
  accountName?: string;
  accountId?: number;
}

export interface PostmypostPlatformStatuses {
  vk: PostmypostAccountInfo;
  youtube: PostmypostAccountInfo;
  tiktok: PostmypostAccountInfo;
  instagram: PostmypostAccountInfo;
  facebook: PostmypostAccountInfo;
}

const statusesCache = new Map<number, { statuses: PostmypostPlatformStatuses; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

const uploadFileCache = new Map<string, { fileId: number; timestamp: number; promise?: Promise<number> }>();
const UPLOAD_CACHE_TTL_MS = 10 * 60 * 1000;

async function getOrUploadFile(pid: number, filePath: string): Promise<number> {
  const cacheKey = `${pid}:${filePath}`;
  const now = Date.now();
  const cached = uploadFileCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < UPLOAD_CACHE_TTL_MS) {
    if (cached.fileId) {
      log(`[postmypost] Reusing cached fileId=${cached.fileId} for ${path.basename(filePath)}`, "social");
      return cached.fileId;
    }
    if (cached.promise) {
      log(`[postmypost] Waiting for in-progress upload of ${path.basename(filePath)}`, "social");
      return cached.promise;
    }
  }

  const doUpload = async (): Promise<number> => {
    const fileName = path.basename(filePath);
    const fileSize = fs.statSync(filePath).size;
    const { uploadId, action, fields } = await initUpload(pid, fileName, fileSize);
    await uploadToS3(filePath, action, fields);
    await completeUpload(uploadId);
    const fileId = await pollUploadStatus(uploadId);
    uploadFileCache.set(cacheKey, { fileId, timestamp: Date.now() });
    return fileId;
  };

  const promise = doUpload();
  uploadFileCache.set(cacheKey, { fileId: 0, timestamp: now, promise });

  try {
    return await promise;
  } catch (err) {
    uploadFileCache.delete(cacheKey);
    throw err;
  }
}

export async function getPostmypostStatuses(projectId?: number): Promise<PostmypostPlatformStatuses> {
  const pid = projectId || DEFAULT_PROJECT_ID;
  const now = Date.now();
  const cached = statusesCache.get(pid);
  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    return cached.statuses;
  }

  const result: PostmypostPlatformStatuses = {
    vk: { connected: false },
    youtube: { connected: false },
    tiktok: { connected: false },
    instagram: { connected: false },
    facebook: { connected: false },
  };

  if (!isPostmypostConfigured()) return result;

  try {
    const token = getToken();
    const resp = await fetch(`${POSTMYPOST_API_URL}/accounts?project_id=${pid}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });

    if (!resp.ok) {
      log(`[postmypost] Failed to fetch accounts: HTTP ${resp.status}`, "social");
      return result;
    }

    const accounts: any[] = await resp.json();

    for (const [platform, chanelId] of Object.entries(CHANEL_IDS)) {
      const account = accounts.find((a: any) => a.chanel_id === chanelId && a.connection_status === 1);
      if (account) {
        (result as any)[platform] = {
          connected: true,
          accountName: account.name || account.login || platform,
          accountId: account.id,
        };
      }
    }

    const connected = Object.entries(result)
      .filter(([, v]) => v.connected)
      .map(([k, v]) => `${k}(${v.accountId})`)
      .join(", ");
    log(`[postmypost] Project ${pid} accounts: ${connected || "none"}`, "social");
  } catch (err: any) {
    log(`[postmypost] Error fetching accounts: ${err.message}`, "social");
  }

  statusesCache.set(pid, { statuses: result, timestamp: now });
  return result;
}

export function clearPostmypostCache(): void {
  statusesCache.clear();
}

export async function getPostmypostVkStatus(): Promise<PostmypostAccountInfo> {
  const statuses = await getPostmypostStatuses();
  return statuses.vk;
}

async function initUpload(projectId: number, fileName: string, fileSize: number): Promise<{
  uploadId: number;
  action: string;
  fields: Record<string, string>;
}> {
  const token = getToken();
  const params = new URLSearchParams({
    project_id: String(projectId),
    name: fileName,
    size: String(fileSize),
  });

  const resp = await fetch(`${POSTMYPOST_API_URL}/upload/init?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Postmypost init upload failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  log(`[postmypost] Upload initialized: id=${data.id}, action=${data.action}`, "social");

  return { uploadId: data.id, action: data.action, fields: data.fields || {} };
}

async function uploadToS3(filePath: string, action: string, fields: Record<string, string>): Promise<void> {
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value);
  }
  formData.append("file", new Blob([fileBuffer], { type: "video/mp4" }), fileName);

  const resp = await fetch(action, { method: "POST", body: formData });

  if (!resp.ok && resp.status !== 204) {
    const text = await resp.text();
    throw new Error(`S3 upload failed (${resp.status}): ${text.substring(0, 300)}`);
  }

  log(`[postmypost] File uploaded to S3 successfully`, "social");
}

async function completeUpload(uploadId: number): Promise<void> {
  const token = getToken();
  const resp = await fetch(`${POSTMYPOST_API_URL}/upload/complete?id=${uploadId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Postmypost complete upload failed (${resp.status}): ${text}`);
  }

  log(`[postmypost] Upload ${uploadId} marked as complete`, "social");
}

async function pollUploadStatus(uploadId: number, maxAttempts = 30): Promise<number> {
  const token = getToken();

  for (let i = 0; i < maxAttempts; i++) {
    const resp = await fetch(`${POSTMYPOST_API_URL}/upload/status?id=${uploadId}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });

    if (!resp.ok) {
      throw new Error(`Postmypost upload status check failed: ${resp.status}`);
    }

    const data = await resp.json();
    log(`[postmypost] Upload ${uploadId} status: ${data.status}, file_id: ${data.file_id || "N/A"}`, "social");

    if (data.status === 1 && data.file_id) {
      return data.file_id;
    }

    if (data.status === 2) {
      throw new Error("Postmypost: ошибка обработки файла");
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  throw new Error("Postmypost: таймаут ожидания обработки файла");
}

function getPublicationType(platform: string): number {
  if (platform === "vk") return 4;
  if (platform === "youtube") return 4;
  if (platform === "tiktok") return 4;
  if (platform === "instagram") return 4;
  if (platform === "facebook") return 4;
  return 4;
}

async function createPublication(
  projectId: number,
  fileId: number,
  accountId: number,
  platform: string,
  title: string,
  description: string,
): Promise<{ publicationId: number; status: number }> {
  const token = getToken();

  const postAt = new Date(Date.now() + 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

  const detailItem: Record<string, any> = {
    account_id: accountId,
    publication_type: getPublicationType(platform),
    content: description || title,
    title: title,
    file_ids: [fileId],
  };

  if (platform === "tiktok") {
    detailItem.disable_comment = false;
    detailItem.duet_disabled = false;
    detailItem.stitch_disabled = false;
  }

  const body = {
    project_id: projectId,
    post_at: postAt,
    account_ids: [accountId],
    publication_status: 5,
    details: [detailItem],
  };

  log(`[postmypost] Creating publication for ${platform}: ${JSON.stringify(body)}`, "social");

  const resp = await fetch(`${POSTMYPOST_API_URL}/publications`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Postmypost create publication: некорректный ответ: ${text.substring(0, 300)}`);
  }

  if (!resp.ok) {
    const errMsg = data.message || data.name || `HTTP ${resp.status}`;
    throw new Error(`Postmypost create publication error: ${errMsg}`);
  }

  log(`[postmypost] Publication created for ${platform}: id=${data.id}, status=${data.publication_status}`, "social");

  return { publicationId: data.id, status: data.publication_status };
}

const PUBLICATION_STATUS_LABELS: Record<number, string> = {
  0: "Удалена",
  1: "Опубликовано",
  2: "Публикуется...",
  3: "Ошибка публикации",
  4: "Черновик",
  5: "Ожидает публикации",
  6: "Не удалена из-за ошибки",
};

export interface PostmypostPublicationStatus {
  publicationId: number;
  status: number;
  statusLabel: string;
  published: boolean;
  error: boolean;
  pending: boolean;
  postAt?: string;
}

export async function getPublicationStatus(publicationId: number): Promise<PostmypostPublicationStatus> {
  const token = getToken();

  const resp = await fetch(`${POSTMYPOST_API_URL}/publications/${publicationId}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Postmypost get publication failed (${resp.status}): ${text.substring(0, 300)}`);
  }

  const data = await resp.json();
  const st = data.publication_status as number;

  return {
    publicationId: data.id,
    status: st,
    statusLabel: PUBLICATION_STATUS_LABELS[st] || `Неизвестный статус (${st})`,
    published: st === 1,
    error: st === 3,
    pending: st === 2 || st === 5,
    postAt: data.post_at,
  };
}

export interface PostmypostUploadResult {
  success: boolean;
  publicationId: number;
  platform: string;
  message: string;
}

export async function uploadViaPostmypost(
  filePath: string,
  platform: string,
  title: string,
  description: string,
  projectId?: number,
): Promise<PostmypostUploadResult> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Файл не найден: ${filePath}`);
  }

  const pid = projectId || DEFAULT_PROJECT_ID;
  const fileSize = fs.statSync(filePath).size;
  const fileName = path.basename(filePath);
  const label = PLATFORM_LABELS[platform] || platform;

  log(`[postmypost] Starting ${label} upload: ${fileName} (${(fileSize / 1024 / 1024).toFixed(1)}MB), project=${pid}`, "social");

  try {
    const fileId = await getOrUploadFile(pid, filePath);

    const statuses = await getPostmypostStatuses(pid);
    const platformStatus = (statuses as any)[platform] as PostmypostAccountInfo;
    if (!platformStatus?.connected || !platformStatus?.accountId) {
      const connectedList = Object.entries(statuses)
        .filter(([, v]) => (v as PostmypostAccountInfo).connected)
        .map(([k]) => k)
        .join(", ");
      throw new Error(`Postmypost: аккаунт ${label} не подключён в проекте ${pid}. Подключены: ${connectedList || "никакие"}`);
    }

    const result = await createPublication(pid, fileId, platformStatus.accountId, platform, title, description);

    log(`[postmypost] ${label} upload SUCCESS: publicationId=${result.publicationId}`, "social");
    return {
      success: true,
      publicationId: result.publicationId,
      platform,
      message: `Видео отправлено на публикацию в ${label} (ID: ${result.publicationId})`,
    };
  } catch (err: any) {
    log(`[postmypost] ${label} upload FAILED: ${err.message}`, "social");
    throw err;
  }
}

export async function uploadToVkViaPostmypost(
  filePath: string,
  title: string,
  description: string,
): Promise<{ success: boolean; publicationId: number; message: string }> {
  const result = await uploadViaPostmypost(filePath, "vk", title, description);
  return { success: result.success, publicationId: result.publicationId, message: result.message };
}
