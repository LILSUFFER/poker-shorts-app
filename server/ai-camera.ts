import { log } from "./index";
import { vpsAnalyzeSpeakers, getVpsUrl, getVpsToken } from "./vps-client";
import type { SpeakerFrame } from "./vps-client";
import type { CropBox } from "@shared/schema";

// ── Kalman filter for smooth face tracking ────────────────────────────────────
class KalmanFilter1D {
  private x: number;
  private v: number = 0;
  private P: number = 100;
  private readonly Q: number;
  private readonly R: number;

  constructor(initialPos: number, Q = 0.5, R = 8) {
    this.x = initialPos;
    this.Q = Q;
    this.R = R;
  }

  update(measurement: number, dt: number = 1): number {
    // Predict
    this.x += this.v * dt;
    this.P += this.Q * dt;
    // Update
    const K = this.P / (this.P + this.R);
    const innovation = measurement - this.x;
    this.x += K * innovation;
    if (dt > 0) this.v += (K * innovation) / dt * 0.3;
    this.P = (1 - K) * this.P;
    return Math.round(this.x);
  }
}

function smoothFacePositions(frames: SpeakerFrame[]): SpeakerFrame[] {
  if (frames.length < 3) return frames;

  const withFaces = frames.filter(f => f.faces.length > 0);
  if (withFaces.length < 2) return frames;

  const firstFace = withFaces[0].faces[0];
  const kfX = new KalmanFilter1D(firstFace.cx);
  const kfY = new KalmanFilter1D(firstFace.cy);
  const kfW = new KalmanFilter1D(firstFace.w);
  const kfH = new KalmanFilter1D(firstFace.h);

  let prevTime = frames[0].time;

  return frames.map(frame => {
    const dt = Math.max(0.1, frame.time - prevTime);
    prevTime = frame.time;

    if (frame.faces.length === 0) return frame;

    const face = frame.faces[0];
    const smoothedCx = kfX.update(face.cx, dt);
    const smoothedCy = kfY.update(face.cy, dt);
    const smoothedW = kfW.update(face.w, dt);
    const smoothedH = kfH.update(face.h, dt);

    return {
      ...frame,
      faces: [{
        ...face,
        cx: smoothedCx,
        cy: smoothedCy,
        w: smoothedW,
        h: smoothedH,
      }, ...frame.faces.slice(1)],
    };
  });
}

// ── YOLO face detection via RunPod GPU pod ────────────────────────────────────
const RUNPOD_POD_URL = process.env.RUNPOD_POD_URL || "https://jlozmxn8xfcjae-8788.proxy.runpod.net";

async function analyzeFacesWithRunPodYOLO(
  vpsVideoId: string,
  timestamps: number[],
  region: { x: number; y: number; w: number; h: number },
): Promise<SpeakerFrame[]> {
  const vpsUrl = getVpsUrl();
  const vpsToken = getVpsToken();

  const frames = timestamps.map(ts => ({
    url: `${vpsUrl}/frame/${vpsVideoId}`,
    timestamp: ts,
    vpsToken,
  }));

  log(`[ai-camera] RunPod YOLO: ${RUNPOD_POD_URL}/analyze-faces (${frames.length} frames, region ${region.w}x${region.h}@${region.x},${region.y})`, "ai-camera");

  // Run face detection (RunPod GPU) + audio energy (VPS) in parallel
  const [faceRes, audioRes] = await Promise.allSettled([
    fetch(`${RUNPOD_POD_URL}/analyze-faces`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${vpsToken}`,
      },
      body: JSON.stringify({ frames, region }),
      signal: AbortSignal.timeout(120000),
    }),
    fetch(`${vpsUrl}/audio-energy/${vpsVideoId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-vps-token": vpsToken },
      body: JSON.stringify({ timestamps }),
      signal: AbortSignal.timeout(60000),
    }),
  ]);

  if (faceRes.status === "rejected" || !faceRes.value.ok) {
    const err = faceRes.status === "rejected"
      ? faceRes.reason.message
      : `HTTP ${faceRes.value.status}: ${await faceRes.value.text().catch(() => "")}`;
    throw new Error(`RunPod YOLO: ${err.slice(0, 200)}`);
  }

  const data: SpeakerFrame[] = await faceRes.value.json();

  // Merge audio energy from VPS into face data
  const audioMap: Record<string, number> = {};
  if (audioRes.status === "fulfilled" && audioRes.value.ok) {
    try {
      const raw = await audioRes.value.json() as Record<string, number>;
      Object.assign(audioMap, raw);
      log(`[ai-camera] Audio energy: ${Object.entries(audioMap).map(([t, v]) => `${parseFloat(t).toFixed(1)}=${(v as number).toFixed(3)}`).join(" ")}`, "ai-camera");
    } catch { /* ignore */ }
  } else {
    log(`[ai-camera] Audio energy fetch skipped: ${audioRes.status === "rejected" ? (audioRes.reason as Error).message : "HTTP error"}`, "ai-camera");
  }

  const getAudioEnergy = (ts: number): number => {
    const key = Object.keys(audioMap).find(k => Math.abs(parseFloat(k) - ts) < 0.5);
    return key !== undefined ? (audioMap[key] ?? 0.0) : 0.0;
  };

  return data.map(frame => ({
    ...frame,
    audio_energy: getAudioEnergy(frame.time),
  }));
}

