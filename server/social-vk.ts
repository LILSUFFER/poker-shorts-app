import fs from "fs";
import FormData from "form-data";
import { db } from "./db";
import { socialTokens } from "@shared/schema";
import { eq } from "drizzle-orm";

const PLATFORM = "vk";

export function getVkAuthUrl(): string {
  const clientId = process.env.VK_CLIENT_ID;
  if (!clientId) {
    throw new Error("VK_CLIENT_ID не настроен");
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: "https://oauth.vk.com/blank.html",
    response_type: "token",
    scope: "video,offline",
    display: "popup",
    v: "5.131",
  });
  return `https://oauth.vk.com/authorize?${params.toString()}`;
}

export async function saveVkToken(accessToken: string, userId: string, expiresIn: string | null, groupId?: string | null): Promise<{ accountName: string }> {
  const expiryDate = expiresIn && parseInt(expiresIn) > 0 ? Date.now() + parseInt(expiresIn) * 1000 : null;

  let accountName = "VK пользователь";
  try {
    const userResp = await fetch(`https://api.vk.com/method/users.get?user_ids=${userId}&fields=first_name,last_name&access_token=${accessToken}&v=5.131`);
    const userData = await userResp.json();
    if (userData.response?.[0]) {
      const u = userData.response[0];
      accountName = `${u.first_name || ""} ${u.last_name || ""}`.trim() || "VK пользователь";
    }
  } catch (e) {
    console.error("[vk] Failed to get user info:", e);
  }

  let groupName: string | null = null;
  if (groupId) {
    try {
      const resp = await fetch(`https://api.vk.com/method/groups.getById`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ group_id: groupId, access_token: accessToken, v: "5.131" }).toString(),
      });
      const data = await resp.json();
      if (data.response?.groups?.[0]) {
        groupName = data.response.groups[0].name;
      } else if (data.response?.[0]) {
        groupName = data.response[0].name;
      }
    } catch (e) {
      console.error("[vk] Failed to get group info:", e);
    }
  }

  const extra: Record<string, any> = {};
  if (groupId) {
    extra.groupId = groupId;
    extra.groupName = groupName || `Группа ${groupId}`;
  }

  const existing = await db.select().from(socialTokens).where(eq(socialTokens.platform, PLATFORM));
  if (existing.length > 0) {
    await db.update(socialTokens)
      .set({ accessToken, refreshToken: null, expiryDate, accountName, accountId: userId, extra })
      .where(eq(socialTokens.id, existing[0].id));
  } else {
    await db.insert(socialTokens).values({
      platform: PLATFORM,
      accessToken,
      refreshToken: null,
      expiryDate,
      accountName,
      accountId: userId,
      extra,
    });
  }

  return { accountName };
}

export async function getVkStatus(): Promise<{ connected: boolean; accountName?: string | null; groupId?: string | null; groupName?: string | null }> {
  const [token] = await db.select().from(socialTokens).where(eq(socialTokens.platform, PLATFORM));
  if (!token) return { connected: false };
  const extra = (token.extra as Record<string, any>) || {};
  return { connected: true, accountName: token.accountName, groupId: extra.groupId || null, groupName: extra.groupName || null };
}

export async function setVkGroup(groupId: string): Promise<{ groupId: string; groupName: string }> {
  const [token] = await db.select().from(socialTokens).where(eq(socialTokens.platform, PLATFORM));
  if (!token) throw new Error("VK не подключён");

  let groupName = `Группа ${groupId}`;
  try {
    const resp = await fetch(`https://api.vk.com/method/groups.getById`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ group_id: groupId, access_token: token.accessToken, v: "5.131" }).toString(),
    });
    const data = await resp.json();
    if (data.response?.groups?.[0]) {
      groupName = data.response.groups[0].name;
    } else if (data.response?.[0]) {
      groupName = data.response[0].name;
    }
  } catch (e) {
    console.error("[vk] Failed to get group info:", e);
  }

  const extra = { ...((token.extra as Record<string, any>) || {}), groupId, groupName };
  await db.update(socialTokens).set({ extra }).where(eq(socialTokens.id, token.id));

  return { groupId, groupName };
}

export async function clearVkGroup(): Promise<void> {
  const [token] = await db.select().from(socialTokens).where(eq(socialTokens.platform, PLATFORM));
  if (!token) throw new Error("VK не подключён");
  const extra = { ...((token.extra as Record<string, any>) || {}) };
  delete extra.groupId;
  delete extra.groupName;
  await db.update(socialTokens).set({ extra }).where(eq(socialTokens.id, token.id));
}

export async function disconnectVk(): Promise<void> {
  await db.delete(socialTokens).where(eq(socialTokens.platform, PLATFORM));
}

export async function uploadToVk(
  filePath: string,
  title: string,
  description: string,
): Promise<{ videoId: string; url: string }> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Файл не найден: ${filePath}`);
  }

  const [token] = await db.select().from(socialTokens).where(eq(socialTokens.platform, PLATFORM));
  if (!token) throw new Error("VK не подключён.");

  const accessToken = token.accessToken;
  const extra = (token.extra as Record<string, any>) || {};
  const groupId = extra.groupId || null;

  const safeTitle = (title || "Poker Short").substring(0, 128);
  const safeDesc = (description || "").substring(0, 5000);

  const params: Record<string, string> = {
    name: safeTitle,
    description: safeDesc,
    is_private: "0",
    access_token: accessToken,
    v: "5.131",
  };
  if (groupId) {
    params.group_id = groupId;
  }

  const saveResp = await fetch("https://api.vk.com/method/video.save", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const saveData = await saveResp.json();
  console.log("[vk] video.save response:", JSON.stringify(saveData));
  if (saveData.error) {
    const errMsg = saveData.error.error_msg || JSON.stringify(saveData.error);
    throw new Error(`VK video.save error: ${errMsg}`);
  }

  const uploadUrl = saveData.response.upload_url;
  const videoId = saveData.response.video_id;
  const ownerId = saveData.response.owner_id;

  const form = new FormData();
  form.append("video_file", fs.createReadStream(filePath));

  const uploadResp = await fetch(uploadUrl, {
    method: "POST",
    body: form as any,
    headers: form.getHeaders(),
  });
  const uploadResult = await uploadResp.json();
  if (uploadResult.error) {
    throw new Error(`VK upload error: ${JSON.stringify(uploadResult.error)}`);
  }

  return {
    videoId: `${ownerId}_${videoId}`,
    url: `https://vk.com/video${ownerId}_${videoId}`,
  };
}
