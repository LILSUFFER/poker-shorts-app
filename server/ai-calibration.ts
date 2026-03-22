import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { openai } from "./replit_integrations/audio/client";
import { log } from "./index";
import type { CropBox } from "@shared/schema";

const execFileAsync = promisify(execFile);

interface DetectedRegions {
  table: CropBox;
  webcam?: CropBox;
  chat?: CropBox;
}

interface CalibrationHint {
  table?: CropBox;
  webcam?: CropBox;
}

async function getImageDimensions(filePath: string): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "quiet",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-print_format", "json",
    filePath,
  ], { timeout: 10000 });
  const info = JSON.parse(stdout);
  const stream = info.streams?.[0];
  if (!stream?.width || !stream?.height) {
    throw new Error("Could not determine image dimensions");
  }
  return { width: stream.width, height: stream.height };
}

function buildPokerPrompt(sourceWidth: number, sourceHeight: number, hintSection: string): string {
  return `You are a pixel-precise computer vision system. Analyze this poker stream screenshot (${sourceWidth}x${sourceHeight} pixels) and return exact bounding boxes.

STREAM LAYOUT — This is a typical online poker stream (PokerOK/GGPoker, PokerStars, 888poker, or similar). The layout has distinct visual panels:

1. **POKER TABLE** — The game panel occupying the RIGHT or CENTER portion of the screen.
   LOOK FOR: An oval/round poker table with colored felt (green, blue, purple), player seats arranged in a circle/oval with avatar icons, chip counts (like "35.2 BB"), player names, community cards in center, pot display ("Общий банк: XX BB").
   CRITICAL: This panel usually has a VISIBLE BORDER or distinct background. Find the exact edges of the poker client window/panel. Include ALL player seats, chip counts, and HUD overlays that are part of the table panel.
   The table panel often has a header bar at the top showing blind levels, tournament info, or hand number.
   Include the FULL panel from its left edge to its right edge, from its top edge (including any header bar) to its bottom edge.

2. **WEBCAM** — The streamer's face camera, usually a separate rectangular panel.
   LOOK FOR: A real person's face/upper body, often wearing headphones. The webcam panel is typically:
   - In the LEFT portion of the screen (left column)
   - OR overlaid in a corner of the table
   - Has its OWN distinct border/frame separate from the table
   - Shows a room background (walls, furniture, microphone, lights)
   CRITICAL: Find the exact edges of the webcam panel/border. Many streams have a decorative frame or sharp edge around the webcam feed. Snap to those exact pixel boundaries.
   Do NOT include banners, ads, timers, or social media links that may be BELOW or AROUND the webcam — only the video feed itself.

3. **CHAT** (optional) — Stream chat panel if visible.
${hintSection}
PRECISION RULES:
- Look for VISIBLE BORDERS, panel edges, and color transitions to find exact boundaries
- Poker streams often have decorative overlays with clear rectangular panel boundaries — use those edges
- x = left edge pixel, y = top edge pixel, width and height in pixels
- All values: non-negative integers, x+width <= ${sourceWidth}, y+height <= ${sourceHeight}
- Table should be significantly larger than webcam
- Accuracy matters — crop will be used for YouTube Shorts export

Return ONLY valid JSON:
{"table":{"x":0,"y":0,"width":0,"height":0},"webcam":{"x":0,"y":0,"width":0,"height":0}}`;
}

function buildStreamerPrompt(sourceWidth: number, sourceHeight: number, hintSection: string): string {
  return `You are a pixel-precise computer vision system. Analyze this streamer screenshot (${sourceWidth}x${sourceHeight} pixels) and determine the best crop region for a 9:16 vertical video (YouTube Shorts).

This is a GENERAL streamer video (gaming, IRL, just chatting, etc. — NOT necessarily poker). The goal is to create the best possible vertical crop that shows PEOPLE prominently.

ANALYSIS STEPS:

1. **FIND ALL PEOPLE/FACES** in the frame. Look for:
   - Webcam panels showing streamers (face, upper body)
   - Groups of people sitting together (IRL streams, podcasts)
   - Full-body shots of people
   - Small facecam overlays in corners
   - People can be in ANY part of the frame — top, bottom, left, right, center, corners

2. **DETERMINE THE MAIN CONTENT REGION** — the area with the most important visual content:
   - If there's a GAME/SCREEN SHARE taking up most of the frame + a small facecam → the "table" region should be the game area, and "webcam" should be the facecam
   - If there are PEOPLE without a game overlay (podcast, IRL, just chatting) → the "table" region should be the area with people, sized to fill a 9:16 frame
   - If people take up a LARGE portion of the frame (e.g., bottom half with game on top) → the "table" should be the person/people area since that's the main content for Shorts

3. **SMART CROP STRATEGY for 9:16**:
   - The final vertical video will stack "table" on top and "webcam" below (or use just "table" if no separate webcam)
   - If people ARE the main content (IRL/podcast/group stream), set "table" to tightly crop around the people. Include their full heads and upper bodies. The webcam field can be omitted.
   - If there's a game + small facecam, set "table" to the game and "webcam" to the facecam panel
   - PRIORITIZE showing people's faces clearly — they should be large and centered in the crop
${hintSection}
PRECISION RULES:
- x = left edge pixel, y = top edge pixel, width and height in pixels
- All values: non-negative integers, x+width <= ${sourceWidth}, y+height <= ${sourceHeight}
- For the "table" region: crop TIGHTLY around the most important content (people or game)
- For the "webcam" region: crop around the separate webcam panel IF it exists as a distinct panel
- If people ARE the main content (no separate game), return webcam as null
- Accuracy matters — crop will be used for YouTube Shorts export

Return ONLY valid JSON (webcam can be null if no separate webcam panel exists):
{"table":{"x":0,"y":0,"width":0,"height":0},"webcam":{"x":0,"y":0,"width":0,"height":0}}

IMPORTANT: If the people/webcam area IS the main interesting content (like in IRL streams, podcasts, group hangouts), put it in the "table" field since that becomes the primary crop for the vertical video. The "table" field = primary content region, "webcam" = secondary smaller panel.`;
}

