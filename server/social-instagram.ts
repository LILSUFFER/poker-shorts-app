import { isUploadPostConfigured, uploadToUploadPost, getConnectedPlatforms } from "./upload-post";

export function getInstagramAuthUrl(_origin: string): { url: string; redirectUri: string } {
  throw new Error("Instagram подключается через Upload-Post. OAuth не требуется.");
}

export async function handleInstagramCallback(_code: string, _state: string): Promise<{ accountName: string }> {
  throw new Error("Instagram подключается через Upload-Post. OAuth не требуется.");
}

export async function getInstagramStatus(): Promise<{ connected: boolean; accountName?: string | null; via?: string }> {
  if (!isUploadPostConfigured()) {
    return { connected: false };
  }
  try {
    const platforms = await getConnectedPlatforms();
    if (platforms.instagram) {
      return { connected: true, accountName: platforms.accountNames.instagram || "Upload-Post", via: "upload-post" };
    }
  } catch {}
  return { connected: false };
}

export async function disconnectInstagram(): Promise<void> {
}

export async function uploadToInstagram(
  filePath: string,
  caption: string,
  clipDurationSec?: number,
  contentType?: string,
): Promise<{ mediaId: string; url: string }> {
  if (!isUploadPostConfigured()) {
    throw new Error("Upload-Post API не настроен. Добавьте UPLOAD_POST_API_KEY в секреты.");
  }

  const igTags = contentType === "streamer" ? "" : "\n\n#покер #покерок #покерок_shorts @pokerok_official";
  const baseCaption = caption || "Poker Short #shorts #poker";
  const safeCaption = (baseCaption + igTags).substring(0, 2200);

  const thumbOffsetMs = clipDurationSec ? Math.round((clipDurationSec / 2) * 1000) : undefined;

  const result = await uploadToUploadPost(filePath, "instagram", safeCaption, {
    instagramShareMode: "CUSTOM",
    thumbOffsetMs,
  });

  return {
    mediaId: result.requestId || "pending",
    url: "https://www.instagram.com/",
  };
}
