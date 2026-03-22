import { exec, spawn, ChildProcess } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import { log } from "./index";

function debugLog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync("/tmp/export_debug.log", line);
  log(msg, "exporter");
}
import { isVpsConfigured, vpsExport, vpsDownloadExport, vpsExportProgress } from "./vps-client";
import type { CalibrationData, TranscriptSegment, WordTimestamp } from "@shared/schema";
const execAsync = promisify(exec);

export function scaleCalibration(
  calibration: CalibrationData,
  videoWidth: number,
  videoHeight: number
): CalibrationData {
  const { sourceWidth, sourceHeight } = calibration;
  if (!sourceWidth || !sourceHeight || (sourceWidth === videoWidth && sourceHeight === videoHeight)) {
    return calibration;
  }
  const sx = videoWidth / sourceWidth;
  const sy = videoHeight / sourceHeight;
  const scaleBox = (box: { x: number; y: number; width: number; height: number }) => ({
    x: Math.round(box.x * sx),
    y: Math.round(box.y * sy),
    width: Math.round(box.width * sx),
    height: Math.round(box.height * sy),
  });
  return {
    ...calibration,
    table: calibration.table ? scaleBox(calibration.table) : undefined,
    webcam: calibration.webcam ? scaleBox(calibration.webcam) : undefined,
    chat: calibration.chat ? scaleBox(calibration.chat) : undefined,
    sourceWidth: videoWidth,
    sourceHeight: videoHeight,
  };
}

interface ActiveExport {
  process?: ChildProcess;
  cancelled: boolean;
}

const activeExports = new Map<string, ActiveExport>();

export function cancelExport(jobId: string): boolean {
  const entry = activeExports.get(jobId);
  if (entry) {
    entry.cancelled = true;
    if (entry.process) {
      killProcessGroup(entry.process);
    }
    activeExports.delete(jobId);
    log(`Export ${jobId} cancelled by user — process group killed`, "exporter");
    return true;
  }
  return false;
}

export function isExportActive(jobId: string): boolean {
  return activeExports.has(jobId);
}

function isCancelled(jobId?: string): boolean {
  if (!jobId) return false;
  const entry = activeExports.get(jobId);
  return entry ? entry.cancelled : true;
}

function killProcessGroup(proc: ChildProcess) {
  try {
    if (proc.pid) {
      process.kill(-proc.pid, "SIGKILL");
    }
  } catch {
    try { proc.kill("SIGKILL"); } catch {}
  }
}

function runFfmpegWithCancel(cmd: string, jobId?: string, timeoutMs = 3600000): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("sh", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"], detached: true });
    let done = false;
    
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      err ? reject(err) : resolve();
    };

    const timer = setTimeout(() => {
      killProcessGroup(proc);
      finish(new Error("Export timed out after " + Math.round(timeoutMs / 60000) + " minutes"));
    }, timeoutMs);
    
    if (jobId) {
      const entry = activeExports.get(jobId);
      if (entry) {
        entry.process = proc;
        if (entry.cancelled) {
          killProcessGroup(proc);
          return finish(new Error("Export cancelled by user"));
        }
      }
    }

    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      if (jobId) {
        const entry = activeExports.get(jobId);
        if (entry) entry.process = undefined;
        if (!entry || entry.cancelled) {
          return finish(new Error("Export cancelled by user"));
        }
      }
      if (code === 0) {
        finish();
      } else {
        const lastLines = stderr.split("\n").slice(-5).join("\n");
        finish(new Error(`FFmpeg exited with code ${code}: ${lastLines}`));
      }
    });

    proc.on("error", (err) => finish(err));
  });
}

interface ExportOptions {
  videoPath: string;
  outputPath: string;
  startTime: number;
  endTime: number;
  calibration: CalibrationData;
  subtitlesEnabled?: boolean;
  transcriptSegments?: TranscriptSegment[];
  vpsVideoId?: string;
  isPreview?: boolean;
  muteAudio?: boolean;
  bleepProfanity?: boolean;
  aspectRatio?: "9:16" | "1:1";
  contentType?: string;
  uniqualize?: boolean;
  filterPreset?: "subtle" | "medium" | "strong";
  videoFilter?: string;
  resolution?: string;
  crawlText?: string;
  bgAudioFilename?: string;
  bgAudioVolume?: number;
  musicStartOffset?: number;
  voiceVolume?: number;
  musicDropTime?: number;
  musicDropVolumeBefore?: number;
  captionPositionY?: number;
  subtitleOffsetMs?: number;
  captionStyle?: string;
  renderEngine?: "vps" | "runpod";
  cameraKeyframes?: Array<{ time: number; cropX: number; cropY: number; cropW: number; cropH: number; target: string; cut?: boolean; transitionDuration?: number }>;
  onProgress?: (percent: number) => void;
  _inputHeaders?: string;
  jobId?: string;
}

interface PhraseWithWords {
  start: number;
  end: number;
  text: string;
  wordTimings?: WordTimestamp[];
}

function cleanWord(w: string): string {
  return w.replace(/[\/\\]/g, "").replace(/[-–—]/g, "").trim();
}