export async function detectRegionsWithAI(
  framePath: string,
  hint?: CalibrationHint,
  contentType?: string
): Promise<DetectedRegions & { sourceWidth: number; sourceHeight: number }> {
  const { width: sourceWidth, height: sourceHeight } = await getImageDimensions(framePath);
  log(`AI auto-calibration: analyzing frame ${framePath} (${sourceWidth}x${sourceHeight}), contentType=${contentType || "auto"}`, "ai-calibration");

  const imageBuffer = fs.readFileSync(framePath);
  const base64Image = imageBuffer.toString("base64");
  const mimeType = framePath.endsWith(".png") ? "image/png" : "image/jpeg";

  let hintSection = "";
  if (hint?.table || hint?.webcam) {
    hintSection = `
REFERENCE HINT (from previous calibration — use as approximate guide, but snap to actual visual boundaries you see):
${hint.table ? `- Primary region was approximately at: x=${hint.table.x}, y=${hint.table.y}, ${hint.table.width}x${hint.table.height}` : ""}
${hint.webcam ? `- Webcam was approximately at: x=${hint.webcam.x}, y=${hint.webcam.y}, ${hint.webcam.width}x${hint.webcam.height}` : ""}
Use these as a starting point, but adjust to match the EXACT visual boundaries in this specific frame.
`;
  }

  const prompt = contentType === "streamer"
    ? buildStreamerPrompt(sourceWidth, sourceHeight, hintSection)
    : buildPokerPrompt(sourceWidth, sourceHeight, hintSection);

  const response = await openai.chat.completions.create({
    model: "gpt-4.1",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${base64Image}`,
              detail: "high",
            },
          },
        ],
      },
    ],
    temperature: 0,
    max_tokens: 500,
  });

  const content = response.choices[0]?.message?.content || "";
  log(`AI calibration raw response: ${content}`, "ai-calibration");

  let parsed: any;
  try {
    const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("AI не смогла распознать области. Попробуйте ещё раз или выделите вручную.");
  }

  if (!parsed.table || typeof parsed.table.x !== "number" || typeof parsed.table.y !== "number" ||
      typeof parsed.table.width !== "number" || typeof parsed.table.height !== "number") {
    throw new Error("AI не обнаружила основную область. Выделите область вручную.");
  }

  const clampBox = (box: any, label: string): CropBox => {
    const x = Math.max(0, Math.round(box.x));
    const y = Math.max(0, Math.round(box.y));
    const w = Math.min(Math.round(box.width), sourceWidth - x);
    const h = Math.min(Math.round(box.height), sourceHeight - y);

    if (w < 50 || h < 50) {
      throw new Error(`AI определила область "${label}" слишком маленькой (${w}x${h}). Попробуйте другой кадр или выделите вручную.`);
    }

    return { x, y, width: w, height: h };
  };

  const result: DetectedRegions & { sourceWidth: number; sourceHeight: number } = {
    table: clampBox(parsed.table, "основной контент"),
    sourceWidth,
    sourceHeight,
  };

  if (parsed.webcam && typeof parsed.webcam.x === "number" &&
      typeof parsed.webcam.width === "number" && parsed.webcam.width > 0) {
    try {
      result.webcam = clampBox(parsed.webcam, "вебкамера");
    } catch {
    }
  }

  if (parsed.chat && typeof parsed.chat.x === "number") {
    try {
      result.chat = clampBox(parsed.chat, "чат");
    } catch {
    }
  }

  log(`AI calibration result: table=${JSON.stringify(result.table)}, webcam=${result.webcam ? JSON.stringify(result.webcam) : "none"}`, "ai-calibration");
  return result;
}
