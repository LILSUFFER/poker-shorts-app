import { isUploadPostConfigured, uploadToUploadPost, getConnectedPlatforms } from "./upload-post";

export async function getThreadsStatus(): Promise<{ connected: boolean; accountName?: string | null; via?: string }> {
  if (!isUploadPostConfigured()) {
    return { connected: false };
  }
  try {
    const platforms = await getConnectedPlatforms();
    if (platforms.threads) {
      return { connected: true, accountName: platforms.accountNames.threads || "Upload-Post", via: "upload-post" };
    }
  } catch {}
  return { connected: false };
}

export async function uploadToThreads(
  filePath: string,
  title: string,
  clipDurationSec?: number,
): Promise<{ publishId: string; url: string }> {
  if (!isUploadPostConfigured()) {
    throw new Error("Upload-Post API не настроен. Добавьте UPLOAD_POST_API_KEY в секреты.");
  }

  const safeTitle = (title || "Poker Short").substring(0, 500);

  const thumbOffsetMs = clipDurationSec ? Math.round((clipDurationSec / 2) * 1000) : undefined;

  const result = await uploadToUploadPost(filePath, "threads", safeTitle, {
    description: safeTitle,
    thumbOffsetMs,
  });

  return {
    publishId: result.requestId || "pending",
    url: "https://www.threads.net/",
  };
}