const PROFANITY_STEMS = [
  "бля", "блят", "блядь", "блядин", "блядск", "блядов", "блядун", "блядюг",
  "ебат", "ебан", "ебну", "ебло", "ебал", "ебёт", "ебет", "ебуч", "ебашь", "ебаш",
  "ёб", "ёбан", "ёбт", "еб",
  "хуй", "хуя", "хуе", "хуё", "хуи", "хуёв", "хуев", "хуяр", "хуяч", "хуил", "хуяс",
  "нахуй", "нахуя", "нахер", "нахрен",
  "похуй", "похер",
  "охуе", "охуё", "охуи",
  "отхуяр", "отхуяч", "отхуяс",
  "прихуе", "прихуё",
  "захуяр", "захуяч",
  "расхуяр", "расхуяч",
  "исхуяр",
  "пизд", "пизда", "пиздец", "пиздат", "пиздан", "пиздюк", "пиздюл",
  "пиздан", "распизд", "напизд", "опизд", "спизд",
  "сука", "суки", "сучк", "сучар", "сучон",
  "мудак", "мудач", "мудил", "мудозвон",
  "заеб", "заёб", "долбоёб", "долбоеб", "уёб", "уеб", "выеб", "наеб", "наёб", "объеб", "объёб", "отъеб", "отъёб", "проеб", "проёб",
  "пидор", "пидар", "пидр", "педик", "пидорас",
  "шлюх", "шалав",
  "жоп",
  "дерьм",
  "fuck", "shit", "bitch", "cunt", "dick", "asshole",
  "казино", "казин",
  "лудоман", "лудик",
  "ставк", "ставок",
  "слот", "слоты",
  "букмекер",
  "гемблинг",
  "gambling", "casino",
];

const PROFANITY_ROOTS = ["хуй", "хуя", "хуе", "хуи", "хуев", "пизд", "ебал", "ебат", "ебан", "ебуч", "ебаш", "ебло", "ебну", "ебет"];

function isProfanityWord(word: string): boolean {
  const lower = word.toLowerCase().replace(/[ё]/g, "е").replace(/[\/\\–—\-]/g, "").trim();
  if (lower.length <= 1) return false;
  for (const stem of PROFANITY_STEMS) {
    const normalizedStem = stem.toLowerCase().replace(/[ё]/g, "е");
    if (lower.startsWith(normalizedStem) || lower === normalizedStem) return true;
  }
  for (const root of PROFANITY_ROOTS) {
    const nr = root.toLowerCase().replace(/[ё]/g, "е");
    if (lower.includes(nr)) return true;
  }
  return false;
}

interface BleepInterval {
  start: number;
  end: number;
}

function findProfanityIntervals(segments: TranscriptSegment[], clipStart: number, clipEnd: number): BleepInterval[] {
  const raw: BleepInterval[] = [];
  for (const seg of segments) {
    if (seg.end < clipStart || seg.start > clipEnd) continue;
    if (!seg.words) continue;
    for (const w of seg.words) {
      if (w.start == null || w.end == null) continue;
      if (w.end < clipStart || w.start > clipEnd) continue;
      const cleaned = cleanWord(w.word);
      if (cleaned.length > 1 && isProfanityWord(cleaned)) {
        const relStart = Math.max(0, w.start - clipStart - 0.06);
        const relEnd = w.end - clipStart + 0.06;
        raw.push({ start: relStart, end: relEnd });
      }
    }
  }
  if (raw.length === 0) return raw;
  raw.sort((a, b) => a.start - b.start);
  const merged: BleepInterval[] = [{ ...raw[0] }];
  for (let i = 1; i < raw.length; i++) {
    const last = merged[merged.length - 1];
    if (raw[i].start <= last.end + 0.05) {
      last.end = Math.max(last.end, raw[i].end);
    } else {
      merged.push({ ...raw[i] });
    }
  }
  return merged;
}

const BLEEP_SOUND_PATH = path.join(process.cwd(), "server", "assets", "bleep_quack.mp3");
const BLEEP_SOUND_DURATION = 0.720;

function buildBleepAudioFilter(intervals: BleepInterval[], duration: number, outputLabel?: string): string | null {
  if (intervals.length === 0) return null;
  const out = outputLabel || "ableeped";
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  const concatLabels: string[] = [];
  let prevEnd = 0;
  for (let i = 0; i < sorted.length; i++) {
    const iv = sorted[i];
    if (iv.start > prevEnd + 0.001) {
      const sLabel = `_bs${i}`;
      parts.push(`[0:a]atrim=${prevEnd.toFixed(3)}:${iv.start.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono[${sLabel}]`);
      concatLabels.push(`[${sLabel}]`);
    }
    const bDur = Math.max(0.01, iv.end - iv.start);
    const bLabel = `_bb${i}`;
    const fadeDur = Math.min(0.015, bDur / 4);
    parts.push(`sine=frequency=480:sample_rate=48000:d=${bDur.toFixed(3)},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono,volume=0.18,afade=t=in:d=${fadeDur.toFixed(4)},afade=t=out:st=${(bDur - fadeDur).toFixed(4)}:d=${fadeDur.toFixed(4)}[${bLabel}]`);
    concatLabels.push(`[${bLabel}]`);
    prevEnd = iv.end;
  }
  if (prevEnd < duration - 0.001) {
    const sLabel = `_bsF`;
    parts.push(`[0:a]atrim=${prevEnd.toFixed(3)}:${duration.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono[${sLabel}]`);
    concatLabels.push(`[${sLabel}]`);
  }
  parts.push(`${concatLabels.join("")}concat=n=${concatLabels.length}:v=0:a=1[${out}]`);
  return parts.join(";");
}

