import { isUploadPostConfigured, uploadToUploadPost, getConnectedPlatforms } from "./upload-post";

export function getTikTokAuthUrl(_origin: string): { url: string; redirectUri: string } {
  throw new Error("TikTok подключается через Upload-Post. OAuth не требуется.");
}

export async function handleTikTokCallback(_code: string, _state: string): Promise<{ accountName: string }> {
  throw new Error("TikTok подключается через Upload-Post. OAuth не требуется.");
}

export async function getTikTokStatus(): Promise<{ connected: boolean; accountName?: string | null; via?: string }> {
  if (!isUploadPostConfigured()) {
    return { connected: false };
  }
  try {
    const platforms = await getConnectedPlatforms();
    if (platforms.tiktok) {
      return { connected: true, accountName: platforms.accountNames.tiktok || "Upload-Post", via: "upload-post" };
    }
  } catch {}
  return { connected: false };
}

export async function disconnectTikTok(): Promise<void> {
}

export async function uploadToTikTok(
  filePath: string,
  title: string,
  _description: string,
  clipDurationSec?: number,
): Promise<{ publishId: string; url: string }> {
  if (!isUploadPostConfigured()) {
    throw new Error("Upload-Post API не настроен. Добавьте UPLOAD_POST_API_KEY в секреты.");
  }

  const safeTitle = (title || "Poker Short").substring(0, 150);
  const thumbOffsetMs = clipDurationSec ? Math.round((clipDurationSec / 2) * 1000) : undefined;

  const result = await uploadToUploadPost(filePath, "tiktok", safeTitle, {
    description: safeTitle,
    tiktokPrivacyLevel: "PUBLIC_TO_EVERYONE",
    tiktokPostMode: "DIRECT_POST",
    thumbOffsetMs,
  });

  return {
    publishId: result.requestId || "pending",
    url: "https://www.tiktok.com/",
  };
}