// ── YOLO face detection via VPS endpoint ──────────────────────────────────────
async function analyzeFacesWithYOLO(
  vpsVideoId: string,
  timestamps: number[],
  region: { x: number; y: number; w: number; h: number },
): Promise<SpeakerFrame[]> {
  const vpsUrl = getVpsUrl();
  const vpsToken = getVpsToken();

  log(`[ai-camera] YOLO: calling VPS /analyze-faces-yolo/${vpsVideoId} (${timestamps.length} frames)`, "ai-camera");

  const res = await fetch(`${vpsUrl}/analyze-faces-yolo/${vpsVideoId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-vps-token": vpsToken },
    body: JSON.stringify({ timestamps, region }),
    signal: AbortSignal.timeout(90000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`VPS YOLO HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const data: SpeakerFrame[] = await res.json();
  return data;
}

async function analyzeFacesWithGPT4oVision(
  vpsVideoId: string,
  timestamps: number[],
  region: { x: number; y: number; w: number; h: number },
): Promise<SpeakerFrame[]> {
  const vpsUrl = getVpsUrl();
  const vpsToken = getVpsToken();

  log(`[ai-camera] GPT-4o Vision: fetching ${timestamps.length} frames in parallel`, "ai-camera");

  const frameResults = await Promise.allSettled(timestamps.map(async (ts) => {
    const res = await fetch(`${vpsUrl}/frame/${vpsVideoId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-vps-token": vpsToken },
      body: JSON.stringify({ time: ts }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    return { ts, base64: Buffer.from(buf).toString("base64") };
  }));

  const validFrames = frameResults
    .map(r => r.status === "fulfilled" ? r.value : null)
    .filter(Boolean) as Array<{ ts: number; base64: string }>;

  if (validFrames.length === 0) throw new Error("No frames extracted from VPS");

  log(`[ai-camera] GPT-4o Vision: ${validFrames.length}/${timestamps.length} frames ready, calling API`, "ai-camera");

  const { openai } = await import("./replit_integrations/audio/client");

  const imageContent: any[] = validFrames.map(f => ({
    type: "image_url",
    image_url: { url: `data:image/jpeg;base64,${f.base64}`, detail: "low" },
  }));

  const prompt = `Analyze these ${validFrames.length} video frames in order. For each frame, find the most prominent human face.
Return ONLY a JSON array with exactly ${validFrames.length} objects:
[{"face":true,"cx":X,"cy":Y,"fw":W,"fh":H,"mouth":0.0},...]
- cx,cy = face center in ABSOLUTE pixel coordinates in the full image
- fw,fh = face bounding box size in pixels
- mouth = mouth openness 0.0=closed 1.0=fully open/speaking
If no face detected: {"face":false,"cx":0,"cy":0,"fw":0,"fh":0,"mouth":0}
No explanation, only the JSON array.`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...imageContent] }],
    max_tokens: 800,
    temperature: 0,
  });

  const rawText = completion.choices[0]?.message?.content || "[]";
  const jsonMatch = rawText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error(`GPT returned no JSON: ${rawText.slice(0, 100)}`);

  const parsed: any[] = JSON.parse(jsonMatch[0]);

  return validFrames.map((frame, i) => {
    const r = parsed[i] || {};
    const hasFace = !!r.face;
    // GPT returns absolute pixel coords — convert to region-relative
    const cx = hasFace ? Math.round((r.cx || 0) - region.x) : 0;
    const cy = hasFace ? Math.round((r.cy || 0) - region.y) : 0;
    const fw = hasFace ? Math.round(r.fw || 80) : 0;
    const fh = hasFace ? Math.round(r.fh || 100) : 0;
    const mouthScore = hasFace ? Math.min(1, Math.max(0, r.mouth || 0)) : 0;
    const faces = hasFace ? [{
      id: 0,
      cx: Math.max(0, cx),
      cy: Math.max(0, cy),
      w: fw,
      h: fh,
      speaking_score: mouthScore,
      area: fw * fh,
    }] : [];
    return { time: frame.ts, faces, audio_energy: 0.1 };
  });
}

export interface CameraKeyframe {
  time: number;
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
  target: string;
  cut?: boolean;            // true = instant hard cut
  transitionDuration?: number; // seconds for fast whip pan (undefined = pan over full interval)
}

function computeCropDimensions(wcW: number, wcH: number) {
  const ZOOM_FACTOR = 0.95;
  let maxCropW = Math.round(wcH * (9 / 16) * ZOOM_FACTOR);
  let maxCropH = Math.round(maxCropW * (16 / 9));
  if (maxCropW > wcW) { maxCropW = wcW; maxCropH = Math.round(maxCropW * (16 / 9)); }
  if (maxCropH > wcH) { maxCropH = wcH; maxCropW = Math.round(maxCropH * (9 / 16)); }
  if (maxCropW % 2 !== 0) maxCropW--;
  if (maxCropH % 2 !== 0) maxCropH--;
  const posRight = Math.max(0, wcW - maxCropW);
  const posBottom = Math.max(0, wcH - maxCropH);
  return { maxCropW, maxCropH, posRight, posBottom };
}

export async function analyzeCameraKeyframes(
  vpsVideoId: string,
  startTime: number,
  endTime: number,
  webcamRegion: CropBox,
  sourceWidth: number,
  sourceHeight: number,
  frameInterval: number = 1.5
): Promise<CameraKeyframe[]> {
  const duration = endTime - startTime;
  const frameCount = Math.min(Math.ceil(duration / frameInterval), 10);
  const actualInterval = duration / frameCount;

  // Absolute timestamps in the original video for MediaPipe analysis
  const timestamps = Array.from({ length: frameCount }, (_, i) =>
    startTime + i * actualInterval + actualInterval / 2
  );

  // ── Always scan the FULL frame for face detection ────────────────────────────
  // Dynamic camera purpose: find whoever is speaking ANYWHERE in the video,
  // then pan/zoom to them. webcamRegion is used for dual-region layout only.
  const useFullFrame = sourceWidth > 0 && sourceHeight > 0;
  let wcX = useFullFrame ? 0 : webcamRegion.x;
  let wcY = useFullFrame ? 0 : webcamRegion.y;
  let wcW = useFullFrame ? sourceWidth : webcamRegion.width;
  let wcH = useFullFrame ? sourceHeight : webcamRegion.height;

  log(`[ai-camera] Detection region: ${wcW}x${wcH}@(${wcX},${wcY}) (${useFullFrame ? "FULL FRAME" : "webcam region"})`, "ai-camera");
  log(`[ai-camera] face analyze: ${vpsVideoId} ts=[${timestamps.map(t => t.toFixed(1)).join(",")}] region=${wcW}x${wcH}@(${wcX},${wcY})`, "ai-camera");

  let speakerData: SpeakerFrame[];
  const detRegion = { x: wcX, y: wcY, w: wcW, h: wcH };
  try {
    speakerData = await analyzeFacesWithRunPodYOLO(vpsVideoId, timestamps, detRegion);
    log(`[ai-camera] RunPod YOLO succeeded: ${speakerData.filter(f => f.faces.length > 0).length}/${speakerData.length} frames with faces`, "ai-camera");
  } catch (runpodErr: any) {
    log(`[ai-camera] RunPod YOLO failed (${runpodErr.message}), falling back to VPS YOLO`, "ai-camera");
    try {
      speakerData = await analyzeFacesWithYOLO(vpsVideoId, timestamps, detRegion);
      log(`[ai-camera] VPS YOLO succeeded: ${speakerData.filter(f => f.faces.length > 0).length}/${speakerData.length} frames with faces`, "ai-camera");
    } catch (yoloErr: any) {
      log(`[ai-camera] VPS YOLO failed (${yoloErr.message}), falling back to GPT-4o Vision`, "ai-camera");
      try {
        speakerData = await analyzeFacesWithGPT4oVision(vpsVideoId, timestamps, detRegion);
        log(`[ai-camera] GPT-4o Vision succeeded: ${speakerData.filter(f => f.faces.length > 0).length}/${speakerData.length} frames`, "ai-camera");
      } catch (gptErr: any) {
        log(`[ai-camera] GPT-4o Vision failed (${gptErr.message}), falling back to MediaPipe`, "ai-camera");
        try {
          speakerData = await vpsAnalyzeSpeakers(vpsVideoId, timestamps, detRegion);
        } catch (err: any) {
          log(`[ai-camera] MediaPipe also failed: ${err.message} — skipping dynamic camera`, "ai-camera");
          return [];
        }
      }
    }
  }

  // Apply Kalman filter to smooth jitter in face positions
  speakerData = smoothFacePositions(speakerData);

  if (!speakerData || speakerData.length < 2) {
    log(`[ai-camera] Not enough speaker frames (${speakerData?.length ?? 0}), skipping`, "ai-camera");
    return [];
  }

  let framesWithFaces = speakerData.filter(f => f.faces.length > 0).length;
  const audioEnergies = speakerData.map(f => (f.audio_energy ?? 0).toFixed(3));
  const maxAudioEnergy = Math.max(...speakerData.map(f => f.audio_energy ?? 0));

  // Crop dimensions based on full frame
  const { maxCropW, maxCropH, posRight, posBottom } = computeCropDimensions(wcW, wcH);

  const faceCounts = speakerData.map(f => f.faces.length);
  log(`[ai-camera] Effective region: ${wcW}x${wcH}@(${wcX},${wcY}), posRight=${posRight}, cropSize=${maxCropW}x${maxCropH}. Faces/frame: [${faceCounts.join(",")}]. Audio: [${audioEnergies.join(",")}] (max=${maxAudioEnergy.toFixed(3)}). Frames with faces: ${framesWithFaces}`, "ai-camera");

  // Default crop position: centered within the webcam region
  const defaultCropX = wcX + Math.round(posRight / 2);
  const defaultCropY = wcY + Math.round(posBottom / 2);

  // ── ANCHOR POSITION ──────────────────────────────────────────────────────────
  // Find where the SPEAKING person is positioned across frames.
  // The streamer is always speaking into the mic → higher speaking_score (mouth open).
  // Background people may be visible but not speaking → lower speaking_score.
  // Strategy: bucket face-derived cropX into 50px bins, weighted by speaking_score.
  // A face with speaking_score=0.8 counts 4x more than score=0.2 (streamer dominates).
  const BIN = 50;
  const binCounts: Record<number, { count: number; sumX: number; sumY: number }> = {};
  for (const frame of speakerData) {
    if (!frame.faces.length) continue;
    // Pick the face with highest speaking_score (fallback: largest face[0])
    const face = frame.faces.reduce(
      (best, f) => f.speaking_score > best.speaking_score ? f : best,
      frame.faces[0]
    );
    // Weight by speaking_score: speaking face counts up to 4x more than silent face
    const weight = 1 + face.speaking_score * 3;
    const cx = wcX + Math.round(Math.max(0, Math.min(posRight, face.cx - maxCropW / 2)));
    const cy = wcY + Math.round(Math.max(0, Math.min(posBottom, face.cy - maxCropH / 3)));
    const bin = Math.round(cx / BIN);
    if (!binCounts[bin]) binCounts[bin] = { count: 0, sumX: 0, sumY: 0 };
    binCounts[bin].count += weight;
    binCounts[bin].sumX += cx * weight;
    binCounts[bin].sumY += cy * weight;
  }

  let anchorCropX = defaultCropX;
  let anchorCropY = defaultCropY;
  const topBin = Object.values(binCounts).sort((a, b) => b.count - a.count)[0];
  if (topBin) {
    anchorCropX = Math.round(topBin.sumX / topBin.count);
    anchorCropY = Math.round(topBin.sumY / topBin.count);
    log(`[ai-camera] Anchor (speaking-weighted bin): count=${topBin.count.toFixed(1)}, anchorCropX=${anchorCropX}, anchorCropY=${anchorCropY}`, "ai-camera");
  }

  // ── FACE-FOLLOWING ────────────────────────────────────────────────────────────
  // Start at anchor position (where faces were most often detected)
  const result: CameraKeyframe[] = [{
    time: 0,
    cropX: anchorCropX,
    cropY: anchorCropY,
    cropW: maxCropW,
    cropH: maxCropH,
    target: "face",
    cut: false,
  }];

  if (framesWithFaces >= 1) {
    log(`[ai-camera] Face-following mode: ${framesWithFaces} frames with faces, anchor=(${anchorCropX},${anchorCropY})`, "ai-camera");

    const MIN_TIME = 2.0;
    let lastEmittedTime = -MIN_TIME;

    for (let i = 0; i < speakerData.length; i++) {
      const frame = speakerData[i];
      const relTime = Math.max(0, frame.time - startTime);
      const timeDiff = relTime - lastEmittedTime;
      if (timeDiff < MIN_TIME) continue;

      if (!frame.faces.length) {
        log(`[ai-camera] t=${relTime.toFixed(1)}s: no faces → hold`, "ai-camera");
        continue;
      }

      // Pick the face closest to the anchor position (= where the streamer consistently appears).
      // Among faces equidistant from anchor, prefer larger face area.
      let bestFace = frame.faces[0];
      let bestScore = -Infinity;
      for (const f of frame.faces) {
        const cX = wcX + Math.max(0, Math.min(posRight, f.cx - maxCropW / 2));
        const dist = Math.abs(cX - anchorCropX);
        // Score: prioritize proximity to anchor, then area
        const score = -dist + f.area * 0.01;
        if (score > bestScore) { bestScore = score; bestFace = f; }
      }

      const face = bestFace;
      const idealRelX = Math.round(Math.max(0, Math.min(posRight, face.cx - maxCropW / 2)));
      const idealCropX = wcX + idealRelX;
      const idealRelY = Math.round(Math.max(0, Math.min(posBottom, face.cy - maxCropH / 3)));
      const idealCropY = wcY + idealRelY;

      result.push({
        time: relTime,
        cropX: idealCropX,
        cropY: idealCropY,
        cropW: maxCropW,
        cropH: maxCropH,
        target: "face",
        cut: false,
        transitionDuration: Math.min(1.5, timeDiff * 0.4),
      });
      lastEmittedTime = relTime;
      log(`[ai-camera] KF t=${relTime.toFixed(1)}s: cropX=${idealCropX} cropY=${idealCropY} (face cx=${face.cx} cy=${face.cy} area=${face.area} audio=${(frame.audio_energy ?? 0).toFixed(3)})`, "ai-camera");
    }
  }

  // ── FALLBACK: если нет кейфреймов, камера остаётся на позиции якоря ─────────
  // Якорь = усреднённая позиция лица говорящего, поэтому это разумный fallback.
  // Slow pan (от 0 до posRight) убран — он создавал ощущение что камера "едет в край"
  if (result.length < 2) {
    log(`[ai-camera] No additional keyframes generated, camera stays at anchor (${anchorCropX},${anchorCropY})`, "ai-camera");
  }

  log(`[ai-camera] Final keyframes (${result.length}): ${JSON.stringify(result.map(k => ({ t: k.time.toFixed(1), x: k.cropX, tgt: k.target })))}`, "ai-camera");
  return result.filter(kf => kf.time >= 0 && kf.time <= duration + 1);
}

export function generateSendcmdScript(keyframes: CameraKeyframe[], clipDuration: number): string {
  if (keyframes.length === 0) return "";
  const lines: string[] = [];
  for (let i = 0; i < keyframes.length; i++) {
    const kf = keyframes[i];
    const nextTime = i < keyframes.length - 1 ? keyframes[i + 1].time : clipDuration;
    lines.push(`${kf.time.toFixed(2)}-${nextTime.toFixed(2)} [enter] crop x ${kf.cropX};`);
    lines.push(`${kf.time.toFixed(2)}-${nextTime.toFixed(2)} [enter] crop y ${kf.cropY};`);
  }
  return lines.join("\n");
}

// Generated by GPT-5.4 (gpt-5.4-2026-03-05)
export function generateDynamicCropFilter(
  keyframes: CameraKeyframe[],
  clipDuration: number,
  outW: number,
  outH: number
): string {
  if (!keyframes || keyframes.length === 0) return "";

  const kfs = [...keyframes].sort((a, b) => a.time - b.time);

  if (kfs.length === 1) {
    const kf = kfs[0];
    return `crop=${kf.cropW}:${kf.cropH}:${kf.cropX}:${kf.cropY},scale=${outW}:${outH}:flags=lanczos,setsar=1`;
  }

  const fmt = (n: number): string => {
    if (!Number.isFinite(n)) return "0";
    const s = n.toFixed(4).replace(/\.?0+$/, "");
    return s === "-0" ? "0" : s;
  };

  const linearSegment = (t0: number, t1: number, v0: number, v1: number, fallback: string): string => {
    if (t1 <= t0) return fallback;
    const expr = `${fmt(v0)}+(${fmt(v1)}-${fmt(v0)})*(t-${fmt(t0)})/${fmt(t1 - t0)}`;
    return `if(lt(t,${fmt(t0)}),${fmt(v0)},if(lt(t,${fmt(t1)}),${expr},${fallback}))`;
  };

  const easeSegment = (t0: number, d: number, v0: number, v1: number, fallback: string): string => {
    if (d <= 0) return fallback;
    const expr = `${fmt(v0)}+(${fmt(v1)}-${fmt(v0)})*(1-cos(PI*(t-${fmt(t0)})/${fmt(d)}))/2`;
    return `if(lt(t,${fmt(t0)}),${fmt(v0)},if(lt(t,${fmt(t0 + d)}),${expr},${fallback}))`;
  };

  const buildExpr = (prop: "cropX" | "cropY" | "cropW" | "cropH"): string => {
    let expr = fmt(kfs[kfs.length - 1][prop]);
    for (let i = kfs.length - 2; i >= 0; i--) {
      const prev = kfs[i];
      const next = kfs[i + 1];
      const v0 = prev[prop];
      const v1 = next[prop];
      if (next.cut) {
        expr = `if(gte(t,${fmt(next.time)}),${expr},${fmt(v0)})`;
      } else if (next.transitionDuration != null && next.transitionDuration > 0) {
        const d = Math.min(next.transitionDuration, clipDuration - prev.time);
        expr = easeSegment(prev.time, d, v0, v1, expr);
      } else {
        expr = linearSegment(prev.time, next.time, v0, v1, expr);
      }
    }
    expr = `if(lt(t,${fmt(kfs[0].time)}),${fmt(kfs[0][prop])},${expr})`;
    return expr;
  };

  const xExpr = buildExpr("cropX");
  const yExpr = buildExpr("cropY");
  const wExpr = buildExpr("cropW");
  const hExpr = buildExpr("cropH");

  return `crop='${wExpr}':'${hExpr}':'${xExpr}':'${yExpr}',scale=${outW}:${outH}:flags=lanczos,setsar=1`;
}