function splitSegmentIntoPhrases(seg: TranscriptSegment, maxWords: number = 5): PhraseWithWords[] {
  if (seg.words && seg.words.length > 0) {
    const validWords = seg.words.filter(w => cleanWord(w.word).length > 0);
    if (validWords.length === 0) return [];

    const phrases: PhraseWithWords[] = [];
    for (let i = 0; i < validWords.length; i += maxWords) {
      const chunk = validWords.slice(i, i + maxWords);
      phrases.push({
        start: chunk[0].start,
        end: chunk[chunk.length - 1].end,
        text: chunk.map(w => cleanWord(w.word)).join(" "),
        wordTimings: chunk,
      });
    }
    return phrases;
  }

  const text = seg.text.replace(/[\/\\]/g, "").replace(/\s*[-–—]\s*/g, " ").replace(/\s+/g, " ").trim();
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];

  const segDuration = seg.end - seg.start;
  const phrases: string[] = [];
  for (let i = 0; i < words.length; i += maxWords) {
    phrases.push(words.slice(i, i + maxWords).join(" "));
  }

  const phraseDuration = segDuration / phrases.length;
  return phrases.map((p, i) => ({
    start: seg.start + i * phraseDuration,
    end: seg.start + (i + 1) * phraseDuration,
    text: p,
  }));
}

async function enrichSegmentsWithWordTimings(
  segments: TranscriptSegment[],
  clipStart: number,
  clipEnd: number,
  vpsVideoId?: string
): Promise<TranscriptSegment[]> {
  const clipSegments = segments.filter(
    (s) => s.end > clipStart && s.start < clipEnd && s.text.trim().length > 0
  );

  const hasWordTimings = clipSegments.some(s => s.words && s.words.length > 0);
  if (hasWordTimings) {
    log(`Segments already have word timings, skipping enrichment`, "exporter");
    return segments;
  }

  if (!vpsVideoId || !isVpsConfigured()) {
    log(`No VPS available for word timing enrichment, using fallback`, "exporter");
    return segments;
  }

  try {
    log(`Enriching word timings for clip ${clipStart}-${clipEnd}s via WhisperX forced alignment...`, "exporter");

    const { vpsAlignClip } = await import("./vps-client");

    const inputSegments = clipSegments.map(s => ({
      start: s.start,
      end: s.end,
      text: s.text,
    }));

    const alignedSegments = await vpsAlignClip(vpsVideoId, clipStart, clipEnd, inputSegments);

    if (!alignedSegments || alignedSegments.length === 0) {
      log(`WhisperX returned no aligned segments`, "exporter");
      return segments;
    }

    const enriched = segments.map(seg => {
      if (seg.end <= clipStart || seg.start >= clipEnd) return seg;
      if (seg.text.trim().length === 0) return seg;

      const matched = alignedSegments.find(a =>
        Math.abs(a.start - seg.start) < 1.0 && Math.abs(a.end - seg.end) < 1.0
      );

      if (!matched || !matched.words || matched.words.length === 0) return seg;

      const words: WordTimestamp[] = matched.words.map(w => ({
        word: w.word,
        start: w.start,
        end: w.end,
      }));

      return { ...seg, words };
    });

    const enrichedCount = enriched.filter(s => s.words && s.words.length > 0 && s.end > clipStart && s.start < clipEnd).length;
    const totalWords = enriched.reduce((sum, s) => sum + (s.words?.length || 0), 0);
    log(`WhisperX alignment done: ${enrichedCount}/${clipSegments.length} segments enriched, ${totalWords} words total`, "exporter");

    return enriched;
  } catch (err: any) {
    log(`WhisperX alignment failed: ${err.message}, using fallback`, "exporter");
    return segments;
  }
}

