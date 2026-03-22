import { execSync, exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import { log } from "./index";
import type { CalibrationData, ThresholdsData } from "@shared/schema";

const execAsync = promisify(exec);

interface AnalysisSignal {
  time: number;
  type: string;
  value: number;
}

interface ClipCandidate {
  startTime: number;
  endTime: number;
  confidence: number;
  reasons: string[];
  signals: Record<string, number>;
}

export async function extractFrame(videoPath: string, outputPath: string, timeSeconds: number = 10): Promise<void> {
  const start = Date.now();
  await execAsync(
    `ffmpeg -ss ${timeSeconds} -i "${videoPath}" -vframes 1 -q:v 2 "${outputPath}" -y`,
    { timeout: 30000 }
  );
  log(`extractFrame took ${Date.now() - start}ms`, "analyzer");
}

export async function getVideoInfo(videoPath: string): Promise<{ duration: number; width: number; height: number }> {
  const start = Date.now();
  const { stdout } = await execAsync(
    `ffprobe -v quiet -print_format json -show_format -show_streams "${videoPath}"`,
    { timeout: 30000 }
  );
  const info = JSON.parse(stdout);
  const videoStream = info.streams.find((s: any) => s.codec_type === "video");
  const duration = parseFloat(info.format.duration || "0");
  const width = videoStream?.width || 1920;
  const height = videoStream?.height || 1080;
  log(`getVideoInfo took ${Date.now() - start}ms: ${duration}s ${width}x${height}`, "analyzer");
  return { duration, width, height };
}

export async function generateThumbnail(videoPath: string, outputPath: string, duration?: number): Promise<void> {
  const start = Date.now();
  const seekTime = duration ? Math.min(5, Math.max(0, duration * 0.1)) : 1;
  await execAsync(
    `ffmpeg -ss ${seekTime} -i "${videoPath}" -vframes 1 -vf "scale=320:-1" -q:v 4 "${outputPath}" -y`,
    { timeout: 30000 }
  );
  log(`generateThumbnail took ${Date.now() - start}ms`, "analyzer");
}

async function analyzeAudioPeaks(
  videoPath: string,
  duration: number,
  threshold: number
): Promise<AnalysisSignal[]> {
  const start = Date.now();
  const signals: AnalysisSignal[] = [];

  try {
    const tmpFile = `/tmp/audio_analysis_${Date.now()}.txt`;
    await execAsync(
      `ffmpeg -i "${videoPath}" -af "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=${tmpFile}" -f null - 2>/dev/null`,
      { timeout: Math.max(duration * 2, 60) * 1000 }
    );

    if (fs.existsSync(tmpFile)) {
      const content = fs.readFileSync(tmpFile, "utf-8");
      const lines = content.split("\n");
      let currentTime = 0;

      for (const line of lines) {
        if (line.startsWith("frame:")) {
          const timeMatch = line.match(/pts_time:(\d+\.?\d*)/);
          if (timeMatch) {
            currentTime = parseFloat(timeMatch[1]);
          }
        } else if (line.includes("lavfi.astats.Overall.RMS_level")) {
          const valueMatch = line.match(/=(-?\d+\.?\d*)/);
          if (valueMatch) {
            const rmsDb = parseFloat(valueMatch[1]);
            const rmsLinear = Math.pow(10, rmsDb / 20);
            if (rmsLinear > threshold) {
              signals.push({
                time: currentTime,
                type: "audio_peak",
                value: rmsLinear,
              });
            }
          }
        }
      }

      fs.unlinkSync(tmpFile);
    }
  } catch (err) {
    log(`Audio analysis error (non-critical): ${err}`, "analyzer");
    const segmentDuration = 2;
    const numSegments = Math.floor(duration / segmentDuration);

    for (let i = 0; i < numSegments; i++) {
      const segStart = i * segmentDuration;
      try {
        const { stdout } = await execAsync(
          `ffmpeg -ss ${segStart} -t ${segmentDuration} -i "${videoPath}" -af "volumedetect" -f null - 2>&1 | grep "max_volume"`,
          { timeout: 10000 }
        );
        const match = stdout.match(/max_volume:\s*(-?\d+\.?\d*)/);
        if (match) {
          const maxVol = parseFloat(match[1]);
          const linear = Math.pow(10, maxVol / 20);
          if (linear > threshold) {
            signals.push({
              time: segStart + segmentDuration / 2,
              type: "audio_peak",
              value: linear,
            });
          }
        }
      } catch {
        // skip segment
      }
    }
  }

  log(`analyzeAudioPeaks took ${Date.now() - start}ms, found ${signals.length} peaks`, "analyzer");
  return signals;
}

async function analyzeSceneChanges(
  videoPath: string,
  calibration: CalibrationData,
  threshold: number
): Promise<AnalysisSignal[]> {
  const start = Date.now();
  const signals: AnalysisSignal[] = [];

  try {
    const { table, sourceWidth, sourceHeight } = calibration;
    const cropFilter = `crop=${table.width}:${table.height}:${table.x}:${table.y}`;

    const { stderr } = await execAsync(
      `ffmpeg -i "${videoPath}" -vf "${cropFilter},select='gt(scene,${threshold})',showinfo" -f null - 2>&1`,
      { timeout: 300000 }
    );

    const sceneLines = stderr.split("\n").filter((l) => l.includes("showinfo") && l.includes("pts_time:"));
    for (const line of sceneLines) {
      const timeMatch = line.match(/pts_time:(\d+\.?\d*)/);
      if (timeMatch) {
        signals.push({
          time: parseFloat(timeMatch[1]),
          type: "scene_change",
          value: 1.0,
        });
      }
    }
  } catch (err) {
    log(`Scene change analysis error (non-critical): ${err}`, "analyzer");
  }

  log(`analyzeSceneChanges took ${Date.now() - start}ms, found ${signals.length} changes`, "analyzer");
  return signals;
}

function clusterSignals(
  signals: AnalysisSignal[],
  minDuration: number,
  maxDuration: number,
  videoDuration: number
): ClipCandidate[] {
  if (signals.length === 0) return [];

  signals.sort((a, b) => a.time - b.time);

  const clusters: { signals: AnalysisSignal[]; center: number }[] = [];
  let currentCluster: AnalysisSignal[] = [signals[0]];

  for (let i = 1; i < signals.length; i++) {
    if (signals[i].time - signals[i - 1].time < maxDuration / 2) {
      currentCluster.push(signals[i]);
    } else {
      clusters.push({
        signals: [...currentCluster],
        center: currentCluster.reduce((sum, s) => sum + s.time, 0) / currentCluster.length,
      });
      currentCluster = [signals[i]];
    }
  }
  clusters.push({
    signals: [...currentCluster],
    center: currentCluster.reduce((sum, s) => sum + s.time, 0) / currentCluster.length,
  });

  const candidates: ClipCandidate[] = [];

  for (const cluster of clusters) {
    const center = cluster.center;
    const halfDuration = Math.min(maxDuration, Math.max(minDuration, cluster.signals.length * 5)) / 2;

    let clipStart = Math.max(0, center - halfDuration);
    let clipEnd = Math.min(videoDuration, center + halfDuration);

    if (clipEnd - clipStart < minDuration) {
      clipEnd = Math.min(videoDuration, clipStart + minDuration);
    }
    if (clipEnd - clipStart > maxDuration) {
      clipEnd = clipStart + maxDuration;
    }

    const signalTypes = new Set(cluster.signals.map((s) => s.type));
    const reasons: string[] = [];
    const signalValues: Record<string, number> = {};

    if (signalTypes.has("audio_peak")) {
      reasons.push("Всплеск звука");
      const audioPeaks = cluster.signals.filter((s) => s.type === "audio_peak");
      signalValues.audio_peak_count = audioPeaks.length;
      signalValues.audio_peak_max = Math.max(...audioPeaks.map((s) => s.value));
    }
    if (signalTypes.has("scene_change")) {
      reasons.push("Смена сцены за столом");
      const sceneChanges = cluster.signals.filter((s) => s.type === "scene_change");
      signalValues.scene_change_count = sceneChanges.length;
    }

    const confidence = Math.min(1.0, (cluster.signals.length * 0.15 + signalTypes.size * 0.2));

    candidates.push({
      startTime: Math.round(clipStart * 10) / 10,
      endTime: Math.round(clipEnd * 10) / 10,
      confidence: Math.round(confidence * 100) / 100,
      reasons,
      signals: signalValues,
    });
  }

  const deduplicated: ClipCandidate[] = [];
  for (const candidate of candidates) {
    const overlaps = deduplicated.some(
      (c) => candidate.startTime < c.endTime && candidate.endTime > c.startTime
    );
    if (!overlaps) {
      deduplicated.push(candidate);
    }
  }

  return deduplicated.sort((a, b) => b.confidence - a.confidence);
}

export async function analyzeVideo(
  videoPath: string,
  calibration: CalibrationData,
  thresholds: ThresholdsData | null
): Promise<ClipCandidate[]> {
  const totalStart = Date.now();
  log(`Starting analysis of ${videoPath}`, "analyzer");

  const t = thresholds || {
    audioRmsThreshold: 0.15,
    sceneChangeThreshold: 0.4,
    minClipDuration: 20,
    maxClipDuration: 60,
    ocrKeywordWeights: {},
  };

  const info = await getVideoInfo(videoPath);

  const [audioSignals, sceneSignals] = await Promise.all([
    analyzeAudioPeaks(videoPath, info.duration, t.audioRmsThreshold),
    analyzeSceneChanges(videoPath, calibration, t.sceneChangeThreshold),
  ]);

  const allSignals = [...audioSignals, ...sceneSignals];
  const candidates = clusterSignals(allSignals, t.minClipDuration, t.maxClipDuration, info.duration);

  log(`Analysis complete in ${Date.now() - totalStart}ms. Found ${candidates.length} candidates`, "analyzer");
  return candidates.slice(0, 40);
}
