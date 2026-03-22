import { google } from "googleapis";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { db } from "./db";
import { youtubeTokens } from "@shared/schema";
import { eq } from "drizzle-orm";

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
];

let pendingOAuthState: string | null = null;
let pendingRedirectUri: string | null = null;

function createOAuth2Client(redirectUri: string) {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET must be set");
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function getAuthUrl(origin: string): { url: string; redirectUri: string } {
  const redirectUri = `${origin}/api/youtube/callback`;
  const oauth2Client = createOAuth2Client(redirectUri);
  pendingOAuthState = crypto.randomBytes(16).toString("hex");
  pendingRedirectUri = redirectUri;
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    state: pendingOAuthState,
  });
  return { url, redirectUri };
}

export async function handleCallback(code: string, state: string): Promise<{ channelTitle: string }> {
  if (!pendingOAuthState || state !== pendingOAuthState) {
    throw new Error("Invalid OAuth state — possible CSRF attack");
  }
  const redirectUri = pendingRedirectUri!;
  pendingOAuthState = null;
  pendingRedirectUri = null;

  const oauth2Client = createOAuth2Client(redirectUri);
  console.log("[youtube] Exchanging code for tokens with redirectUri:", redirectUri);
  let tokens: any;
  try {
    const result = await oauth2Client.getToken(code);
    tokens = result.tokens;
  } catch (e: any) {
    console.error("[youtube] getToken error:", e.message, e.response?.data);
    throw new Error(`Не удалось получить токен от Google: ${e.message}`);
  }
  console.log("[youtube] Got tokens, scopes:", tokens.scope);
  oauth2Client.setCredentials(tokens);

  const channelTitle = "YouTube канал";
  console.log("[youtube] Tokens saved, channel connected");

  const existing = await db.select().from(youtubeTokens);
  if (existing.length > 0) {
    await db.update(youtubeTokens)
      .set({
        accessToken: tokens.access_token!,
        refreshToken: tokens.refresh_token || existing[0].refreshToken,
        expiryDate: tokens.expiry_date || null,
        channelTitle,
      })
      .where(eq(youtubeTokens.id, existing[0].id));
  } else {
    await db.insert(youtubeTokens).values({
      accessToken: tokens.access_token!,
      refreshToken: tokens.refresh_token || null,
      expiryDate: tokens.expiry_date || null,
      channelTitle,
    });
  }

  return { channelTitle };
}

async function getAuthenticatedClient() {
  const [token] = await db.select().from(youtubeTokens);
  if (!token) throw new Error("YouTube не подключён. Нажмите кнопку YouTube для авторизации.");

  const redirectUri = "https://unused.example.com/callback";
  const oauth2Client = createOAuth2Client(redirectUri);
  oauth2Client.setCredentials({
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expiry_date: token.expiryDate,
  });

  oauth2Client.on("tokens", async (newTokens) => {
    await db.update(youtubeTokens)
      .set({
        accessToken: newTokens.access_token || token.accessToken,
        expiryDate: newTokens.expiry_date || token.expiryDate,
      })
      .where(eq(youtubeTokens.id, token.id));
  });

  return { oauth2Client, channelTitle: token.channelTitle };
}

export async function getYouTubeStatus(): Promise<{ connected: boolean; channelTitle?: string | null }> {
  const [token] = await db.select().from(youtubeTokens);
  if (!token) return { connected: false };
  return { connected: true, channelTitle: token.channelTitle };
}

export async function disconnectYouTube(): Promise<void> {
  await db.delete(youtubeTokens);
}

export async function uploadToYouTube(
  filePath: string,
  title: string,
  description: string,
  clipDurationSec?: number,
): Promise<{ videoId: string; url: string }> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Файл не найден: ${filePath}`);
  }

  const { oauth2Client } = await getAuthenticatedClient();
  const youtube = google.youtube({ version: "v3", auth: oauth2Client });

  const safeTitle = (title || "Poker Short").substring(0, 95);
  const finalTitle = safeTitle.includes("#Shorts") ? safeTitle : `${safeTitle} #Shorts`;
  const safeDescription = (description || "").substring(0, 5000);

  const res = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: finalTitle,
        description: safeDescription,
        tags: ["shorts", "poker"],
        categoryId: "24",
      },
      status: {
        privacyStatus: "public",
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: fs.createReadStream(filePath),
    },
  });

  const videoId = res.data.id!;

  if (clipDurationSec && clipDurationSec > 0) {
    try {
      const thumbTime = Math.round(clipDurationSec / 2);
      const thumbPath = path.join("/tmp", `yt_thumb_${videoId}.jpg`);
      execSync(
        `ffmpeg -y -ss ${thumbTime} -i "${filePath}" -vframes 1 -q:v 2 "${thumbPath}"`,
        { timeout: 15000 }
      );
      if (fs.existsSync(thumbPath)) {
        await youtube.thumbnails.set({
          videoId,
          media: {
            mimeType: "image/jpeg",
            body: fs.createReadStream(thumbPath),
          },
        });
        fs.unlinkSync(thumbPath);
        console.log(`[youtube] Custom thumbnail set from ${thumbTime}s for video ${videoId}`);
      }
    } catch (e: any) {
      console.warn(`[youtube] Failed to set custom thumbnail: ${e.message}`);
    }
  }

  return {
    videoId,
    url: `https://youtube.com/shorts/${videoId}`,
  };
}

export async function setYouTubeThumbnail(videoId: string, imagePath: string): Promise<void> {
  const { oauth2Client } = await getAuthenticatedClient();
  const youtube = google.youtube({ version: "v3", auth: oauth2Client });

  await youtube.thumbnails.set({
    videoId,
    media: {
      mimeType: "image/jpeg",
      body: fs.createReadStream(imagePath),
    },
  });

  console.log(`[youtube] Thumbnail updated for video ${videoId}`);
}