function generateAssFile(
  segments: TranscriptSegment[],
  clipStart: number,
  clipEnd: number,
  outputPath: string,
  resWidth: number,
  resHeight: number
): string {
  const filtered = segments.filter(
    (s) => s.end > clipStart && s.start < clipEnd && s.text.trim().length > 0
  );

  const allPhrases: PhraseWithWords[] = [];
  for (const seg of filtered) {
    const phrases = splitSegmentIntoPhrases(seg, 5);
    for (const p of phrases) {
      if (p.end > clipStart && p.start < clipEnd) {
        allPhrases.push(p);
      }
    }
  }

  const scale = resWidth / 1080;
  const fontSize = Math.round(82 * scale);
  const marginV = Math.round(160 * scale);
  const outline = Math.round(5 * scale);
  const shadow = Math.round(2 * scale);
  const marginLR = Math.round(20 * scale);

  const assHeader = `[Script Info]
Title: Poker Shorts Subtitles
ScriptType: v4.00+
PlayResX: ${resWidth}
PlayResY: ${resHeight}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Montserrat Black,${fontSize},&H0000DFFF,&H00FFFFFF,&H00000000,&HAA000000,-1,0,0,0,100,100,0,0,1,${outline},${shadow},2,${marginLR},${marginLR},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const formatAssTime = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const cs = Math.round((seconds % 1) * 100);
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
  };

  let events = "";
  for (const phrase of allPhrases) {
    const relStart = Math.max(0, phrase.start - clipStart);
    const relEnd = Math.min(clipEnd - clipStart, phrase.end - clipStart);

    if (phrase.wordTimings && phrase.wordTimings.length > 0) {
      const karaokeText = phrase.wordTimings.map((wt) => {
        const wordStart = Math.max(0, wt.start - clipStart);
        const wordEnd = Math.min(clipEnd - clipStart, wt.end - clipStart);
        const durCs = Math.max(1, Math.round((wordEnd - wordStart) * 100));
        const cleaned = cleanWord(wt.word);
        if (cleaned.length === 0) return "";
        return `{\\kf${durCs}}${cleaned}`;
      }).filter(t => t.length > 0).join(" ");

      if (karaokeText.length > 0) {
        events += `Dialogue: 0,${formatAssTime(relStart)},${formatAssTime(relEnd)},Default,,0,0,0,,${karaokeText}\n`;
      }
    } else {
      let cleanText = phrase.text.replace(/[\/\\]/g, "").replace(/[-–—]/g, "").replace(/\n/g, " ").trim();
      if (cleanText.length === 0) continue;

      const words = cleanText.split(/\s+/);
      const phraseDurCs = Math.round((relEnd - relStart) * 100);
      const wordDurCs = Math.max(1, Math.round(phraseDurCs / words.length));
      const karaokeText = words.map((w, i) => {
        const dur = (i === words.length - 1) ? (phraseDurCs - wordDurCs * i) : wordDurCs;
        return `{\\kf${dur}}${w}`;
      }).join(" ");

      events += `Dialogue: 0,${formatAssTime(relStart)},${formatAssTime(relEnd)},Default,,0,0,0,,${karaokeText}\n`;
    }
  }

  const content = assHeader + events;
  fs.writeFileSync(outputPath, content, "utf-8");
  return outputPath;
}

async function exportViaVps(options: ExportOptions): Promise<void> {
  const {
    outputPath,
    startTime,
    endTime,
    calibration,
    subtitlesEnabled,
    transcriptSegments,
    vpsVideoId,
    isPreview,
    aspectRatio,
  } = options;

  if (!vpsVideoId) {
    throw new Error("vpsVideoId required for VPS export");
  }

  debugLog(`VPS export${isPreview ? " (preview)" : ""}: ${vpsVideoId} (${startTime}-${endTime}s), aspectRatio=${aspectRatio || "9:16"}, bleepProfanity=${options.bleepProfanity}, muteAudio=${options.muteAudio}`);

  options.onProgress?.(30);

  const clipId = path.basename(outputPath, ".mp4");

  let enrichedSubSegments: TranscriptSegment[] | undefined;
  const needSegments = subtitlesEnabled || options.bleepProfanity;
  debugLog(`needSegments=${needSegments} (subtitlesEnabled=${subtitlesEnabled}, bleepProfanity=${options.bleepProfanity}), hasTranscriptSegments=${!!(transcriptSegments?.length)}, segCount=${transcriptSegments?.length || 0}`);
  if (needSegments && transcriptSegments) {
    enrichedSubSegments = await enrichSegmentsWithWordTimings(transcriptSegments, startTime, endTime, vpsVideoId);
    debugLog(`enrichedSubSegments count=${enrichedSubSegments?.length || 0}, first seg words=${enrichedSubSegments?.[0]?.words?.length || 0}`);
  }

  options.onProgress?.(40);

  let pollInterval: ReturnType<typeof setInterval> | null = null;
  const useOverlay = options.contentType !== "streamer";

  const segmentsToSend = needSegments && enrichedSubSegments ? enrichedSubSegments : undefined;
  debugLog(`Sending to VPS: bleepProfanity=${options.bleepProfanity}, subtitleSegments=${segmentsToSend?.length || 0}, muteAudio=${options.muteAudio}`);
  if (segmentsToSend && options.bleepProfanity) {
    const wordsWithTimings = segmentsToSend.flatMap(s => (s.words || []).filter(w => w.start != null));
    debugLog(`Word timings available: ${wordsWithTimings.length} words total, sample: ${JSON.stringify(wordsWithTimings.slice(0, 5))}`);
  }

  const exportPromise = vpsExport({
    videoId: vpsVideoId,
    startTime,
    endTime,
    calibration,
    clipId,
    subtitleSegments: segmentsToSend,
    subtitlesEnabled,
    isPreview,
    muteAudio: options.muteAudio,
    bleepProfanity: options.bleepProfanity,
    aspectRatio: aspectRatio || "9:16",
    useOverlay,
    contentType: options.contentType,
    uniqualize: options.uniqualize,
    filterPreset: options.filterPreset,
    videoFilter: options.videoFilter,
    resolution: options.resolution,
    crawlText: options.crawlText,
    bgAudioFilename: options.bgAudioFilename,
    bgAudioVolume: options.bgAudioVolume,
    musicStartOffset: options.musicStartOffset,
    voiceVolume: options.voiceVolume,
    musicDropTime: options.musicDropTime,
    musicDropVolumeBefore: options.musicDropVolumeBefore,
    captionPositionY: options.captionPositionY,
    subtitleOffsetMs: options.subtitleOffsetMs,
    captionStyle: options.captionStyle,
    renderEngine: options.renderEngine,
    cameraKeyframes: options.cameraKeyframes,
  });

  pollInterval = setInterval(async () => {
    try {
      const prog = await vpsExportProgress(vpsVideoId, clipId);
      if (prog.active && prog.percent > 0) {
        const mapped = 40 + Math.round(prog.percent * 0.55);
        options.onProgress?.(Math.min(mapped, 94));
      }
    } catch {}
  }, 800);

  let result: { exportId: string; sizeBytes: number };
  try {
    result = await exportPromise;
  } finally {
    if (pollInterval) clearInterval(pollInterval);
  }

  options.onProgress?.(95);
  log(`VPS FFmpeg done, downloading ${(result.sizeBytes / 1024 / 1024).toFixed(1)}MB...`, "exporter");

  await vpsDownloadExport(vpsVideoId, result.exportId, outputPath, (downloaded, total) => {
    const dlPct = Math.round((downloaded / total) * 100);
    const mapped = 95 + Math.round(dlPct * 0.04);
    options.onProgress?.(Math.min(mapped, 99));
  });
  options.onProgress?.(99);
  log(`VPS export downloaded: ${(result.sizeBytes / 1024 / 1024).toFixed(1)}MB → ${outputPath}`, "exporter");
}

const BG_FRAME_SPECS = {
  designW: 900,
  designH: 1600,
  frameLeft: 12,
  bottomFrameLeft: 12,
  frameRight: 886,
  topFrameTop: 236,
  topFrameBottom: 827,
  bottomFrameTop: 861,
  bottomFrameBottom: 1452,
};

function getFrameLayout(outW: number, outH: number) {
  const sx = outW / BG_FRAME_SPECS.designW;
  const sy = outH / BG_FRAME_SPECS.designH;

  const pad = 2;
  const frameX = Math.max(0, Math.floor(BG_FRAME_SPECS.frameLeft * sx) - pad);
  const botFrameX = Math.max(0, Math.floor(BG_FRAME_SPECS.bottomFrameLeft * sx) - pad);
  const topY = Math.max(0, Math.floor(BG_FRAME_SPECS.topFrameTop * sy) - pad);
  const botY = Math.max(0, Math.floor(BG_FRAME_SPECS.bottomFrameTop * sy) - pad);

  const topRight = Math.min(outW, Math.ceil(BG_FRAME_SPECS.frameRight * sx) + pad);
  const botRight = Math.min(outW, Math.ceil(BG_FRAME_SPECS.frameRight * sx) + pad);
  const topBottom = Math.min(outH, Math.ceil(BG_FRAME_SPECS.topFrameBottom * sy) + pad);
  const botBottom = Math.min(outH, Math.ceil(BG_FRAME_SPECS.bottomFrameBottom * sy) + pad);

  let frameW = topRight - frameX;
  let botFrameW = botRight - botFrameX;
  let topH = topBottom - topY;
  let botH = botBottom - botY;

  frameW = frameW % 2 === 0 ? frameW : frameW + 1;
  botFrameW = botFrameW % 2 === 0 ? botFrameW : botFrameW + 1;
  topH = topH % 2 === 0 ? topH : topH + 1;
  botH = botH % 2 === 0 ? botH : botH + 1;

  return { frameX, botFrameX, frameW, botFrameW, topY, topH, botY, botH };
}

async function exportLocal(options: ExportOptions): Promise<void> {
  const {
    videoPath,
    outputPath,
    startTime,
    endTime,
    calibration,
    subtitlesEnabled,
    transcriptSegments,
    isPreview,
    aspectRatio,
  } = options;

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const { table, webcam } = calibration;
  const duration = endTime - startTime;

  if (!table && !webcam) {
    throw new Error("At least one calibration region (table or webcam) is required");
  }
  if (table && (table.width < 10 || table.height < 10)) {
    throw new Error("Table crop region too small (min 10px)");
  }
  if (webcam && (webcam.width < 10 || webcam.height < 10)) {
    throw new Error("Webcam crop region too small (min 10px)");
  }

  if (isPreview) {
    const isSquarePrev = aspectRatio === "1:1";
    const prevW = 540;
    const prevH = isSquarePrev ? 540 : 960;
    const isSinglePrev = (!!table) !== (!!webcam);
    const singlePrev = table || webcam;

    let filterComplex: string;
    if (isSinglePrev && singlePrev) {
      filterComplex = `[0:v]crop=${singlePrev.width}:${singlePrev.height}:${singlePrev.x}:${singlePrev.y},scale=${prevW}:${prevH}:force_original_aspect_ratio=increase:flags=bilinear,crop=${prevW}:${prevH},setsar=1[out]`;
    } else {
      const tableH = Math.round(prevH * 0.55);
      const webcamH = prevH - tableH;
      filterComplex = [
        `[0:v]crop=${table!.width}:${table!.height}:${table!.x}:${table!.y},scale=${prevW}:${tableH}:force_original_aspect_ratio=increase:flags=bilinear,crop=${prevW}:${tableH},setsar=1[tcrop]`,
        `[0:v]crop=${webcam!.width}:${webcam!.height}:${webcam!.x}:${webcam!.y},scale=${prevW}:${webcamH}:force_original_aspect_ratio=increase:flags=bilinear,crop=${prevW}:${webcamH},setsar=1[wcrop]`,
        `[tcrop][wcrop]vstack=inputs=2[out]`,
      ].join(";");
    }

    log(`Export (preview) fast render: ${startTime}-${endTime}s → ${prevW}x${prevH}`, "exporter");
    const cmd = `ffmpeg -ss ${startTime} -i "${videoPath}" -t ${duration} -filter_complex "${filterComplex}" -map "[out]" -map "0:a?" -c:v libx264 -preset ultrafast -tune zerolatency -crf 35 -pix_fmt yuv420p -c:a aac -b:a 48k -r 15 -movflags +faststart -y "${outputPath}"`;
    log(`Preview cmd: ${cmd}`, "exporter");
    await new Promise<void>((resolve, reject) => {
      exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, _stdout, stderr) => {
        if (err) reject(new Error(`Preview render failed: ${stderr?.slice(-500)}`));
        else resolve();
      });
    });
    log(`Preview done`, "exporter");
    return;
  }

  const isSingleRegion = (!!table) !== (!!webcam);
  const singleBox = table || webcam;

  let enrichedForBleep = transcriptSegments;
  if (options.bleepProfanity && transcriptSegments) {
    const hasWords = transcriptSegments.some(s => s.words && s.words.length > 0);
    if (!hasWords) {
      enrichedForBleep = await enrichSegmentsWithWordTimings(transcriptSegments, startTime, endTime, options.vpsVideoId);
    }
  }
  const bleepIntervals = options.bleepProfanity && enrichedForBleep
    ? findProfanityIntervals(enrichedForBleep, startTime, endTime)
    : [];
  if (bleepIntervals.length > 0) {
    log(`[bleep] Found ${bleepIntervals.length} profanity interval(s) to censor`, "exporter");
  } else if (options.bleepProfanity) {
    log(`[bleep] Profanity bleeping enabled but no intervals found (no word timings?)`, "exporter");
  }

  const isSquare = aspectRatio === "1:1";
  const outW = 1080;
  const outH = isSquare ? outW : 1920;

  const bgFramePath = path.join(process.cwd(), "private_uploads", "bg_frame.png");
  const hasBg = fs.existsSync(bgFramePath);

  const scaleFlags = "lanczos";

  const SEEK_BUFFER = 3;
  const fastSeek = Math.max(0, startTime - SEEK_BUFFER);
  const fineSeek = startTime - fastSeek;
  const fineSeekArg = fineSeek > 0 ? `-ss ${fineSeek} ` : "";

  let inputCount = 0;
  const headerArg = options._inputHeaders ? `-headers "${options._inputHeaders}\r\n" ` : "";
  const inputArgs: string[] = [`${headerArg}-ss ${fastSeek} -i "${videoPath}" ${fineSeekArg}`.trim()];
  inputCount++;

  if (isSingleRegion && singleBox) {
    log(`Export${isPreview ? " (preview)" : ""} single-region mode: ${table ? "table" : "webcam"} ${singleBox.width}x${singleBox.height} → ${outW}x${outH}`, "exporter");

    let filterComplex = [
      `[0:v]crop=${singleBox.width}:${singleBox.height}:${singleBox.x}:${singleBox.y},scale=${outW}:${outH}:force_original_aspect_ratio=increase:flags=${scaleFlags},crop=${outW}:${outH},setsar=1[cropped]`,
    ];

    let lastLabel = "cropped";

    let assPath: string | null = null;
    if (subtitlesEnabled && transcriptSegments && transcriptSegments.length > 0) {
      const tmpDir = path.join(process.cwd(), "private_exports");
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      assPath = path.join(tmpDir, `subs_${Date.now()}.ass`);
      generateAssFile(await enrichSegmentsWithWordTimings(transcriptSegments, startTime, endTime, options.vpsVideoId), startTime, endTime, assPath, outW, outH);
      const escapedPath = assPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\''");
      filterComplex.push(`[${lastLabel}]ass='${escapedPath}'[subbed]`);
      lastLabel = "subbed";
    }

    filterComplex.push(`[${lastLabel}]null[out]`);

    const preset = "ultrafast";
    const crf = isPreview ? 32 : 23;
    const audioBitrate = isPreview ? "64k" : "128k";

    const bleepFilter = bleepIntervals.length > 0 ? buildBleepAudioFilter(bleepIntervals, duration) : null;
    if (bleepFilter) {
      filterComplex.push(bleepFilter);
    }

    const cmdParts = [
      `ffmpeg ${inputArgs.join(" ")}`,
      `-filter_complex "${filterComplex.join(";")}"`,
      options.muteAudio ? `-map "[out]"` : bleepFilter ? `-map "[out]" -map "[ableeped]"` : `-map "[out]" -map 0:a?`,
      `-t ${duration}`,
      `-c:v libx264 -preset ${preset} -crf ${crf} -pix_fmt yuv420p`,
    ];
    if (isPreview) cmdParts.push(`-r 15`);
    if (options.muteAudio) {
      cmdParts.push(`-an`);
    } else if (bleepFilter) {
      cmdParts.push(
        `-c:a aac -b:a ${audioBitrate}`,
      );
    } else {
      cmdParts.push(
        `-af "loudnorm=I=-14:TP=-1:LRA=11"`,
        `-c:a aac -b:a ${audioBitrate}`,
      );
    }
    cmdParts.push(
      `-movflags +faststart`,
      `-y "${outputPath}"`,
    );
    const cmd = cmdParts.join(" ");

    log(`Export command: ${cmd}`, "exporter");

    try {
      await runFfmpegWithCancel(cmd, options.jobId);
      log(`Export completed: ${outputPath}`, "exporter");
    } catch (err: any) {
      log(`Export error: ${err.message}`, "exporter");
      throw err;
    } finally {
      if (assPath && fs.existsSync(assPath)) {
        try { fs.unlinkSync(assPath); } catch {}
      }
    }
    return;
  }

  const tbl = table!;
  const cam = webcam!;

  if (hasBg && !isSquare) {
    const layout = getFrameLayout(outW, outH);

    log(`Export${isPreview ? " (preview)" : ""} bg_frame layout: frames ${layout.frameW}x${layout.topH} at (${layout.frameX},${layout.topY}) and (${layout.botFrameX},${layout.botY})`, "exporter");

    inputArgs.push(`-loop 1 -i "${bgFramePath}"`);
    inputCount++;

    const filterComplex: string[] = [
      `color=c=black:s=${outW}x${outH}:r=30,format=yuv420p[canvas]`,
      `[0:v]crop=${tbl.width}:${tbl.height}:${tbl.x}:${tbl.y},scale=${layout.frameW}:${layout.topH}:force_original_aspect_ratio=increase:flags=${scaleFlags},crop=${layout.frameW}:${layout.topH},setsar=1[tcrop]`,
      `[0:v]crop=${cam.width}:${cam.height}:${cam.x}:${cam.y},scale=${layout.botFrameW}:${layout.botH}:force_original_aspect_ratio=increase:flags=${scaleFlags},crop=${layout.botFrameW}:${layout.botH},setsar=1[wcrop]`,
      `[canvas][tcrop]overlay=${layout.frameX}:${layout.topY}[v1]`,
      `[v1][wcrop]overlay=${layout.botFrameX}:${layout.botY}[v2]`,
      `[1:v]scale=${outW}:${outH}:flags=${scaleFlags},format=rgba,setsar=1[frame]`,
      `[v2][frame]overlay=0:0:shortest=1[composed]`,
    ];

    let lastLabel = "composed";

    let assPath: string | null = null;
    if (subtitlesEnabled && transcriptSegments && transcriptSegments.length > 0) {
      const tmpDir = path.join(process.cwd(), "private_exports");
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      assPath = path.join(tmpDir, `subs_${Date.now()}.ass`);
      generateAssFile(await enrichSegmentsWithWordTimings(transcriptSegments, startTime, endTime, options.vpsVideoId), startTime, endTime, assPath, outW, outH);
      const escapedPath = assPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\''");
      filterComplex.push(`[${lastLabel}]ass='${escapedPath}'[subbed]`);
      lastLabel = "subbed";
    }

    filterComplex.push(`[${lastLabel}]null[out]`);

    const bleepFilter2 = bleepIntervals.length > 0 ? buildBleepAudioFilter(bleepIntervals, duration) : null;
    if (bleepFilter2) filterComplex.push(bleepFilter2);

    const preset = "ultrafast";
    const crf = isPreview ? 32 : 23;
    const audioBitrate = isPreview ? "64k" : "128k";

    const cmdParts = [
      `ffmpeg ${inputArgs.join(" ")}`,
      `-filter_complex "${filterComplex.join(";")}"`,
      options.muteAudio ? `-map "[out]"` : bleepFilter2 ? `-map "[out]" -map "[ableeped]"` : `-map "[out]" -map 0:a?`,
      `-t ${duration}`,
      `-c:v libx264 -preset ${preset} -crf ${crf} -pix_fmt yuv420p`,
    ];
    if (isPreview) cmdParts.push(`-r 15`);
    if (options.muteAudio) {
      cmdParts.push(`-an`);
    } else if (bleepFilter2) {
      cmdParts.push(`-c:a aac -b:a ${audioBitrate}`);
    } else {
      cmdParts.push(
        `-af "loudnorm=I=-14:TP=-1:LRA=11"`,
        `-c:a aac -b:a ${audioBitrate}`,
      );
    }
    cmdParts.push(
      `-movflags +faststart`,
      `-y "${outputPath}"`,
    );
    const cmd = cmdParts.join(" ");

    log(`Export command: ${cmd}`, "exporter");

    try {
      await runFfmpegWithCancel(cmd, options.jobId);
      log(`Export completed: ${outputPath}`, "exporter");
    } catch (err: any) {
      log(`Export error: ${err.message}`, "exporter");
      throw err;
    } finally {
      if (assPath && fs.existsSync(assPath)) {
        try { fs.unlinkSync(assPath); } catch {}
      }
    }
  } else {
    const tableNatH = Math.round(outW * tbl.height / tbl.width);
    const webcamNatH = Math.round(outW * cam.height / cam.width);
    const totalNatH = tableNatH + webcamNatH;

    let tableH: number;
    let webcamH: number;
    if (totalNatH <= outH) {
      tableH = tableNatH;
      webcamH = webcamNatH;
    } else {
      tableH = Math.round(outH * (tableNatH / totalNatH));
      webcamH = outH - tableH;
    }
    tableH = Math.max(100, tableH % 2 === 0 ? tableH : tableH + 1);
    webcamH = Math.max(100, webcamH % 2 === 0 ? webcamH : webcamH + 1);

    log(`Export${isPreview ? " (preview)" : ""} ${isSquare ? "1:1" : "fallback"} layout: table=${tbl.width}x${tbl.height} → ${outW}x${tableH}, webcam=${cam.width}x${cam.height} → ${outW}x${webcamH}`, "exporter");

    let filterComplex = [
      `[0:v]crop=${tbl.width}:${tbl.height}:${tbl.x}:${tbl.y},scale=${outW}:${tableH}:force_original_aspect_ratio=increase:flags=${scaleFlags},crop=${outW}:${tableH},setsar=1[table]`,
      `[0:v]crop=${cam.width}:${cam.height}:${cam.x}:${cam.y},scale=${outW}:${webcamH}:force_original_aspect_ratio=increase:flags=${scaleFlags},crop=${outW}:${webcamH},setsar=1[webcam]`,
      `[table][webcam]vstack=inputs=2,scale=${outW}:${outH}:force_original_aspect_ratio=increase:flags=${scaleFlags},crop=${outW}:${outH},setsar=1[stacked]`,
    ];

    let lastLabel = "stacked";

    let assPath: string | null = null;
    if (subtitlesEnabled && transcriptSegments && transcriptSegments.length > 0) {
      const tmpDir = path.join(process.cwd(), "private_exports");
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      assPath = path.join(tmpDir, `subs_${Date.now()}.ass`);
      generateAssFile(await enrichSegmentsWithWordTimings(transcriptSegments, startTime, endTime, options.vpsVideoId), startTime, endTime, assPath, outW, outH);
      const escapedPath = assPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\''");
      filterComplex.push(`[${lastLabel}]ass='${escapedPath}'[subbed]`);
      lastLabel = "subbed";
    }

    filterComplex.push(`[${lastLabel}]null[out]`);

    const bleepFilter3 = bleepIntervals.length > 0 ? buildBleepAudioFilter(bleepIntervals, duration) : null;
    if (bleepFilter3) filterComplex.push(bleepFilter3);

    const preset = "ultrafast";
    const crf = isPreview ? 32 : 23;
    const audioBitrate = isPreview ? "64k" : "128k";

    const cmdParts = [
      `ffmpeg ${inputArgs.join(" ")}`,
      `-filter_complex "${filterComplex.join(";")}"`,
      options.muteAudio ? `-map "[out]"` : bleepFilter3 ? `-map "[out]" -map "[ableeped]"` : `-map "[out]" -map 0:a?`,
      `-t ${duration}`,
      `-c:v libx264 -preset ${preset} -crf ${crf} -pix_fmt yuv420p`,
    ];
    if (isPreview) cmdParts.push(`-r 15`);
    if (options.muteAudio) {
      cmdParts.push(`-an`);
    } else if (bleepFilter3) {
      cmdParts.push(`-c:a aac -b:a ${audioBitrate}`);
    } else {
      cmdParts.push(
        `-af "loudnorm=I=-14:TP=-1:LRA=11"`,
        `-c:a aac -b:a ${audioBitrate}`,
      );
    }
    cmdParts.push(
      `-movflags +faststart`,
      `-y "${outputPath}"`,
    );
    const cmd = cmdParts.join(" ");

    log(`Export command: ${cmd}`, "exporter");

    try {
      await runFfmpegWithCancel(cmd, options.jobId);
      log(`Export completed: ${outputPath}`, "exporter");
    } catch (err: any) {
      log(`Export error: ${err.message}`, "exporter");
      throw err;
    } finally {
      if (assPath && fs.existsSync(assPath)) {
        try { fs.unlinkSync(assPath); } catch {}
      }
    }
  }
}

export async function exportShort(options: ExportOptions): Promise<void> {
  const totalStart = Date.now();
  const jobId = options.jobId;

  if (jobId) {
    activeExports.set(jobId, { cancelled: false });
  }

  try {
    if (options.vpsVideoId && isVpsConfigured()) {
      await exportViaVps(options);
    } else {
      await exportLocal(options);
    }
  } finally {
    if (jobId) {
      activeExports.delete(jobId);
    }
  }

  log(`Total export time: ${Date.now() - totalStart}ms`, "exporter");
}
