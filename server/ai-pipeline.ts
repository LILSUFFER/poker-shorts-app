import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import { toFile } from "openai";
import { openai } from "./replit_integrations/audio/client";
import { storage } from "./storage";
import { log } from "./index";

const PIPELINE_LOG_FILE = "/tmp/pipeline.log";

export async function correctClipTranscriptWithAI(
  segments: TranscriptSegment[],
  startTime: number,
  endTime: number,
  vpsVideoId: string
): Promise<{ updatedSegments: TranscriptSegment[]; correctedCount: number }> {
  const { isVpsConfigured } = await import("./vps-client");

  if (!isVpsConfigured()) {
    throw new Error("VPS not configured");
  }

  const clipSegments = segments.filter(s => s.end > startTime && s.start < endTime && s.text.trim().length > 0);
  if (clipSegments.length === 0) return { updatedSegments: segments, correctedCount: 0 };

  plog(`AI correct: calling VPS /transcribe/clip/${vpsVideoId} (${startTime}-${endTime}s)`);

  const { vpsJson } = await import("./vps-client");
  let vpsResult: { text: string; segments: any[]; words: any[] };
  try {
    vpsResult = await vpsJson(`/transcribe/clip/${vpsVideoId}`, { startTime, endTime, language: "ru" }, 180000);
  } catch (err: any) {
    plog(`AI correct: VPS transcribe failed: ${err.message}`);
    throw new Error(`VPS transcription failed: ${err.message}`);
  }

  const correctedText = vpsResult.text || "";
  if (!correctedText.trim()) {
    throw new Error("VPS transcription returned empty result");
  }

  plog(`AI correct: gpt-4o-mini-transcribe result: "${correctedText.substring(0, 150)}..."`);

  const norm = (s: string) => s.replace(/[.,!?;:«»""''…—–\-\[\]()]/g, "").toLowerCase().trim();

  const existingWords: WordTimestamp[] = [];
  for (const seg of clipSegments) {
    if (seg.words && seg.words.length > 0) {
      for (const w of seg.words) {
        if (w.start != null && w.end != null) {
          existingWords.push({ word: w.word, start: w.start, end: w.end });
        }
      }
    }
  }

  const correctedWords = correctedText.split(/\s+/).filter((w: string) => w.trim());

  const anchors: { cIdx: number; eIdx: number }[] = [];
  let eSearch = 0;
  for (let c = 0; c < correctedWords.length; c++) {
    const cw = norm(correctedWords[c]);
    if (!cw) continue;
    for (let e = eSearch; e < Math.min(eSearch + 10, existingWords.length); e++) {
      const ew = norm(existingWords[e].word);
      if (cw === ew) {
        anchors.push({ cIdx: c, eIdx: e });
        eSearch = e + 1;
        break;
      }
    }
  }

  plog(`AI correct: found ${anchors.length} anchor matches between ${correctedWords.length} corrected and ${existingWords.length} existing words`);

  const allAbsWords: WordTimestamp[] = [];

  const interpolateRange = (cStart: number, cEnd: number, tStart: number, tEnd: number) => {
    const count = cEnd - cStart;
    if (count <= 0) return;
    const totalDur = tEnd - tStart;
    const wordDur = totalDur / count;
    for (let i = 0; i < count; i++) {
      const wStart = tStart + i * wordDur;
      const wEnd = tStart + (i + 1) * wordDur;
      allAbsWords.push({
        word: correctedWords[cStart + i],
        start: Math.round(wStart * 100) / 100,
        end: Math.round(wEnd * 100) / 100,
      });
    }
  };

  let prevCIdx = 0;
  let prevTime = existingWords.length > 0 ? existingWords[0].start : startTime;

  for (const anchor of anchors) {
    if (anchor.cIdx > prevCIdx) {
      const gapEnd = existingWords[anchor.eIdx].start;
      interpolateRange(prevCIdx, anchor.cIdx, prevTime, gapEnd);
    }
    allAbsWords.push({
      word: correctedWords[anchor.cIdx],
      start: existingWords[anchor.eIdx].start,
      end: existingWords[anchor.eIdx].end,
    });
    prevCIdx = anchor.cIdx + 1;
    prevTime = existingWords[anchor.eIdx].end;
  }

  if (prevCIdx < correctedWords.length) {
    const lastEnd = existingWords.length > 0 ? existingWords[existingWords.length - 1].end : endTime;
    interpolateRange(prevCIdx, correctedWords.length, prevTime, lastEnd);
  }

  plog(`AI correct: mapped ${correctedWords.length} corrected words onto ${existingWords.length} existing timestamps → ${allAbsWords.length} result words (${anchors.length} anchors)`);

  const fullText = allAbsWords.map(w => w.word).join(" ");

  const gptPrompt = `Разбей этот текст на строки субтитров. Каждая строка — это одна фраза, которая будет показана на экране.

Правила:
- Разбивай по речевому ритму: как человек произносит — так и разбивай
- Короткие восклицания и реакции (Вау! Класс! Мила! Нет! Да!) — каждое на отдельной строке
- Смысловые связки не разрывай (например "очень умной девушкой" — вместе)
- От 1 до 5 слов на строку
- Каждое слово должно быть ровно в одной строке, ничего не пропускай и не добавляй
- НЕ меняй слова, НЕ добавляй новые, НЕ убирай существующие

Текст:
${fullText}

Ответ — JSON массив строк. Каждая строка — текст одной строки субтитров.
Пример: ["Когда она мне сказала", "что ей 16", "я хотел"]
Верни ТОЛЬКО JSON массив строк, без пояснений.`;

  let whisperSegments: TranscriptSegment[] = [];

  try {
    const gptResponse = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: gptPrompt }],
      temperature: 0.2,
      max_tokens: 2000,
    });

    const raw = (gptResponse.choices[0]?.message?.content || "").trim();
    const jsonStr = raw.replace(/^```json?\s*/i, "").replace(/\s*```$/, "");
    const lines: string[] = JSON.parse(jsonStr);

    plog(`AI correct: GPT returned ${lines.length} caption lines`);

    let wordIdx = 0;
    for (const line of lines) {
      const lineWords = line.trim().split(/\s+/);
      const matchedWords: WordTimestamp[] = [];

      for (const lw of lineWords) {
        if (wordIdx >= allAbsWords.length) break;
        const normalizedLw = lw.replace(/[.,!?…;:"""'']/g, "").toLowerCase();
        const normalizedAbs = allAbsWords[wordIdx].word.replace(/[.,!?…;:"""'']/g, "").toLowerCase();

        if (normalizedLw === normalizedAbs || lw === allAbsWords[wordIdx].word) {
          matchedWords.push(allAbsWords[wordIdx]);
          wordIdx++;
        } else {
          let found = false;
          for (let search = wordIdx; search < Math.min(wordIdx + 3, allAbsWords.length); search++) {
            const searchNorm = allAbsWords[search].word.replace(/[.,!?…;:"""'']/g, "").toLowerCase();
            if (normalizedLw === searchNorm) {
              for (let fill = wordIdx; fill <= search; fill++) {
                matchedWords.push(allAbsWords[fill]);
              }
              wordIdx = search + 1;
              found = true;
              break;
            }
          }
          if (!found) {
            matchedWords.push(allAbsWords[wordIdx]);
            wordIdx++;
          }
        }
      }

      if (matchedWords.length > 0) {
        whisperSegments.push({
          start: matchedWords[0].start,
          end: matchedWords[matchedWords.length - 1].end,
          text: matchedWords.map(w => w.word).join(" "),
          words: [...matchedWords],
        });
      }
    }

    if (wordIdx < allAbsWords.length) {
      const remaining = allAbsWords.slice(wordIdx);
      whisperSegments.push({
        start: remaining[0].start,
        end: remaining[remaining.length - 1].end,
        text: remaining.map(w => w.word).join(" "),
        words: [...remaining],
      });
      plog(`AI correct: ${remaining.length} trailing words added as final segment`);
    }

    plog(`AI correct: GPT split ${allAbsWords.length} words into ${whisperSegments.length} caption phrases`);
  } catch (e: any) {
    plog(`AI correct: GPT phrase split failed (${e.message}), falling back to pause-based split`);
    let phraseWords: WordTimestamp[] = [];
    for (let i = 0; i < allAbsWords.length; i++) {
      phraseWords.push(allAbsWords[i]);
      const isLast = i === allAbsWords.length - 1;
      const nextGap = !isLast ? (allAbsWords[i + 1].start - allAbsWords[i].end) : 999;
      const endsWithPunct = /[.!?…]$/.test(allAbsWords[i].word);
      if (isLast || phraseWords.length >= 3 || nextGap >= 0.4 || endsWithPunct) {
        whisperSegments.push({
          start: phraseWords[0].start,
          end: phraseWords[phraseWords.length - 1].end,
          text: phraseWords.map(w => w.word).join(" "),
          words: [...phraseWords],
        });
        phraseWords = [];
      }
    }
    plog(`AI correct: fallback split ${allAbsWords.length} words into ${whisperSegments.length} phrases`);
  }

  const updatedSegments: TranscriptSegment[] = [];
  let correctedCount = 0;

  for (const seg of segments) {
    if (seg.end <= startTime || seg.start >= endTime) {
      updatedSegments.push(seg);
    }
  }

  const insertIdx = updatedSegments.findIndex(s => s.start >= startTime);
  if (insertIdx >= 0) {
    updatedSegments.splice(insertIdx, 0, ...whisperSegments);
  } else {
    updatedSegments.push(...whisperSegments);
  }

  correctedCount = whisperSegments.length;

  plog(`AI correct: replaced clip segments with ${whisperSegments.length} new whisper segments (${allAbsWords.length} words total)`);
  return { updatedSegments, correctedCount };
}

export async function correctClipWithGpt4oTranscribe(
  segments: TranscriptSegment[],
  startTime: number,
  endTime: number,
  vpsVideoId: string
): Promise<{ updatedSegments: TranscriptSegment[]; correctedCount: number }> {
  const { vpsExtractClipAudio, isVpsConfigured } = await import("./vps-client");

  if (!isVpsConfigured()) throw new Error("VPS not configured");

  const clipSegments = segments.filter(s => s.end > startTime && s.start < endTime && s.text.trim().length > 0);
  if (clipSegments.length === 0) return { updatedSegments: segments, correctedCount: 0 };

  plog(`AI correct (whisper-1): getting clip audio from VPS ${vpsVideoId} (${startTime}-${endTime}s)`);
  const audioBuffer = await vpsExtractClipAudio(vpsVideoId, startTime, endTime);
  plog(`AI correct (whisper-1): got audio ${(audioBuffer.length / 1024).toFixed(0)}KB, calling OpenAI whisper-1`);

  // Use whisper-1 with verbose_json + word timestamps — timestamps are clip-relative (start=0)
  const file = await toFile(audioBuffer, "clip.mp3", { type: "audio/mpeg" });
  const transcribeController = new AbortController();
  const transcribeTimeout = setTimeout(() => transcribeController.abort(), 90000);
  let response: any;
  try {
    response = await openai.audio.transcriptions.create(
      {
        file,
        model: "whisper-1",
        language: "ru",
        response_format: "verbose_json",
        timestamp_granularities: ["word"],
      } as any,
      { signal: transcribeController.signal } as any
    );
  } finally {
    clearTimeout(transcribeTimeout);
  }

  const correctedText = ((response as any).text || "").trim();
  if (!correctedText) throw new Error("whisper-1 returned empty result");

  // Extract word-level timestamps from whisper-1, offset by startTime to get absolute video timestamps
  const rawWords: Array<{ word: string; start: number; end: number }> =
    (response as any).words || [];

  plog(`AI correct (whisper-1): transcribed "${correctedText.substring(0, 150)}" — ${rawWords.length} word timestamps`);

  // Build absolute word timestamps (whisper returns clip-relative, offset to video-absolute)
  const allAbsWords: WordTimestamp[] = rawWords
    .filter(w => w.word && w.start != null && w.end != null)
    .map(w => ({
      word: w.word.trim(),
      start: Math.round((w.start + startTime) * 100) / 100,
      end: Math.round((w.end + startTime) * 100) / 100,
    }));

  // If whisper returned no word timestamps, fall back to even distribution across clip
  if (allAbsWords.length === 0) {
    plog(`AI correct (whisper-1): no word timestamps, distributing evenly`);
    const words = correctedText.split(/\s+/).filter((w: string) => w.trim());
    const clipDur = endTime - startTime;
    const wordDur = clipDur / Math.max(words.length, 1);
    for (let i = 0; i < words.length; i++) {
      allAbsWords.push({
        word: words[i],
        start: Math.round((startTime + i * wordDur) * 100) / 100,
        end: Math.round((startTime + (i + 1) * wordDur) * 100) / 100,
      });
    }
  }

  const fullText = allAbsWords.map(w => w.word).join(" ");

  // Use GPT to split into subtitle phrases by speech rhythm
  const gptPrompt = `Разбей этот текст на строки субтитров. Каждая строка — это одна фраза, которая будет показана на экране.

Правила:
- Разбивай по речевому ритму: как человек произносит — так и разбивай
- Короткие восклицания и реакции (Вау! Класс! Нет! Да!) — каждое на отдельной строке
- Смысловые связки не разрывай
- От 1 до 5 слов на строку
- Каждое слово должно быть ровно в одной строке, ничего не пропускай и не добавляй
- НЕ меняй слова, НЕ добавляй новые, НЕ убирай существующие

Текст:
${fullText}

Ответ — JSON массив строк. Каждая строка — текст одной строки субтитров.
Пример: ["Когда она мне сказала", "что ей 16", "я хотел"]
Верни ТОЛЬКО JSON массив строк, без пояснений.`;

  let whisperSegments: TranscriptSegment[] = [];

  const gapBasedSplit = () => {
    const result: TranscriptSegment[] = [];
    let phraseWords: WordTimestamp[] = [];
    for (let i = 0; i < allAbsWords.length; i++) {
      phraseWords.push(allAbsWords[i]);
      const nextGap = i < allAbsWords.length - 1 ? allAbsWords[i + 1].start - allAbsWords[i].end : 999;
      if (i === allAbsWords.length - 1 || phraseWords.length >= 4 || nextGap >= 0.35 || /[.!?…]$/.test(allAbsWords[i].word)) {
        result.push({ start: phraseWords[0].start, end: phraseWords[phraseWords.length - 1].end, text: phraseWords.map(w => w.word).join(" "), words: [...phraseWords] });
        phraseWords = [];
      }
    }
    return result;
  };

  try {
    const gptResponse = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: gptPrompt }],
      temperature: 0.2,
      max_tokens: 2000,
    });
    const raw = (gptResponse.choices[0]?.message?.content || "").trim();
    const jsonStr = raw.replace(/^```json?\s*/i, "").replace(/\s*```$/, "");
    const lines: string[] = JSON.parse(jsonStr);

    // Count words per GPT phrase and validate total matches allAbsWords
    const phraseCounts = lines.map(l => l.trim().split(/\s+/).filter(w => w.length > 0).length);
    const totalGptWords = phraseCounts.reduce((a, b) => a + b, 0);

    if (Math.abs(totalGptWords - allAbsWords.length) > Math.ceil(allAbsWords.length * 0.15)) {
      // GPT changed word count too much — fall back to gap-based splitting
      plog(`AI correct (whisper-1): GPT word count mismatch (${totalGptWords} vs ${allAbsWords.length}), using gap-based split`);
      whisperSegments = gapBasedSplit();
    } else {
      // Count-based assignment: take exactly N words from allAbsWords for each phrase
      let wordIdx = 0;
      for (let pi = 0; pi < lines.length; pi++) {
        const count = phraseCounts[pi];
        if (count === 0) continue;
        const phraseWords = allAbsWords.slice(wordIdx, wordIdx + count);
        if (phraseWords.length === 0) break;
        wordIdx += count;
        whisperSegments.push({
          start: phraseWords[0].start,
          end: phraseWords[phraseWords.length - 1].end,
          text: phraseWords.map(w => w.word).join(" "),
          words: [...phraseWords],
        });
      }
      // Any leftover words (GPT gave fewer words than allAbsWords)
      if (wordIdx < allAbsWords.length) {
        const remaining = allAbsWords.slice(wordIdx);
        if (whisperSegments.length > 0) {
          // Append to last segment
          const last = whisperSegments[whisperSegments.length - 1];
          last.end = remaining[remaining.length - 1].end;
          last.text += " " + remaining.map(w => w.word).join(" ");
          last.words = [...(last.words || []), ...remaining];
        } else {
          whisperSegments.push({ start: remaining[0].start, end: remaining[remaining.length - 1].end, text: remaining.map(w => w.word).join(" "), words: [...remaining] });
        }
      }
      plog(`AI correct (whisper-1): GPT split into ${whisperSegments.length} phrases (${totalGptWords} words)`);
    }
  } catch (e: any) {
    plog(`AI correct (whisper-1): GPT split failed (${e.message}), fallback to gap-based split`);
    whisperSegments = gapBasedSplit();
  }

  const updatedSegments: TranscriptSegment[] = [];
  for (const seg of segments) {
    if (seg.end <= startTime || seg.start >= endTime) updatedSegments.push(seg);
  }
  const insertIdx = updatedSegments.findIndex(s => s.start >= startTime);
  if (insertIdx >= 0) updatedSegments.splice(insertIdx, 0, ...whisperSegments);
  else updatedSegments.push(...whisperSegments);

  const correctedCount = whisperSegments.length;
  plog(`AI correct (whisper-1): replaced with ${whisperSegments.length} new segments (${allAbsWords.length} words)`);
  return { updatedSegments, correctedCount };
}

function plog(message: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${message}\n`;
  try { fs.appendFileSync(PIPELINE_LOG_FILE, line); } catch {}
  log(message, "pipeline");
}

export function splitLongSegments(segments: TranscriptSegment[], maxGapSec: number = 1.0): TranscriptSegment[] {
  const result: TranscriptSegment[] = [];
  for (const seg of segments) {
    const words = seg.words || [];
    if (words.length <= 1 || (seg.end - seg.start) <= 10) {
      result.push(seg);
      continue;
    }
    let currentWords: typeof words = [words[0]];
    for (let j = 1; j < words.length; j++) {
      const gap = (words[j].start ?? seg.start) - (words[j - 1].end ?? seg.end);
      if (gap >= maxGapSec && currentWords.length > 0) {
        result.push({
          start: currentWords[0].start ?? seg.start,
          end: currentWords[currentWords.length - 1].end ?? seg.end,
          text: currentWords.map(w => w.word).join(" ").trim(),
          words: currentWords,
        });
        currentWords = [];
      }
      currentWords.push(words[j]);
    }
    if (currentWords.length > 0) {
      result.push({
        start: currentWords[0].start ?? seg.start,
        end: currentWords[currentWords.length - 1].end ?? seg.end,
        text: currentWords.map(w => w.word).join(" ").trim(),
        words: currentWords,
      });
    }
  }
  return result;
}

const cancelledPipelines = new Set<string>();

export function cancelPipeline(videoId: string) {
  cancelledPipelines.add(videoId);
}

function checkCancelled(videoId: string) {
  if (cancelledPipelines.has(videoId)) {
    cancelledPipelines.delete(videoId);
    throw new Error("Pipeline cancelled by user");
  }
}
import {
  isVpsConfigured,
  vpsProbe,
  vpsExtractAudio,
  vpsCreateChunks,
  vpsDownloadChunk,
  vpsDownloadFullAudio,
  vpsCreateVadChunks,
  vpsDownloadVadChunk,
  vpsForceAlign,
  vpsGetAudioToken,
  vpsCleanup,
  vpsDownloadYouTube,
  vpsDownloadTwitch,
  vpsDownloadGoogleDrive,
  vpsDownloadVkVideo,
} from "./vps-client";
import { pollWhisperXAlignJob, pollWhisperXJob, isRunPodConfigured, submitWhisperXTranscribeAlignJob, runWhisperXAlignment, submitWhisperTranscribeOnlyJob } from "./runpod-client";
import type { HighlightMoment, CalibrationData, TranscriptSegment, WordTimestamp } from "@shared/schema";

const execFileAsync = promisify(execFile);

const UPLOADS_DIR = path.join(process.cwd(), "private_uploads");
const AUDIO_DIR = path.join(process.cwd(), "private_audio");
const VPS_CACHE_DIR = path.join(process.cwd(), "private_vps_cache");

for (const dir of [UPLOADS_DIR, AUDIO_DIR, VPS_CACHE_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function isVideoOnVps(vpsVideoId: string): Promise<boolean> {
  try {
    const probe = await vpsProbe(vpsVideoId);
    return probe.duration > 0;
  } catch {
    return false;
  }
}

async function findExistingVpsId(videoId: string, youtubeUrl?: string): Promise<string | null> {
  if (!youtubeUrl || !isVpsConfigured()) return null;

  const cleanUrl = youtubeUrl.replace(/[&?]t=\d+s?/g, "").replace(/\/$/, "");

  const allVideos = await storage.getVideos();
  for (const v of allVideos) {
    if (v.id === videoId) continue;
    if (!v.vpsVideoId || v.filepath !== "vps") continue;
    const vUrl = (v.youtubeUrl || "").replace(/[&?]t=\d+s?/g, "").replace(/\/$/, "");
    if (vUrl === cleanUrl) {
      if (await isVideoOnVps(v.vpsVideoId)) {
        log(`Found existing VPS video ${v.vpsVideoId} from video ${v.id} with same URL`, "pipeline");
        return v.vpsVideoId;
      }
    }
  }
  return null;
}

function normalizeVpsUrl(raw: string): string {
  if (!raw) return "";
  let url = raw;
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `http://${url}`;
  }
  if (!/:\d+/.test(url.replace(/^https?:\/\//, ""))) {
    url = `${url}:8787`;
  }
  return url;
}

export async function downloadFromVps(vpsVideoId: string): Promise<string> {
  const vpsUrl = normalizeVpsUrl(process.env.VPS_URL || "");
  const vpsToken = process.env.VPS_TOKEN || "";

  if (!vpsUrl || !vpsToken) {
    throw new Error("VPS not configured (VPS_URL and VPS_TOKEN required)");
  }

  const localPath = path.join(VPS_CACHE_DIR, `${vpsVideoId}.mp4`);

  if (fs.existsSync(localPath)) {
    const stat = fs.statSync(localPath);
    if (stat.size > 0) {
      log(`VPS video already cached: ${localPath} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`, "pipeline");
      return localPath;
    }
    fs.unlinkSync(localPath);
  }

  log(`Downloading video from VPS: ${vpsVideoId}`, "pipeline");

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 120 * 60 * 1000);

  try {
    const response = await fetch(`${vpsUrl}/download/${vpsVideoId}`, {
      headers: { "Authorization": `Bearer ${vpsToken}` },
      signal: abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`VPS download failed: ${response.status} ${response.statusText}`);
    }

    const fileStream = fs.createWriteStream(localPath);

    await new Promise<void>((resolve, reject) => {
      if (!response.body) {
        reject(new Error("No response body from VPS"));
        return;
      }
      const reader = response.body.getReader();
      let downloaded = 0;

      function pump(): Promise<void> {
        return reader.read().then(({ done, value }) => {
          if (done) {
            fileStream.end();
            return;
          }
          downloaded += value.length;
          if (downloaded % (50 * 1024 * 1024) < value.length) {
            log(`VPS download progress: ${(downloaded / 1024 / 1024).toFixed(0)}MB`, "pipeline");
          }
          if (!fileStream.write(value)) {
            return new Promise<void>((res) => fileStream.once("drain", res)).then(pump);
          }
          return pump();
        });
      }

      fileStream.on("finish", resolve);
      fileStream.on("error", (err) => {
        try { fs.unlinkSync(localPath); } catch {}
        reject(err);
      });
      pump().catch((err) => {
        fileStream.destroy();
        try { fs.unlinkSync(localPath); } catch {}
        reject(err);
      });
    });

    const stat = fs.statSync(localPath);
    log(`VPS download complete: ${(stat.size / 1024 / 1024).toFixed(1)}MB → ${localPath}`, "pipeline");
    return localPath;
  } catch (err: any) {
    try { fs.unlinkSync(localPath); } catch {}
    if (err.name === "AbortError") {
      throw new Error("VPS download timed out (30 min limit)");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function validateYouTubeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const allowedHosts = ["www.youtube.com", "youtube.com", "youtu.be", "m.youtube.com"];
    if (!allowedHosts.includes(parsed.hostname)) {
      throw new Error("Invalid YouTube URL: unsupported host");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Invalid YouTube URL: must use http or https");
    }
    return parsed.toString();
  } catch (err: any) {
    if (err.message.startsWith("Invalid YouTube URL")) throw err;
    throw new Error("Invalid YouTube URL format");
  }
}

async function downloadYouTubeLocal(sanitizedUrl: string, outputPath: string, videoId: string): Promise<void> {
  const cookiesPath = path.join(process.cwd(), "cookies.txt");
  const hasCookies = fs.existsSync(cookiesPath);
  const denoDir = path.join(process.env.HOME || "/home/runner", ".deno", "bin");
  const pythonLibsBin = path.join(process.cwd(), ".pythonlibs", "bin");
  const envPath = `${denoDir}:${pythonLibsBin}:${process.env.PATH || ""}`;
  const execEnv = { ...process.env, PATH: envPath };

  async function runYtdlp(ytArgs: string[]): Promise<void> {
    await execFileAsync("python3", ["-m", "yt_dlp", ...ytArgs], { timeout: 3600000, env: execEnv });
  }

  const baseArgs = ["--merge-output-format", "mp4", "-o", outputPath, sanitizedUrl, "--no-playlist", "--socket-timeout", "30"];

  const strategies: Array<{ label: string; args: string[] }> = [];

  strategies.push({ label: "web (PO token)", args: ["-f", "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best", ...baseArgs, "--extractor-args", "youtube:player_client=web"] });
  if (hasCookies) {
    strategies.push({ label: "cookies + web + android", args: ["-f", "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best", ...baseArgs, "--cookies", cookiesPath, "--extractor-args", "youtube:player_client=web,android"] });
  }
  strategies.push({ label: "mweb", args: ["-f", "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best", ...baseArgs, "--extractor-args", "youtube:player_client=mweb"] });
  strategies.push({ label: "android + web", args: ["-f", "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best", ...baseArgs, "--extractor-args", "youtube:player_client=android,web"] });
  strategies.push({ label: "best fallback", args: ["-f", "best", ...baseArgs, "--extractor-args", "youtube:player_client=web"] });

  for (const strategy of strategies) {
    log(`yt-dlp local trying: ${strategy.label}`, "pipeline");
    try {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      await runYtdlp(strategy.args);
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100000) {
        log(`yt-dlp local success: ${strategy.label}`, "pipeline");
        return;
      }
    } catch (err: any) {
      const msg = (err.stderr || err.message || "");
      if (msg.includes("cookies are no longer valid")) {
        try { fs.unlinkSync(cookiesPath); } catch {}
      }
      log(`yt-dlp local "${strategy.label}" failed: ${msg.substring(0, 200)}`, "pipeline");
    }
  }
  throw new Error("Не удалось скачать видео локально. YouTube блокирует загрузку с этого IP.");
}

export async function downloadYouTube(url: string, videoId: string, maxHeight?: number, trimStart?: number, trimEnd?: number): Promise<string> {
  await storage.updateVideo(videoId, { pipelineStep: "downloading", pipelineProgress: 5 });

  const sanitizedUrl = validateYouTubeUrl(url);
  const outputPath = path.join(UPLOADS_DIR, `yt_${videoId}.mp4`);

  try {
    if (isVpsConfigured()) {
      log(`Using VPS for YouTube download (better IP, no transfer to Replit)${maxHeight ? `, maxHeight=${maxHeight}` : ""}${trimStart != null ? ` [trim ${trimStart}s-${trimEnd}s]` : ""}`, "pipeline");
      const result = await vpsDownloadYouTube(sanitizedUrl, videoId, maxHeight, trimStart, trimEnd);
      log(`VPS downloaded: ${result.resolution}, ${(result.size / 1048576).toFixed(1)} MB — kept on VPS`, "pipeline");

      await storage.updateVideo(videoId, {
        pipelineProgress: 20,
        vpsVideoId: videoId,
        vpsPath: `/data/videos/${videoId}/input.mp4`,
        filepath: "vps",
        filename: `yt_${videoId}.mp4`,
      });

      log(`YouTube download complete (VPS-only, no local copy)`, "pipeline");
      return "vps";
    } else {
      await downloadYouTubeLocal(sanitizedUrl, outputPath, videoId);
    }

    if (!fs.existsSync(outputPath)) {
      throw new Error("Downloaded file not found");
    }

    await storage.updateVideo(videoId, {
      filepath: outputPath,
      filename: path.basename(outputPath),
      pipelineProgress: 20,
    });

    log(`Download complete: ${outputPath}`, "pipeline");
    return outputPath;
  } catch (err: any) {
    log(`Download failed: ${err.message}`, "pipeline");
    throw err;
  }
}

export async function downloadTwitch(url: string, videoId: string, trimStart?: number, trimEnd?: number): Promise<string> {
  await storage.updateVideo(videoId, { pipelineStep: "downloading", pipelineProgress: 5 });

  let normalizedUrl = url.trim();
  if (!/^https?:\/\//i.test(normalizedUrl)) {
    normalizedUrl = `https://${normalizedUrl}`;
  }

  try {
    const parsed = new URL(normalizedUrl);
    const allowedHosts = ["www.twitch.tv", "twitch.tv", "clips.twitch.tv"];
    if (!allowedHosts.includes(parsed.hostname)) {
      throw new Error("Invalid Twitch URL");
    }
  } catch {
    throw new Error("Invalid Twitch URL");
  }

  try {
    if (isVpsConfigured()) {
      log("Using VPS for Twitch clip download", "pipeline");
      const result = await vpsDownloadTwitch(url, videoId, trimStart, trimEnd);
      log(`VPS downloaded Twitch clip: ${result.resolution}, ${(result.size / 1048576).toFixed(1)} MB`, "pipeline");

      await storage.updateVideo(videoId, {
        pipelineProgress: 20,
        vpsVideoId: videoId,
        vpsPath: `/data/videos/${videoId}/input.mp4`,
        filepath: "vps",
        filename: `twitch_${videoId}.mp4`,
      });

      log(`Twitch clip download complete (VPS-only)`, "pipeline");
      return "vps";
    } else {
      throw new Error("Twitch clip download requires VPS configuration");
    }
  } catch (err: any) {
    log(`Twitch download failed: ${err.message}`, "pipeline");
    throw err;
  }
}

async function resolveKickM3u8(kickUrl: string): Promise<string> {
  const uuidMatch = kickUrl.match(/\/videos\/([0-9a-f-]{36})/i);
  if (!uuidMatch) throw new Error("Cannot extract video UUID from Kick URL");
  const uuid = uuidMatch[1];

  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    log(`Resolving Kick m3u8 via curl for UUID: ${uuid} (attempt ${attempt + 1}/${maxAttempts})`, "pipeline");

    try {
      const { stdout } = await execFileAsync("curl", [
        "-s", "-L",
        "--max-time", "15",
        "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "-H", "Accept: application/json",
        "-H", "Referer: https://kick.com/",
        `https://kick.com/api/v1/video/${uuid}`,
      ], { timeout: 20000 });

      const data = JSON.parse(stdout);
      const source = data?.source || data?.livestream?.source;
      if (!source || !source.includes(".m3u8")) throw new Error("Kick API did not return m3u8 URL");
      log(`Kick m3u8 resolved: ${source}`, "pipeline");
      return source;
    } catch (err: any) {
      log(`Kick curl attempt ${attempt + 1} failed: ${err.message}`, "pipeline");
      if (attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      throw new Error(`Kick API failed after ${maxAttempts} curl attempts: ${err.message}`);
    }
  }

  throw new Error(`Kick API unreachable after ${maxAttempts} attempts`);
}

async function resolveKickM3u8ViaVps(kickUrl: string): Promise<string> {
  const uuidMatch = kickUrl.match(/\/videos\/([0-9a-f-]{36})/i);
  if (!uuidMatch) throw new Error("Cannot extract video UUID from Kick URL");
  const uuid = uuidMatch[1];

  log(`Resolving Kick m3u8 via VPS proxy for UUID: ${uuid}`, "pipeline");
  const { vpsResolveKickM3u8 } = await import("./vps-client");
  return await vpsResolveKickM3u8(uuid);
}

export async function downloadKick(url: string, videoId: string, trimStart?: number, trimEnd?: number): Promise<string> {
  await storage.updateVideo(videoId, { pipelineStep: "downloading", pipelineProgress: 5 });

  let normalizedUrl = url.trim();
  if (!/^https?:\/\//i.test(normalizedUrl)) {
    normalizedUrl = `https://${normalizedUrl}`;
  }

  try {
    const parsed = new URL(normalizedUrl);
    const allowedHosts = ["www.kick.com", "kick.com"];
    if (!allowedHosts.includes(parsed.hostname)) {
      throw new Error("Invalid Kick URL");
    }
  } catch {
    throw new Error("Invalid Kick URL");
  }

  if (!isVpsConfigured()) {
    throw new Error("Kick video download requires VPS configuration");
  }

  let m3u8Url: string | null = null;

  try {
    log("Resolving Kick m3u8 URL via API (from Replit)...", "pipeline");
    m3u8Url = await resolveKickM3u8(normalizedUrl);
  } catch (err: any) {
    log(`Replit-side Kick API failed: ${err.message}, trying via VPS...`, "pipeline");
    try {
      m3u8Url = await resolveKickM3u8ViaVps(normalizedUrl);
    } catch (vpsErr: any) {
      log(`VPS-side Kick resolve also failed: ${vpsErr.message}`, "pipeline");
    }
  }

  try {
    if (m3u8Url) {
      await storage.updateVideo(videoId, { pipelineProgress: 10 });

      log(`Sending m3u8 URL to VPS for direct download (no Replit transfer)...`, "pipeline");
      const { vpsDownloadKickM3u8 } = await import("./vps-client");
      const result = await vpsDownloadKickM3u8(m3u8Url, videoId, trimStart, trimEnd);

      await storage.updateVideo(videoId, {
        pipelineProgress: 20,
        vpsVideoId: videoId,
        vpsPath: `/data/videos/${videoId}/input.mp4`,
        filepath: "vps",
        filename: `kick_${videoId}.mp4`,
      });

      log(`Kick video downloaded directly on VPS: ${result.resolution}, ${(result.size / 1048576).toFixed(1)} MB`, "pipeline");
      return "vps";
    }

    throw new Error("Не удалось получить m3u8 URL от Kick API. Попробуйте через несколько минут — Kick иногда блокирует запросы временно.");
  } catch (err: any) {
    log(`Kick download failed: ${err.message}`, "pipeline");
    throw err;
  }
}

export async function downloadGoogleDrive(url: string, videoId: string, trimStart?: number, trimEnd?: number): Promise<string> {
  await storage.updateVideo(videoId, { pipelineStep: "downloading", pipelineProgress: 5 });

  const fileIdMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!fileIdMatch) {
    throw new Error("Could not extract Google Drive file ID from URL");
  }

  try {
    if (isVpsConfigured()) {
      log("Using VPS for Google Drive download", "pipeline");
      const result = await vpsDownloadGoogleDrive(url, videoId, trimStart, trimEnd);
      log(`VPS downloaded Google Drive file: ${result.resolution}, ${(result.size / 1048576).toFixed(1)} MB`, "pipeline");

      await storage.updateVideo(videoId, {
        pipelineProgress: 20,
        vpsVideoId: videoId,
        vpsPath: `/data/videos/${videoId}/input.mp4`,
        filepath: "vps",
        filename: `gdrive_${videoId}.mp4`,
      });

      log(`Google Drive download complete (VPS-only)`, "pipeline");
      return "vps";
    } else {
      throw new Error("Google Drive download requires VPS configuration");
    }
  } catch (err: any) {
    log(`Google Drive download failed: ${err.message}`, "pipeline");
    throw err;
  }
}

export async function downloadVkVideo(url: string, videoId: string, trimStart?: number, trimEnd?: number): Promise<string> {
  await storage.updateVideo(videoId, { pipelineStep: "downloading", pipelineProgress: 5 });

  let normalizedUrl = url.trim();
  if (!/^https?:\/\//i.test(normalizedUrl)) {
    normalizedUrl = `https://${normalizedUrl}`;
  }

  try {
    const parsed = new URL(normalizedUrl);
    const allowedHosts = ["vkvideo.ru", "www.vkvideo.ru", "vk.com", "www.vk.com"];
    if (!allowedHosts.includes(parsed.hostname)) {
      throw new Error("Invalid VK Video URL");
    }
  } catch {
    throw new Error("Invalid VK Video URL");
  }

  try {
    if (isVpsConfigured()) {
      log("Using VPS for VK Video download", "pipeline");
      const result = await vpsDownloadVkVideo(normalizedUrl, videoId, trimStart, trimEnd);
      log(`VPS downloaded VK Video: ${result.resolution}, ${(result.size / 1048576).toFixed(1)} MB`, "pipeline");

      await storage.updateVideo(videoId, {
        pipelineProgress: 20,
        vpsVideoId: videoId,
        vpsPath: `/data/videos/${videoId}/input.mp4`,
        filepath: "vps",
        filename: `vkvideo_${videoId}.mp4`,
      });

      log(`VK Video download complete (VPS-only)`, "pipeline");
      return "vps";
    } else {
      throw new Error("VK Video download requires VPS configuration");
    }
  } catch (err: any) {
    log(`VK Video download failed: ${err.message}`, "pipeline");
    throw err;
  }
}

async function extractAudioLocal(videoPath: string, videoId: string): Promise<string> {
  await storage.updateVideo(videoId, { pipelineStep: "extracting_audio", pipelineProgress: 25 });

  const audioPath = path.join(AUDIO_DIR, `audio_${videoId}.wav`);

  try {
    await execFileAsync("ffmpeg", [
      "-i", videoPath, "-vn", "-ar", "16000", "-ac", "1",
      "-acodec", "pcm_s16le", "-y", audioPath,
    ], { timeout: 3600000 });
    log(`Audio extracted: ${audioPath}`, "pipeline");
    return audioPath;
  } catch (err: any) {
    log(`Audio extraction failed: ${err.message}`, "pipeline");
    throw err;
  }
}

const WHISPER_CONCURRENCY = 8;

async function transcribeAudioLocal(audioPath: string, videoId: string): Promise<{ text: string; segments: TranscriptSegment[] }> {
  await storage.updateVideo(videoId, { pipelineStep: "transcribing", pipelineProgress: 35 });

  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet", "-show_format", "-print_format", "json", audioPath,
    ]);
    const totalDuration = parseFloat(JSON.parse(stdout).format.duration || "0");
    log(`Transcribing audio: ${totalDuration.toFixed(1)}s (parallel, concurrency=${WHISPER_CONCURRENCY})`, "pipeline");

    const segmentDuration = 60;
    const numSegments = Math.ceil(totalDuration / segmentDuration);

    const segmentResults: (TranscriptSegment | null)[] = new Array(numSegments).fill(null);
    let completedCount = 0;

    const processChunk = async (i: number) => {
      const segStart = i * segmentDuration;
      const segEnd = Math.min(segStart + segmentDuration, totalDuration);
      const chunkPath = path.join(AUDIO_DIR, `seg_${videoId}_${i}.wav`);

      await execFileAsync("ffmpeg", [
        "-ss", String(segStart), "-t", String(segmentDuration),
        "-i", audioPath, "-ar", "16000", "-ac", "1",
        "-acodec", "pcm_s16le", "-y", chunkPath,
      ], { timeout: 30000 });

      const chunkStats = fs.statSync(chunkPath);
      if (chunkStats.size < 100) {
        try { fs.unlinkSync(chunkPath); } catch {}
        completedCount++;
        const progress = 35 + Math.round((completedCount / numSegments) * 20);
        await storage.updateVideo(videoId, { pipelineProgress: progress });
        return;
      }

      const chunkBuffer = fs.readFileSync(chunkPath);
      const file = await toFile(chunkBuffer, "segment.wav");

      try {
        let segText = "";
        let rawWords: any[] = [];
        {
          const response = await openai.audio.transcriptions.create({
            file,
            model: "gpt-4o-mini-transcribe",
            language: "ru",
          });
          segText = ((response as any).text || "").trim();
          rawWords = [];
        }
        if (segText.length > 0) {
          const textWords = segText.split(/\s+/).filter((w: string) => w.trim());
          const segDur = segEnd - segStart;
          const wDur = textWords.length > 0 ? segDur / textWords.length : segDur;
          const words: WordTimestamp[] = textWords.map((w: string, wi: number) => ({
            word: w,
            start: Math.round((segStart + wi * wDur) * 100) / 100,
            end: Math.round((segStart + (wi + 1) * wDur) * 100) / 100,
          }));
          segmentResults[i] = { start: segStart, end: segEnd, text: segText, words };
        }
      } catch (err: any) {
        plog(`Segment ${i} transcription failed: ${err.message}`);
      }

      try { fs.unlinkSync(chunkPath); } catch {}

      completedCount++;
      const progress = 35 + Math.round((completedCount / numSegments) * 20);
      await storage.updateVideo(videoId, { pipelineProgress: progress });
    };

    for (let batchStart = 0; batchStart < numSegments; batchStart += WHISPER_CONCURRENCY) {
      const batchEnd = Math.min(batchStart + WHISPER_CONCURRENCY, numSegments);
      const batch = [];
      for (let i = batchStart; i < batchEnd; i++) {
        batch.push(processChunk(i));
      }
      await Promise.all(batch);
    }

    const allSegments = segmentResults.filter((s): s is TranscriptSegment => s !== null);
    const fullText = allSegments.map(s => s.text).join(" ").trim();

    await storage.updateVideo(videoId, {
      transcription: fullText,
      transcriptionSegments: allSegments,
      pipelineProgress: 55,
    });
    log(`Transcription complete: ${fullText.length} chars, ${allSegments.length} segments`, "pipeline");
    return { text: fullText, segments: allSegments };
  } catch (err: any) {
    log(`Transcription failed: ${err.message}`, "pipeline");
    throw err;
  }
}

async function transcribeFullAudio(audioBuffer: Buffer, videoId: string): Promise<{ text: string; segments: TranscriptSegment[] }> {
  plog(`Full-audio transcribe: sending ${(audioBuffer.length / 1024 / 1024).toFixed(1)}MB to gpt-4o-mini-transcribe`);
  await storage.updateVideo(videoId, { pipelineStep: "transcribing", pipelineProgress: 35 });

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const file = await toFile(audioBuffer, "audio.ogg");
      const whisperPromise = openai.audio.transcriptions.create({
        file,
        model: "gpt-4o-mini-transcribe",
        language: "ru",
      });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Transcribe timeout (600s)")), 600000)
      );
      const response = await Promise.race([whisperPromise, timeoutPromise]) as any;

      const fullText = (response.text || "").trim();

      plog(`Full-audio transcribe result: ${fullText.length} chars`);

      const allSegments: TranscriptSegment[] = [];

      if (fullText) {
        const sentences = fullText.split(/(?<=[.!?])\s+/).filter((s: string) => s.trim());
        if (sentences.length > 0) {
          const totalWords = fullText.split(/\s+/).filter((w: string) => w.trim());
          let wordOffset = 0;
          for (const sentence of sentences) {
            const sWords = sentence.split(/\s+/).filter((w: string) => w.trim());
            allSegments.push({ start: 0, end: 0, text: sentence.trim(), words: sWords.map((w: string) => ({ word: w, start: 0, end: 0 })) });
          }
        } else {
          allSegments.push({ start: 0, end: 0, text: fullText, words: [] });
        }
      }

      plog(`Full-audio: ${allSegments.length} segments created`);
      return { text: fullText, segments: allSegments };
    } catch (err: any) {
      plog(`Full-audio transcribe attempt ${attempt}/${maxRetries} FAILED: ${err.message}`);
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, 5000 * attempt));
      else throw err;
    }
  }
  throw new Error("Full-audio transcription failed after all retries");
}

async function transcribeViaVpsChunked(vpsVideoId: string, videoId: string): Promise<{ text: string; segments: TranscriptSegment[] }> {
  await storage.updateVideo(videoId, { pipelineStep: "chunking_audio", pipelineProgress: 25 });
  const { totalDuration, chunks } = await vpsCreateChunks(vpsVideoId, 60);
  plog(`VPS created ${chunks.length} audio chunks (${totalDuration.toFixed(1)}s total)`);

  await storage.updateVideo(videoId, { pipelineStep: "transcribing", pipelineProgress: 30 });
  plog(`Transcribing ${chunks.length} chunks (parallel, concurrency=${WHISPER_CONCURRENCY})`);

  const segmentResults: (TranscriptSegment | null)[] = new Array(chunks.length).fill(null);
  let completedCount = 0;

  const processVpsChunk = async (i: number) => {
    const chunk = chunks[i];
    const maxRetries = 3;

    let chunkBuffer: Buffer | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        chunkBuffer = await vpsDownloadChunk(vpsVideoId, chunk.filename);
        plog(`Chunk ${i} downloaded: ${chunkBuffer.length} bytes (${chunk.filename})`);
        break;
      } catch (err: any) {
        plog(`Chunk ${i} download attempt ${attempt}/${maxRetries} failed: ${err.message}`);
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }

    if (!chunkBuffer) {
      plog(`SKIPPING chunk ${i} after ${maxRetries} download failures`);
      completedCount++;
      const progress = 30 + Math.round((completedCount / chunks.length) * 25);
      await storage.updateVideo(videoId, { pipelineProgress: progress });
      return;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const file = await toFile(chunkBuffer, "segment.wav");
        let segText = "";
        let rawWords: any[] = [];
        
        {
          const transcribePromise = openai.audio.transcriptions.create({
            file,
            model: "gpt-4o-mini-transcribe",
            language: "ru",
          });
          const response = await Promise.race([
            transcribePromise,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Transcribe timeout")), 90000)),
          ]);
          segText = ((response as any).text || "").trim();
          rawWords = [];
        }

        if (segText.length > 0) {
          const textWords = segText.split(/\s+/).filter((w: string) => w.trim());
          const cDur = chunk.endTime - chunk.startTime;
          const wDur = textWords.length > 0 ? cDur / textWords.length : cDur;
          const words: WordTimestamp[] = textWords.map((w: string, wi: number) => ({
            word: w,
            start: Math.round((chunk.startTime + wi * wDur) * 100) / 100,
            end: Math.round((chunk.startTime + (wi + 1) * wDur) * 100) / 100,
          }));
          segmentResults[i] = { start: chunk.startTime, end: chunk.endTime, text: segText, words };
        }
        break;
      } catch (err: any) {
        plog(`Chunk ${i} attempt ${attempt}/${maxRetries} FAILED: ${err.message}`);
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, 3000 * attempt));
      }
    }

    completedCount++;
    await storage.updateVideo(videoId, { pipelineProgress: 30 + Math.round((completedCount / chunks.length) * 25) });
  };

  for (let batchStart = 0; batchStart < chunks.length; batchStart += WHISPER_CONCURRENCY) {
    const batchEnd = Math.min(batchStart + WHISPER_CONCURRENCY, chunks.length);
    const batch = [];
    for (let i = batchStart; i < batchEnd; i++) batch.push(processVpsChunk(i));
    await Promise.all(batch);
  }

  const allSegments = segmentResults.filter((s): s is TranscriptSegment => s !== null);
  const fullText = allSegments.map(s => s.text).join(" ").trim();
  plog(`=== CHUNKED TRANSCRIPTION: ${allSegments.length}/${chunks.length} chunks, ${fullText.length} chars ===`);
  return { text: fullText, segments: allSegments };
}

async function transcribeViaVpsVad(vpsVideoId: string, videoId: string): Promise<{ text: string; segments: TranscriptSegment[] }> {
  await storage.updateVideo(videoId, { pipelineStep: "vad_chunking", pipelineProgress: 25 });
  plog(`VAD-based chunking: ${vpsVideoId}`);

  const { totalDuration, silenceRegions, chunks } = await vpsCreateVadChunks(vpsVideoId);
  plog(`VAD created ${chunks.length} speech chunks from ${silenceRegions} silence regions (${totalDuration.toFixed(1)}s total)`);

  await storage.updateVideo(videoId, { pipelineStep: "transcribing", pipelineProgress: 30 });

  const segmentResults: (TranscriptSegment | null)[] = new Array(chunks.length).fill(null);
  let completedCount = 0;

  const processVadChunk = async (i: number) => {
    const chunk = chunks[i];
    const maxRetries = 3;

    let chunkBuffer: Buffer | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        chunkBuffer = await vpsDownloadVadChunk(vpsVideoId, chunk.filename);
        break;
      } catch (err: any) {
        plog(`VAD chunk ${i} download attempt ${attempt}/${maxRetries} failed: ${err.message}`);
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }

    if (!chunkBuffer || chunkBuffer.length < 500) {
      completedCount++;
      await storage.updateVideo(videoId, { pipelineProgress: 30 + Math.round((completedCount / chunks.length) * 25) });
      return;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const file = await toFile(chunkBuffer, "segment.ogg");
        let segText = "";
        let rawWords: any[] = [];

        {
          const response = await Promise.race([
            openai.audio.transcriptions.create({
              file,
              model: "gpt-4o-mini-transcribe",
              language: "ru",
            }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Transcribe timeout")), 120000)),
          ]);
          segText = ((response as any).text || "").trim();
          rawWords = [];
        }

        if (segText.length > 0) {
          const textWords = segText.split(/\s+/).filter((w: string) => w.trim());
          const cDur = chunk.endTime - chunk.startTime;
          const wDur = textWords.length > 0 ? cDur / textWords.length : cDur;
          const words: WordTimestamp[] = textWords.map((w: string, wi: number) => ({
            word: w,
            start: Math.round((chunk.startTime + wi * wDur) * 100) / 100,
            end: Math.round((chunk.startTime + (wi + 1) * wDur) * 100) / 100,
          }));
          segmentResults[i] = { start: chunk.startTime, end: chunk.endTime, text: segText, words };
        }
        break;
      } catch (err: any) {
        plog(`VAD chunk ${i} attempt ${attempt}/${maxRetries} FAILED: ${err.message}`);
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, 3000 * attempt));
      }
    }

    completedCount++;
    await storage.updateVideo(videoId, { pipelineProgress: 30 + Math.round((completedCount / chunks.length) * 25) });
  };

  for (let batchStart = 0; batchStart < chunks.length; batchStart += WHISPER_CONCURRENCY) {
    const batchEnd = Math.min(batchStart + WHISPER_CONCURRENCY, chunks.length);
    const batch = [];
    for (let i = batchStart; i < batchEnd; i++) batch.push(processVadChunk(i));
    await Promise.all(batch);
  }

  const allSegments = segmentResults.filter((s): s is TranscriptSegment => s !== null);
  const fullText = allSegments.map(s => s.text).join(" ").trim();
  plog(`=== VAD TRANSCRIPTION: ${allSegments.length}/${chunks.length} chunks, ${fullText.length} chars ===`);
  return { text: fullText, segments: allSegments };
}

async function transcribeViaRunPodGpu(vpsVideoId: string, videoId: string): Promise<{ text: string; segments: TranscriptSegment[] }> {
  await storage.updateVideo(videoId, { pipelineStep: "extracting_audio", pipelineProgress: 20 });
  plog(`[RunPod] Extracting audio on VPS: ${vpsVideoId}`);
  await vpsExtractAudio(vpsVideoId);

  let audioOffset = 0;
  try {
    const { vpsProbe } = await import("./vps-client");
    const probe = await vpsProbe(vpsVideoId);
    audioOffset = probe.audioOffset || 0;
    if (Math.abs(audioOffset) > 0.01) {
      plog(`[RunPod] Audio stream offset detected: ${audioOffset.toFixed(3)}s (audio_start=${probe.audioStartTime}, video_start=${probe.videoStartTime})`);
    }
  } catch (e: any) {
    plog(`[RunPod] Warning: Could not detect audio offset: ${e.message}`);
  }

  await storage.updateVideo(videoId, { pipelineStep: "transcribing", pipelineProgress: 22 });
  plog(`[RunPod] Pre-converting audio to MP3 on VPS...`);
  const { vpsPrepareAudioMp3 } = await import("./vps-client");
  const mp3Info = await vpsPrepareAudioMp3(vpsVideoId);
  plog(`[RunPod] Audio MP3 ready: ${(mp3Info.sizeBytes / 1024 / 1024).toFixed(1)}MB (cached=${mp3Info.cached})`);

  await storage.updateVideo(videoId, { pipelineStep: "transcribing", pipelineProgress: 25 });
  plog(`[RunPod] Getting audio download token...`);
  const { audioUrl } = await vpsGetAudioToken(vpsVideoId);
  plog(`[RunPod] Audio URL: ${audioUrl.substring(0, 80)}...`);

  plog(`[RunPod] Submitting OpenAI Whisper transcribe + WhisperX align job (large-v3, ru)...`);
  const jobId = await submitWhisperXTranscribeAlignJob(audioUrl, "ru");
  await storage.updateVideo(videoId, { pipelineStep: "transcribing", pipelineProgress: 30, pipelineError: `runpod_whisperx_job:${jobId}` });

  const startTime = Date.now();
  const result = await pollWhisperXAlignJob(jobId);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  plog(`[RunPod] WhisperX transcribe+align completed in ${elapsed}s: ${result.segments.length} segments`);

  let allSegments: TranscriptSegment[] = result.segments.map(seg => ({
    start: seg.start + audioOffset,
    end: seg.end + audioOffset,
    text: (seg.text || "").trim(),
    words: (seg.words || []).map(w => ({
      word: w.word || "",
      start: w.start != null ? w.start + audioOffset : null,
      end: w.end != null ? w.end + audioOffset : null,
    })),
  }));

  if (Math.abs(audioOffset) > 0.01) {
    plog(`[RunPod] Applied audio offset ${audioOffset.toFixed(3)}s to all ${allSegments.length} segments and words`);
  }

  const fullText = allSegments.map(s => s.text).join(" ").trim();
  const totalWords = allSegments.reduce((n, s) => n + (s.words?.length || 0), 0);
  const alignedWords = allSegments.reduce((n, s) => n + (s.words?.filter(w => w.start != null && w.end != null).length || 0), 0);
  plog(`[RunPod] Transcription: ${fullText.length} chars, ${allSegments.length} segments, ${totalWords} words (${alignedWords} with timestamps)`);

  if (totalWords === 0 && allSegments.length > 0) {
    throw new Error(`WhisperX alignment failed: ${allSegments.length} segments transcribed but 0 words returned — alignment model did not produce word-level timestamps`);
  }

  const before = allSegments.length;
  allSegments = splitLongSegments(allSegments);
  plog(`[RunPod] Split long segments: ${before} → ${allSegments.length}`);

  await storage.updateVideo(videoId, {
    transcription: fullText,
    transcriptionSegments: allSegments,
    pipelineProgress: 55,
    pipelineError: null,
  });

  return { text: fullText, segments: allSegments };
}

async function transcribeViaRunPodGpuFast(vpsVideoId: string, videoId: string, transcribeOnly: boolean = false): Promise<{ text: string; segments: TranscriptSegment[] }> {
  await storage.updateVideo(videoId, { pipelineStep: "extracting_audio", pipelineProgress: 20 });
  plog(`[RunPod Fast] Extracting audio on VPS: ${vpsVideoId}`);
  await vpsExtractAudio(vpsVideoId);

  let audioOffset = 0;
  try {
    const { vpsProbe } = await import("./vps-client");
    const probe = await vpsProbe(vpsVideoId);
    audioOffset = probe.audioOffset || 0;
    if (Math.abs(audioOffset) > 0.01) {
      plog(`[RunPod Fast] Audio stream offset detected: ${audioOffset.toFixed(3)}s`);
    }
  } catch (e: any) {
    plog(`[RunPod Fast] Warning: Could not detect audio offset: ${e.message}`);
  }

  await storage.updateVideo(videoId, { pipelineStep: "transcribing", pipelineProgress: 22 });
  plog(`[RunPod Fast] Pre-converting audio to MP3 on VPS...`);
  const { vpsPrepareAudioMp3 } = await import("./vps-client");
  const mp3Info = await vpsPrepareAudioMp3(vpsVideoId);
  plog(`[RunPod Fast] Audio MP3 ready: ${(mp3Info.sizeBytes / 1024 / 1024).toFixed(1)}MB (cached=${mp3Info.cached})`);

  await storage.updateVideo(videoId, { pipelineStep: "transcribing", pipelineProgress: 25 });
  plog(`[RunPod Fast] Getting audio download token...`);
  const { audioUrl } = await vpsGetAudioToken(vpsVideoId);

  const MAX_RETRIES = 2;
  let result: Awaited<ReturnType<typeof pollWhisperXJob>> | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    plog(`[RunPod Fast] Submitting faster-whisper job (attempt ${attempt}/${MAX_RETRIES})...`);
    const jobId = await submitWhisperTranscribeOnlyJob(audioUrl, "ru");
    await storage.updateVideo(videoId, { pipelineStep: "transcribing", pipelineProgress: 25 + attempt * 5, pipelineError: `runpod_job:${jobId}${transcribeOnly ? ':transcribe_only' : ''}` });

    const startTime = Date.now();
    try {
      result = await pollWhisperXJob(jobId);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      plog(`[RunPod Fast] Transcribe-only completed in ${elapsed}s: ${result.segments.length} segments`);
      break;
    } catch (err: any) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      plog(`[RunPod Fast] Attempt ${attempt} failed after ${elapsed}s: ${err.message}`);
      if (attempt === MAX_RETRIES) throw err;
      plog(`[RunPod Fast] Retrying on another worker...`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  if (!result) throw new Error("RunPod transcription failed after all retries");

  let allSegments: TranscriptSegment[] = result.segments.map(seg => ({
    start: seg.start + audioOffset,
    end: seg.end + audioOffset,
    text: (seg.text || "").trim(),
    words: (seg.words || []).map(w => ({
      word: w.word || "",
      start: w.start != null ? w.start + audioOffset : null,
      end: w.end != null ? w.end + audioOffset : null,
    })),
  }));

  if (Math.abs(audioOffset) > 0.01) {
    plog(`[RunPod Fast] Applied audio offset ${audioOffset.toFixed(3)}s to all ${allSegments.length} segments`);
  }

  const fullText = allSegments.map(s => s.text).join(" ").trim();
  const totalWords = allSegments.reduce((n, s) => n + (s.words?.length || 0), 0);
  const alignedWords = allSegments.reduce((n, s) => n + (s.words?.filter(w => w.start != null && w.end != null).length || 0), 0);
  plog(`[RunPod Fast] Transcription: ${fullText.length} chars, ${allSegments.length} segments, ${totalWords} words (${alignedWords} with timestamps)`);

  const before = allSegments.length;
  allSegments = splitLongSegments(allSegments);
  plog(`[RunPod Fast] Split long segments: ${before} → ${allSegments.length}`);

  await storage.updateVideo(videoId, {
    transcription: fullText,
    transcriptionSegments: allSegments,
    pipelineProgress: 55,
    pipelineError: null,
  });

  return { text: fullText, segments: allSegments };
}

async function transcribeViaVps(vpsVideoId: string, videoId: string, skipWhisperX: boolean = false, transcribeOnly: boolean = false): Promise<{ text: string; segments: TranscriptSegment[] }> {
  if (isRunPodConfigured()) {
    plog(`RunPod configured — using faster-whisper (primary method)`);
    try {
      return await transcribeViaRunPodGpuFast(vpsVideoId, videoId, transcribeOnly);
    } catch (err: any) {
      plog(`RunPod faster-whisper failed: ${err.message} — falling back to VPS chunked`);
    }
  }
  if (skipWhisperX) {
    plog(`WhisperX skipped by user — using VPS chunked Whisper only`);
  }

  await storage.updateVideo(videoId, { pipelineStep: "extracting_audio", pipelineProgress: 20, pipelineError: null });
  plog(`VPS audio extraction: ${vpsVideoId}`);

  await vpsExtractAudio(vpsVideoId);

  plog(`Using fixed-size chunked transcription...`);
  const result = await transcribeViaVpsChunked(vpsVideoId, videoId);
  const { text: fullText, segments: allSegments } = result;

  await storage.updateVideo(videoId, {
    transcription: fullText,
    transcriptionSegments: allSegments,
    pipelineProgress: 55,
  });

  await vpsCleanup(vpsVideoId);
  plog(`VPS transcription complete: ${fullText.length} chars, ${allSegments.length} segments`);
  return { text: fullText, segments: allSegments };
}

function buildStreamerHighlightsPrompt(transcriptText: string, videoDuration: number, minClips: number): string {
  return `You are a VIRAL content expert and YouTube Shorts creator. Your goal is to find moments that will GO VIRAL on social media — clips that people will share, comment on, and rewatch.

Analyze this timestamped transcript from a streamer's recording and find ALL moments with VIRAL POTENTIAL for vertical YouTube Shorts (35-60 seconds each).

The transcript has timestamps in [Xs-Ys | MM:SS-MM:SS] format where X and Y are seconds. Use the SECONDS values directly for startTime/endTime.

For each highlight, return a JSON object:
- startTime: start time in seconds (use the pre-calculated seconds from timestamps)
- endTime: end time in seconds (30-60s clips, prefer 35-50s)
- title: short catchy CLICKBAIT title in Russian (max 50 chars) — must make people WANT to click and watch
- description: brief description in Russian of why this clip will go viral (1-2 sentences)
- hookLine: the EXACT first sentence the viewer will hear at startTime — copy it from the transcript. If this sentence is boring, adjust startTime!
- excitement: score 1-100 (see SCORING GUIDE below)
- tags: relevant tags from: "viral", "girls", "social", "philosophy", "funny", "rant", "hot_take", "drama", "reaction", "story", "advice", "roast", "debate", "confession", "motivation", "controversial", "emotional", "relatable", "savage", "wisdom"
- dropTime: the CLIMAX moment timestamp in seconds — the exact second within the clip where the most intense/emotional peak happens (used for music drop sync). This is the moment of the punchline, emotional explosion, or key revelation. Must be between startTime and endTime.

Find ONLY the BEST, most viral moments — around ${minClips} clips from this section. Quality over quantity! Only include moments with excitement score 60+ (truly interesting content). Skip boring filler — silence, routine gameplay, technical talk.

CRITICAL: Before returning each clip, re-read the hookLine. If it's boring, weak, or confusing — FIX the startTime to find a better opening. The hook is EVERYTHING.

═══ SCORING GUIDE (1-100) ═══

The score reflects VIRAL POTENTIAL — how likely this clip will get views, shares, and engagement on YouTube Shorts, TikTok, Instagram Reels.

90-100: GUARANTEED VIRAL — Explosive emotional outbursts, shocking confessions, extremely controversial hot takes about relationships/sex/dating, moments that would make people screenshot and share. Only 1-3 clips per hour should get this score.
75-89: HIGH VIRAL POTENTIAL — Strong hot takes, funny rants, passionate arguments about girls/dating/society, emotional moments with swearing and energy. These clips WILL perform well.
60-74: GOOD CLIP — Interesting stories, mild hot takes, funny observations, relatable moments. Solid content but not explosive.
40-59: DECENT — Has some entertainment value but lacks a strong hook. Background stories, mild commentary, routine chat interaction.
20-39: FILLER — Ordinary conversation, reading donations, transitional talk. Only include if nothing better in this time range.
1-19: SKIP-WORTHY — Dead air, technical issues, boring repetitive content.

CALIBRATION: For a typical 2-hour stream, expect this distribution:
- 90+: 2-5 clips (rare gems)
- 75-89: 5-10 clips
- 60-74: 10-15 clips
- Below 60: everything else

═══ WHAT MAKES CONTENT VIRAL (in order of priority) ═══

1. HOT TAKES & CONTROVERSIAL OPINIONS (score 75-100): Bold, provocative statements that make people argue in comments.
2. TALK ABOUT GIRLS / RELATIONSHIPS / DATING (score 70-100): ANY discussion about women, dating, relationships, exes, sex, attraction — TOP-1 viral content.
3. SOCIAL COMMENTARY & LIFE WISDOM (score 65-90): Thoughts on society, money, success, social hierarchy, "sigma mindset" content.
4. EMOTIONAL OUTBURSTS (score 70-95): Screaming, rage, disbelief, extreme excitement — raw emotions are magnetic.
5. FUNNY MOMENTS & JOKES (score 65-95): Dark humor, roasts, witty comebacks, absurd situations.
6. PERSONAL STORIES & CONFESSIONS (score 60-85): Embarrassing stories, vulnerable moments, life lessons.
7. RANTS & MONOLOGUES (score 60-85): Passionate rants about anything — the more energy, the higher the score.
8. MOTIVATIONAL / INSPIRATIONAL (score 55-80): Life advice, mindset, self-improvement.
9. DEBATES WITH CHAT (score 50-75): Arguments with viewers, responding to haters.
10. RELATABLE CONTENT (score 50-75): "SO TRUE" moments, universal experiences.
11. SAVAGE / ROAST MOMENTS (score 65-90): Devastating verbal takedowns.
12. DRAMA & GOSSIP (score 55-80): Discussion of other streamers, scandals.

EMOTIONAL MARKERS TO DETECT (boost score +10-20): "!!!", swear words ("бля", "ебать", "пиздец", "охуеть", "нахуй"), laughter, passionate speech, rapid talking, voice breaks.

═══ HOOK & NARRATIVE ARC (MOST IMPORTANT) ═══

Every clip MUST pass this test: "Would a viewer who sees the FIRST 3 SECONDS keep watching?"

HOOK TYPES (the clip MUST start with one of these):
  1. PROVOCATIVE STATEMENT: "Я тебе скажу почему девушки уходят..." — immediately creates curiosity
  2. EMOTIONAL EXPLOSION: Screaming, laughter, "БЛЯЯЯ!" — raw energy grabs attention  
  3. BOLD CLAIM: "Вот это единственная правда о деньгах" — viewer needs to hear what comes next
  4. QUESTION: "А ты знаешь что будет если..." — creates information gap
  5. CONFLICT: Disagreement, argument, debate starting — "Нет, ты не прав и вот почему"
  6. SHOCKING FACT: Unexpected information that makes viewer stop scrolling

NARRATIVE ARC — every clip MUST have ALL three parts:
  A. HOOK (0-5 sec): The first words must grab attention. If the first sentence is boring filler ("ну вот", "короче говоря", "а давайте посмотрим"), this is NOT a good clip start — find where the actual interesting statement begins.
  B. BODY (5-40 sec): Development of the idea — story, argument, explanation. The viewer must be ENGAGED throughout, not just waiting for the punchline.
  C. PAYOFF (last 5-15 sec): Punchline, conclusion, reaction, emotional peak. The viewer must feel SATISFIED, not cut off.

❌ REJECT clips that:
  - Start with filler ("ну", "так", "короче", reading donations, "спасибо за подписку")
  - Are just a single statement without context or follow-up
  - Don't have a clear beginning-middle-end
  - Start mid-conversation without setup

✅ ACCEPT clips that:
  - Start with an attention-grabbing statement or question
  - Tell a COMPLETE mini-story (even if short)
  - Have a satisfying ending (reaction, conclusion, punchline)
  - Would make a viewer say "I need to hear the rest" within 3 seconds

═══ CLIP BOUNDARY RULES ═══

RULE 1 — COMPLETE STORY, NOT JUST A QUOTE: Each clip MUST tell a COMPLETE story with:
  - SETUP (context): 5-15 seconds of context BEFORE the key moment — but ONLY engaging context, not filler
  - CLIMAX (the point): The actual viral moment, joke, hot take, or emotional peak
  - RESOLUTION (reaction/aftermath): 5-15 seconds of reaction, punchline, conclusion, or audience response
  Never cut mid-sentence or mid-story. The viewer must get the full payoff.

RULE 2 — DURATION 30-60 SECONDS: Shorter clips (30-45s) with a strong hook outperform longer clips (50-60s) with a weak start.
  - A 35-second clip with a KILLER hook beats a 55-second clip that takes 20 seconds to get interesting
  - If the moment is naturally short (strong quote + reaction = 30s), DON'T pad it with boring filler
  - If the moment is a longer story, 50-60s is perfect — but every second must EARN its place

RULE 3 — FIND NATURAL BOUNDARIES: Start clips at:
  - A provocative opening statement (NOT filler phrases)
  - An emotional burst or exclamation
  - The start of a story ("Один раз я...", "Знаешь что произошло...")
  - A question that creates curiosity
  End clips at:
  - A completed thought or punchline
  - An emotional reaction to the climax
  - A natural pause or topic change

RULE 4 — TIMESTAMP PRECISION: Use the SECONDS values (X, Y) directly from timestamps. Do NOT manually convert from MM:SS.
  - Example: [1365s-1395s | 22:45-23:15] → use startTime=1365
  - Before finalizing, verify the transcript text at your chosen timestamps actually matches your title.
  - Adjust startTime/endTime to align with the NEAREST sentence boundary in the transcript.

RULE 5 — NO OVERLAP: Clips MUST NOT overlap. If two interesting moments are close together, merge them into one longer clip or pick the better one.

RULE 6 — FIRST WORDS MATTER: Read the first sentence of your chosen clip. If it's boring or confusing without context, either:
  a) Move startTime forward to a more engaging opening, OR
  b) Move startTime back to include the setup that makes the opening make sense
  The worst possible clip starts with "...и вот поэтому я думаю что..." — viewer has no idea what "поэтому" refers to.

Video duration: ${Math.round(videoDuration)} seconds.

IMPORTANT: Return ONLY valid JSON array. No markdown, no code fences, no explanation. Find around ${minClips} best clips — only moments with a strong HOOK and complete narrative arc!

Transcript:
${transcriptText}`;
}

function buildPokerHighlightsPrompt(transcriptText: string, videoDuration: number, minClips: number): string {
  return `You are a poker content expert and YouTube Shorts creator who also understands VIRAL content. Analyze this timestamped transcript from a poker stream recording and find ALL moments worth clipping for vertical YouTube Shorts (35-60 seconds each).

The transcript has timestamps in [Xs-Ys | MM:SS-MM:SS] format where X and Y are seconds. Use the SECONDS values directly for startTime/endTime — do NOT convert from MM:SS yourself.

For each highlight, return a JSON object:
- startTime: start time in seconds (copy the seconds value from transcript timestamps)
- endTime: end time in seconds (30-60s clips, prefer 35-50s)
- title: short catchy title in Russian (max 50 chars) — MUST describe the SPECIFIC moment
- description: brief description in Russian of why this moment is exciting (1-2 sentences)
- hookLine: the EXACT first sentence the viewer will hear at startTime — copy it from the transcript. If boring, adjust startTime!
- excitement: score 1-100 (see SCORING GUIDE below)
- tags: relevant tags from: "all_in", "big_pot", "bluff", "bad_beat", "hero_call", "river_card", "cooler", "final_table", "celebration", "tilt", "funny", "reaction", "shove", "fold", "viral", "girls", "social", "philosophy", "rant", "hot_take", "story", "advice", "roast", "motivation", "controversial", "relatable"
- dropTime: the CLIMAX moment timestamp in seconds — the exact second within the clip where the most intense/emotional peak happens (used for music drop sync). For poker: the moment of the river card reveal, all-in call, or emotional explosion. For social content: the punchline or most controversial statement. Must be between startTime and endTime.

Find ONLY the BEST moments — around ${minClips} clips. Quality over quantity! Only include moments with excitement score 60+ (genuinely exciting poker action or viral social content). Skip boring filler.

CRITICAL: Before returning each clip, re-read the hookLine. If it's boring, weak, or confusing — FIX the startTime to find a better opening. The hook is EVERYTHING.

═══ SCORING GUIDE (1-100) ═══

The score reflects how exciting/viral this clip is — would people watch, share, and engage with it?

90-100: LEGENDARY — All-in with insane river card, explosive emotional meltdown, extremely controversial hot take about relationships. Only 1-3 clips per hour should get this score.
75-89: EXCELLENT — Big pot all-in, passionate emotional reaction, strong hot takes about girls/dating/society, hilarious rant with energy and swearing.
60-74: GOOD — Interesting poker hand with some tension, funny story, solid social commentary. Worth watching but not explosive.
40-59: AVERAGE — Standard poker hand, mild chat interaction, reading donations, routine gameplay commentary.
20-39: FILLER — Ordinary conversation, waiting for cards, discussing mundane topics.
1-19: DEAD AIR — Silence, technical issues, purely repetitive gameplay.

CALIBRATION: For a typical 2-hour poker stream:
- 90+: 2-4 clips (the absolute best moments)
- 75-89: 5-10 clips
- 60-74: 10-15 clips
- Below 60: everything else

═══ WHAT TO LOOK FOR — TWO CATEGORIES ═══

=== CATEGORY A: POKER ACTION ===
1. ALL-IN / SHOVE moments (score 70-100): The bigger the pot and the more dramatic the reaction, the higher
2. BAD BEATS (score 75-95): Losing a hand you should have won — especially with emotional reaction
3. EMOTIONAL OUTBURSTS (score 70-95): Screaming, cursing, disbelief. Look for: "!!!", "ебать", "бля", "пиздец", "охуеть", "о май гад"
4. BIG POTS and key decisions (score 60-85): Large bets, difficult calls, hero calls
5. BLUFFS (score 65-85): Successful or failed bluff attempts
6. DRAMATIC river cards (score 70-90): When the last card changes everything
7. CELEBRATIONS (score 60-80): Winning big pots, doubling up
8. TILT moments (score 60-85): Frustration, "rigged" comments

=== CATEGORY B: VIRAL / SOCIAL CONTENT (between-hands talk) ===
9. TALK ABOUT GIRLS / RELATIONSHIPS (score 75-100): ANY mention of women, dating, exes, attraction — #1 viral topic
10. HOT TAKES & CONTROVERSIAL OPINIONS (score 70-95): Bold, provocative statements that spark arguments
11. LIFE PHILOSOPHY & WISDOM (score 65-85): Deep thoughts on success, mindset, "sigma content"
12. FUNNY MOMENTS (score 65-90): Jokes, roasts, trolling, absurd commentary
13. PERSONAL STORIES (score 55-80): Life experiences, embarrassing moments, confessions
14. RANTS & MONOLOGUES (score 60-85): Passionate rants about anything
15. ARGUMENTS WITH CHAT (score 55-75): Debates with viewers, hater responses

⚠️ Don't skip "between hands" talk — it's often MORE viral than the poker itself!

Key Russian poker phrases: "олл-ін", "алл-ін", "шов", "пуш", "колл", "фолд", "блеф", "бэд біт", "кулер", "сет", "флеш", "стріт", "каре", "фулл хаус", "удвоение", "ITM", "баунті"

═══ HOOK & NARRATIVE ARC (MOST IMPORTANT) ═══

Every clip MUST pass the "3-second test": Would a random viewer keep watching after hearing the FIRST sentence?

HOOK TYPES for poker clips:
  1. ACTION HOOK: "Олл-ін на ривере!" / "Я ставлю всё!" — immediate tension
  2. EMOTIONAL HOOK: "БЛЯЯЯ! Что за карта!" — raw emotion grabs attention
  3. STORY HOOK: "Вот смотри что произошло..." — creates anticipation
  4. SOCIAL HOOK: Same as streamer clips — provocative statements about life/dating/society

For POKER clips: The hand action on screen IS the hook — but the clip must START when the hand gets interesting (big bet, all-in, not from the boring pre-flop). Include reaction AFTER the result.
For SOCIAL clips (between hands): Start with the provocative statement or question, not with filler.

NARRATIVE ARC — every clip MUST have:
  A. HOOK (0-5 sec): Immediately engaging opening
  B. BODY (5-40 sec): Building tension or developing the story
  C. PAYOFF (last 5-15 sec): Result, reaction, punchline — viewer must feel satisfied

═══ CLIP BOUNDARY RULES ═══

RULE 1 — COMPLETE STORY ARC: Each clip must tell a COMPLETE story:
  - SETUP: Context before the key event (5-15 seconds) — engaging context, not filler
  - CLIMAX: The exciting moment itself
  - RESOLUTION: Reaction, punchline, or outcome (5-15 seconds)
  Never cut mid-sentence or mid-hand.

RULE 2 — DURATION 30-60 SECONDS: A short clip with a KILLER hook beats a long clip with a weak start.
  - Don't pad clips with filler just to reach a minimum length
  - Every second must earn its place in the clip

RULE 3 — FIND NATURAL BOUNDARIES: Start clips at engaging moments (NOT filler). End at completed thoughts or reactions.

RULE 4 — TIMESTAMP PRECISION: Use the SECONDS values (X, Y) directly from timestamps.
  - Example: [1365s-1395s | 22:45-23:15] → startTime=1365
  - Verify the transcript text at your timestamps actually matches your title.

RULE 5 — ONE HAND = ONE CLIP: A poker hand includes pre-flop → flop → turn → river → showdown → reaction. NEVER split across multiple clips.

RULE 6 — TIMING OFFSET: Streamer REACTS to events AFTER they happen.
  - For POKER clips: Set startTime 25-35 seconds BEFORE the climax
  - For SOCIAL clips: Set startTime 5-15 seconds before the key statement

RULE 7 — NO OVERLAP: Clips MUST NOT overlap with each other.

Video duration: ${Math.round(videoDuration)} seconds.

IMPORTANT: Return ONLY valid JSON array. No markdown, no code fences, no explanation. Find as many clips as possible — minimum ${minClips}! Every clip MUST have a strong hook in the first 3 seconds.

Transcript:
${transcriptText}`;
}

function splitSegmentsIntoSentences(segments: TranscriptSegment[]): string {
  const fmtTime = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${m}:${String(sec).padStart(2, "0")}`;
  };

  const sentences: { start: number; end: number; text: string }[] = [];

  for (const seg of segments) {
    if (seg.words && seg.words.length > 0) {
      let sentStart = seg.words[0].start;
      let sentWords: string[] = [];

      for (let i = 0; i < seg.words.length; i++) {
        const w = seg.words[i];
        sentWords.push(w.word);

        const isEnd = i === seg.words.length - 1;
        const endsWithPunctuation = /[.!?…]$/.test(w.word.trim());
        const hasLongPause = !isEnd && seg.words[i + 1] && (seg.words[i + 1].start - w.end) > 0.8;

        if (isEnd || endsWithPunctuation || hasLongPause) {
          const text = sentWords.join(" ").trim();
          if (text.length > 0) {
            sentences.push({
              start: sentStart,
              end: w.end,
              text,
            });
          }
          if (!isEnd) {
            sentStart = seg.words[i + 1].start;
            sentWords = [];
          }
        }
      }
    } else {
      const rawSentences = seg.text.split(/(?<=[.!?…])\s+/);
      if (rawSentences.length <= 1) {
        sentences.push({ start: seg.start, end: seg.end, text: seg.text.trim() });
      } else {
        const segDur = seg.end - seg.start;
        const totalLen = rawSentences.reduce((s, r) => s + r.length, 0);
        let offset = seg.start;
        for (const raw of rawSentences) {
          const dur = totalLen > 0 ? (raw.length / totalLen) * segDur : segDur / rawSentences.length;
          const text = raw.trim();
          if (text.length > 0) {
            sentences.push({ start: offset, end: offset + dur, text });
          }
          offset += dur;
        }
      }
    }
  }

  return sentences
    .map((s) => `[${Math.round(s.start)}s-${Math.round(s.end)}s | ${fmtTime(s.start)}-${fmtTime(s.end)}] ${s.text}`)
    .join("\n");
}

function splitTranscriptIntoChunks(transcriptText: string, videoDuration: number, chunkDurationSec: number = 900, overlapSec: number = 120): { text: string; startSec: number; endSec: number }[] {
  const lines = transcriptText.split("\n");
  if (videoDuration <= chunkDurationSec * 1.5) {
    return [{ text: transcriptText, startSec: 0, endSec: videoDuration }];
  }

  const parsedLines: { line: string; startSec: number; endSec: number }[] = [];
  for (const line of lines) {
    const match = line.match(/^\[(\d+)s-(\d+)s/);
    if (match) {
      parsedLines.push({ line, startSec: parseInt(match[1], 10), endSec: parseInt(match[2], 10) });
    } else {
      parsedLines.push({ line, startSec: -1, endSec: -1 });
    }
  }

  const chunks: { text: string; startSec: number; endSec: number }[] = [];
  let chunkStartIdx = 0;
  let chunkStartSec = 0;

  for (let i = 0; i < parsedLines.length; i++) {
    const pl = parsedLines[i];
    if (pl.endSec > 0 && pl.endSec - chunkStartSec >= chunkDurationSec) {
      const chunkLines = parsedLines.slice(chunkStartIdx, i + 1).map(p => p.line);
      const chunkEndSec = pl.endSec;
      chunks.push({ text: chunkLines.join("\n"), startSec: chunkStartSec, endSec: chunkEndSec });

      const overlapTargetSec = chunkEndSec - overlapSec;
      let newStartIdx = i + 1;
      for (let j = chunkStartIdx; j <= i; j++) {
        if (parsedLines[j].startSec >= overlapTargetSec && parsedLines[j].startSec >= 0) {
          newStartIdx = j;
          break;
        }
      }
      chunkStartIdx = newStartIdx;
      let resolvedStartSec = chunkEndSec;
      for (let k = newStartIdx; k < parsedLines.length; k++) {
        if (parsedLines[k].startSec >= 0) {
          resolvedStartSec = parsedLines[k].startSec;
          break;
        }
      }
      chunkStartSec = resolvedStartSec;
    }
  }

  if (chunkStartIdx < parsedLines.length) {
    const remaining = parsedLines.slice(chunkStartIdx).map(p => p.line);
    if (remaining.length > 0) {
      chunks.push({ text: remaining.join("\n"), startSec: chunkStartSec, endSec: videoDuration });
    }
  }

  return chunks;
}

interface RoughMoment {
  approximateTime: number;
  topic: string;
  hookSentence: string;
  viralScore: number;
  tags: string[];
}

async function pass1ScanForMoments(
  transcriptChunk: string,
  chunkStart: number,
  chunkEnd: number,
  videoDuration: number,
  minMoments: number,
  isStreamer: boolean,
  chunkIndex: number,
  totalChunks: number
): Promise<RoughMoment[]> {
  const chunkDuration = chunkEnd - chunkStart;
  const tagsLine = isStreamer
    ? `"viral", "girls", "social", "philosophy", "funny", "rant", "hot_take", "drama", "reaction", "story", "advice", "roast", "debate", "confession", "motivation", "controversial", "emotional", "relatable", "savage", "wisdom"`
    : `"all_in", "big_pot", "bluff", "bad_beat", "hero_call", "river_card", "cooler", "final_table", "celebration", "tilt", "funny", "reaction", "shove", "fold", "viral", "girls", "social", "philosophy", "rant", "hot_take", "story", "advice", "roast", "motivation", "controversial", "relatable"`;

  const prompt = `You are a VIRAL content scout. Your ONLY job is to find ALL interesting moments in this transcript section.

READ the transcript carefully and list EVERY moment that could potentially make a good YouTube Short. Be GENEROUS — include anything remotely interesting. It's better to find 20 moments and filter later than to miss 5 good ones.

The transcript has timestamps in [Xs-Ys | MM:SS-MM:SS] format. Use the SECONDS values.

For each moment, return:
- approximateTime: the SECONDS timestamp where this moment happens (use the timestamp from the transcript line)
- topic: 1-sentence description in Russian of what's happening
- hookSentence: copy the EXACT sentence from the transcript that makes this moment interesting
- viralScore: 1-100 estimate of viral potential
- tags: relevant tags from: ${tagsLine}

═══ WHAT TO LOOK FOR (in priority order) ═══

${isStreamer ? `
1. HOT TAKES about girls/relationships/dating/sex (score 75-100) — ANY mention of women, attraction, exes
2. CONTROVERSIAL OPINIONS about society, money, politics (score 70-95)
3. EMOTIONAL OUTBURSTS — screaming, rage, excitement, "БЛЯЯЯ!", "ПИЗДЕЦ!" (score 70-95)
4. FUNNY MOMENTS — jokes, dark humor, absurd situations, roasts (score 65-95)
5. PERSONAL STORIES & CONFESSIONS — embarrassing stories, vulnerable moments (score 60-85)
6. PASSIONATE RANTS — high-energy monologues about anything (score 60-85)
7. DEBATES WITH CHAT — arguments, responding to haters (score 50-75)
8. LIFE WISDOM / MOTIVATION — advice, mindset, self-improvement (score 55-80)
` : `
1. BIG POKER HANDS — all-ins, bad beats, hero calls, river suckouts (score 70-100)
2. HOT TAKES about girls/relationships/dating (score 75-100) — streamers talk about this A LOT between hands
3. EMOTIONAL REACTIONS — tilt, rage, celebration after wins/losses (score 70-95)
4. CONTROVERSIAL STATEMENTS about anything (score 65-90)
5. FUNNY MOMENTS between hands (score 60-85)
6. PERSONAL STORIES told during downtime (score 55-80)
7. STRATEGY DISCUSSION with interesting insight (score 50-70)
`}

EMOTIONAL MARKERS that boost score: "!!!", swear words ("бля", "ебать", "пиздец", "охуеть"), laughter, rapid talking, shouting, voice breaks.

IMPORTANT RULES:
- Find AT LEAST ${minMoments} moments from this ${Math.round(chunkDuration)}-second section
- Include moments with viralScore 40+ (we'll filter later)
- Don't worry about exact clip boundaries — just mark WHERE interesting things happen
- Two moments can be close together — that's fine, we'll merge or pick later
- DO NOT skip the end of the section — scan the ENTIRE transcript
- If in doubt, INCLUDE IT. Better to have too many than too few.

Section: ${Math.round(chunkStart)}s to ${Math.round(chunkEnd)}s (total video: ${Math.round(videoDuration)}s)

Return ONLY a valid JSON array. No markdown, no code fences.

Transcript:
${transcriptChunk}`;

  let allMoments: RoughMoment[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const temp = attempt === 0 ? 0.5 : 0.7;
    plog(`[Pass 1] Scanning chunk ${chunkIndex + 1}/${totalChunks} attempt ${attempt + 1}/2 (temp=${temp}, range=${Math.round(chunkStart)}s-${Math.round(chunkEnd)}s)`);

    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: temp,
      max_tokens: 16000,
    });

    const content = response.choices[0]?.message?.content || "[]";
    let parsed: RoughMoment[] = [];

    try {
      const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      plog(`[Pass 1] Failed to parse chunk ${chunkIndex + 1} (attempt ${attempt + 1})`);
      parsed = [];
    }

    parsed = parsed.filter((m) => m.approximateTime >= 0 && m.approximateTime <= videoDuration && m.viralScore >= 40);

    if (parsed.length > 0) {
      allMoments.push(...parsed);
      plog(`[Pass 1] Chunk ${chunkIndex + 1}/${totalChunks} attempt ${attempt + 1}: found ${parsed.length} moments`);
      if (attempt === 0 && parsed.length >= minMoments) {
        break;
      }
    } else {
      plog(`[Pass 1] Chunk ${chunkIndex + 1} attempt ${attempt + 1}: 0 moments`);
    }
  }

  const deduped: RoughMoment[] = [];
  allMoments.sort((a, b) => b.viralScore - a.viralScore);
  for (const m of allMoments) {
    const tooClose = deduped.some(d => Math.abs(d.approximateTime - m.approximateTime) < 20);
    if (!tooClose) deduped.push(m);
  }

  plog(`[Pass 1] Chunk ${chunkIndex + 1}: ${allMoments.length} raw → ${deduped.length} deduped moments`);
  return deduped;
}

function extractTranscriptWindow(fullTranscript: string, centerTime: number, windowSec: number = 120): string {
  const lines = fullTranscript.split("\n");
  const windowStart = Math.max(0, centerTime - windowSec);
  const windowEnd = centerTime + windowSec;

  const filteredLines: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\[(\d+)s-(\d+)s/);
    if (match) {
      const lineStart = parseInt(match[1], 10);
      const lineEnd = parseInt(match[2], 10);
      if (lineEnd >= windowStart && lineStart <= windowEnd) {
        filteredLines.push(line);
      }
    }
  }
  return filteredLines.join("\n");
}

async function pass2RefineBoundaries(
  moments: RoughMoment[],
  fullTranscript: string,
  videoDuration: number,
  isStreamer: boolean
): Promise<HighlightMoment[]> {
  const refined: HighlightMoment[] = [];
  const batchSize = 5;

  for (let i = 0; i < moments.length; i += batchSize) {
    const batch = moments.slice(i, i + batchSize);
    const batchPromises = batch.map(async (moment, bIdx) => {
      const window = extractTranscriptWindow(fullTranscript, moment.approximateTime, 90);
      if (!window.trim()) return null;

      const prompt = `You are a YouTube Shorts editor. Your job is to find the PERFECT start and end timestamps for ONE clip.

A content scout identified an interesting moment at approximately ${Math.round(moment.approximateTime)} seconds:
Topic: ${moment.topic}
Hook sentence: "${moment.hookSentence}"
Viral score: ${moment.viralScore}

Below is the transcript around this moment (±90 seconds of context). Your job:
1. Find the BEST start point — where the viewer should begin watching
2. Find the BEST end point — where the clip should cut off
3. The clip should be 30-60 seconds long (prefer 35-50s)

═══ CLIP STRUCTURE ═══

A. HOOK (first 3-5 seconds): The clip MUST start with something that grabs attention:
   - A provocative statement or question
   - An emotional outburst ("БЛЯЯЯ!", laughter, screaming)
   - A bold claim ("Вот что я тебе скажу...")
   - NOT filler words ("ну вот", "короче", "так", "а давайте")
   
B. BODY (middle): Development of the idea, story, argument
   
C. PAYOFF (last 5-15 sec): Satisfying ending:
   - A completed thought or punchline
   - An emotional reaction
   - A natural pause or topic change
   - NOT mid-sentence or mid-idea

═══ BOUNDARY RULES ═══

- startTime MUST be at a sentence boundary — align with the NEAREST [Xs timestamp in the transcript
- endTime MUST be at a sentence boundary — align with a Ys] timestamp
- Read the FIRST sentence after startTime — if it's boring, move startTime forward or backward
- Read the LAST sentence before endTime — if it's mid-thought, extend endTime to the natural conclusion
- The interesting moment (~${Math.round(moment.approximateTime)}s) should be IN the clip, not at the very start or very end
- Leave 5-10s of context BEFORE the interesting moment for setup
- Leave 5-15s AFTER for reaction/payoff

Return a JSON object:
{
  "startTime": number (seconds),
  "endTime": number (seconds),
  "title": "catchy Russian title, max 50 chars — must make people WANT to click",
  "description": "1-2 sentences in Russian explaining why this is worth watching",
  "hookLine": "EXACT first sentence the viewer hears at startTime — copy from transcript",
  "excitement": number (1-100, refined score based on the actual content),
  "tags": [relevant tags],
  "dropTime": number (the CLIMAX second — most intense moment, between startTime and endTime)
}

IMPORTANT: Return ONLY the JSON object. No markdown, no explanation.

Transcript context:
${window}`;

      try {
        const response = await openai.chat.completions.create({
          model: "gpt-4.1-mini",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
          max_tokens: 2000,
        });

        const content = response.choices[0]?.message?.content || "";
        const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        const result = JSON.parse(cleaned) as HighlightMoment;

        if (result.startTime >= 0 && result.endTime <= videoDuration && result.endTime > result.startTime) {
          const duration = result.endTime - result.startTime;
          if (duration >= 25 && duration <= 75) {
            return result;
          } else {
            plog(`[Pass 2] Moment @${Math.round(moment.approximateTime)}s: bad duration ${duration.toFixed(0)}s, skipping`);
          }
        }
      } catch (err: any) {
        plog(`[Pass 2] Failed to refine moment @${Math.round(moment.approximateTime)}s: ${err.message}`);
      }
      return null;
    });

    const results = await Promise.all(batchPromises);
    for (const r of results) {
      if (r) refined.push(r);
    }
    plog(`[Pass 2] Refined batch ${Math.floor(i / batchSize) + 1}: ${results.filter(r => r).length}/${batch.length} successful`);
  }

  return refined;
}

async function detectHighlightsForChunk(
  transcriptChunk: string,
  chunkStart: number,
  chunkEnd: number,
  videoDuration: number,
  minClips: number,
  isStreamer: boolean,
  chunkIndex: number,
  totalChunks: number
): Promise<HighlightMoment[]> {
  const prompt = isStreamer
    ? buildStreamerHighlightsPrompt(transcriptChunk, videoDuration, minClips)
    : buildPokerHighlightsPrompt(transcriptChunk, videoDuration, minClips);

  for (let attempt = 0; attempt < 2; attempt++) {
    const temp = attempt === 0 ? 0.3 : 0.5;
    log(`GPT highlights chunk ${chunkIndex + 1}/${totalChunks} attempt ${attempt + 1}/2 (temp=${temp}, range=${Math.round(chunkStart)}s-${Math.round(chunkEnd)}s)`, "pipeline");

    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: temp,
      max_tokens: 16000,
    });

    const content = response.choices[0]?.message?.content || "[]";
    let parsed: HighlightMoment[] = [];

    try {
      const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      log(`Failed to parse GPT response chunk ${chunkIndex + 1} (attempt ${attempt + 1}): ${content.substring(0, 300)}...end: ${content.substring(content.length - 200)}`, "pipeline");
      parsed = [];
    }

    parsed = parsed
      .filter((h) => h.startTime >= 0 && h.endTime <= videoDuration && h.endTime > h.startTime)
      .sort((a, b) => b.excitement - a.excitement);

    if (parsed.length > 0) {
      log(`GPT chunk ${chunkIndex + 1}/${totalChunks}: found ${parsed.length} highlights`, "pipeline");
      return parsed;
    }
    log(`GPT returned 0 highlights for chunk ${chunkIndex + 1} attempt ${attempt + 1}, ${attempt === 0 ? "retrying..." : "giving up"}`, "pipeline");
  }
  return [];
}

function expandShortClips(highlights: HighlightMoment[], segments: TranscriptSegment[] | undefined, videoDuration: number): HighlightMoment[] {
  const MIN_DURATION = 25;
  const TARGET_SHORT = 32;
  const TARGET_VERY_SHORT = 38;

  if (!segments || segments.length === 0) return highlights;

  const sorted = [...highlights].sort((a, b) => a.startTime - b.startTime);

  for (let i = 0; i < sorted.length; i++) {
    const clip = sorted[i];
    const duration = clip.endTime - clip.startTime;
    if (duration >= MIN_DURATION) continue;

    const target = duration < 20 ? TARGET_VERY_SHORT : TARGET_SHORT;
    const needed = target - duration;
    const expandBefore = Math.ceil(needed * 0.6);
    const expandAfter = Math.ceil(needed * 0.4);

    const prevEnd = i > 0 ? sorted[i - 1].endTime : 0;
    const nextStart = i < sorted.length - 1 ? sorted[i + 1].startTime : videoDuration;

    let newStart = clip.startTime;
    let newEnd = clip.endTime;

    const maxExpandBefore = newStart - prevEnd;
    const actualExpandBefore = Math.min(expandBefore, maxExpandBefore);
    if (actualExpandBefore > 0) {
      let bestStart = newStart - actualExpandBefore;
      for (const seg of segments) {
        if (seg.start >= bestStart && seg.start < newStart && seg.start > prevEnd) {
          bestStart = seg.start;
          break;
        }
      }
      newStart = Math.max(prevEnd, bestStart);
    }

    const currentDuration = newEnd - newStart;
    if (currentDuration < target) {
      const stillNeeded = target - currentDuration;
      const maxExpandAfter = nextStart - newEnd;
      const actualExpandAfter = Math.min(stillNeeded, maxExpandAfter);
      if (actualExpandAfter > 0) {
        let bestEnd = newEnd + actualExpandAfter;
        for (let s = segments.length - 1; s >= 0; s--) {
          const seg = segments[s];
          if (seg.end <= bestEnd && seg.end > newEnd && seg.end < nextStart) {
            bestEnd = seg.end;
            break;
          }
        }
        newEnd = Math.min(nextStart, bestEnd);
      }
    }

    if (newEnd - newStart < MIN_DURATION) {
      const remaining = MIN_DURATION - (newEnd - newStart);
      const canExpandMore = nextStart - newEnd;
      if (canExpandMore >= remaining) {
        newEnd += remaining;
      } else {
        newEnd += canExpandMore;
        const stillNeeded = MIN_DURATION - (newEnd - newStart);
        const canGoBack = newStart - prevEnd;
        newStart -= Math.min(stillNeeded, canGoBack);
      }
    }

    newStart = Math.max(0, Math.round(newStart * 10) / 10);
    newEnd = Math.min(videoDuration, Math.round(newEnd * 10) / 10);

    if (newStart !== clip.startTime || newEnd !== clip.endTime) {
      const oldDur = (clip.endTime - clip.startTime).toFixed(0);
      const newDur = (newEnd - newStart).toFixed(0);
      log(`[PostProcess] Clip "${clip.title?.substring(0, 40)}" extended: ${oldDur}s → ${newDur}s (${clip.startTime.toFixed(0)}→${newStart.toFixed(0)}, ${clip.endTime.toFixed(0)}→${newEnd.toFixed(0)})`, "pipeline");
      clip.startTime = newStart;
      clip.endTime = newEnd;
    }

    if (clip.endTime - clip.startTime < MIN_DURATION) {
      log(`[PostProcess] Warning: Clip "${clip.title?.substring(0, 40)}" still ${(clip.endTime - clip.startTime).toFixed(0)}s (< ${MIN_DURATION}s) — not enough room between neighbors`, "pipeline");
    }
  }

  return sorted;
}

export async function detectHighlights(
  transcription: string,
  videoId: string,
  videoDuration: number,
  segments?: TranscriptSegment[],
  contentType?: string
): Promise<HighlightMoment[]> {
  await storage.updateVideo(videoId, { pipelineStep: "analyzing", pipelineProgress: 60 });

  try {
    let transcriptText: string;
    if (segments && segments.length > 0) {
      transcriptText = splitSegmentsIntoSentences(segments);
    } else {
      transcriptText = transcription;
    }

    const isStreamer = contentType === "streamer";
    const chunks = splitTranscriptIntoChunks(transcriptText, videoDuration);

    plog(`═══ TWO-PASS HIGHLIGHT DETECTION ═══`);
    plog(`Video: ${Math.round(videoDuration)}s, ${chunks.length} chunk(s), type=${contentType || "poker"}`);

    plog(`─── PASS 1: Scanning for ALL interesting moments ───`);
    let allRoughMoments: RoughMoment[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkDuration = chunk.endSec - chunk.startSec;
      const minMoments = Math.max(5, Math.ceil(chunkDuration / 180));

      const roughMoments = await pass1ScanForMoments(
        chunk.text, chunk.startSec, chunk.endSec,
        videoDuration, minMoments, isStreamer, i, chunks.length
      );
      allRoughMoments.push(...roughMoments);

      await storage.updateVideo(videoId, {
        pipelineProgress: 60 + Math.round(7 * (i + 1) / chunks.length),
      });
    }

    allRoughMoments.sort((a, b) => b.viralScore - a.viralScore);
    const globalDeduped: RoughMoment[] = [];
    for (const m of allRoughMoments) {
      const tooClose = globalDeduped.some(d => Math.abs(d.approximateTime - m.approximateTime) < 25);
      if (!tooClose) globalDeduped.push(m);
    }
    plog(`Pass 1 complete: ${allRoughMoments.length} raw → ${globalDeduped.length} unique moments`);

    const maxMoments = Math.max(15, Math.ceil(videoDuration / 180));
    const momentsToRefine = globalDeduped.slice(0, maxMoments);
    plog(`Selected top ${momentsToRefine.length} moments for refinement (max ${maxMoments})`);

    plog(`─── PASS 2: Refining clip boundaries ───`);
    await storage.updateVideo(videoId, { pipelineProgress: 68 });

    let highlights = await pass2RefineBoundaries(momentsToRefine, transcriptText, videoDuration, isStreamer);
    plog(`Pass 2 complete: ${highlights.length} clips with refined boundaries`);

    highlights.sort((a, b) => b.excitement - a.excitement);

    const deduped: HighlightMoment[] = [];
    for (const h of highlights) {
      const dominated = deduped.some((existing) => {
        const overlapStart = Math.max(existing.startTime, h.startTime);
        const overlapEnd = Math.min(existing.endTime, h.endTime);
        if (overlapEnd > overlapStart) {
          const overlapLen = overlapEnd - overlapStart;
          const shorterLen = Math.min(h.endTime - h.startTime, existing.endTime - existing.startTime);
          if (overlapLen / shorterLen >= 0.3) return true;
        }
        return false;
      });
      if (!dominated) deduped.push(h);
    }
    plog(`Deduplication: ${highlights.length} → ${deduped.length} clips`);
    highlights = deduped;

    const maxClips = Math.max(12, Math.ceil(videoDuration / 240));
    if (highlights.length > maxClips) {
      plog(`Trimming highlights from ${highlights.length} to top ${maxClips}`);
      highlights = highlights.slice(0, maxClips);
    }

    highlights = expandShortClips(highlights, segments, videoDuration);
    highlights.sort((a, b) => b.excitement - a.excitement);

    await storage.updateVideo(videoId, {
      highlights,
      pipelineProgress: 75,
    });

    plog(`═══ DETECTION COMPLETE: ${highlights.length} highlights ═══`);
    return highlights;
  } catch (err: any) {
    log(`Highlight detection failed: ${err.message}`, "pipeline");
    throw err;
  }
}

function deduplicateAndFixTimeline(moments: HighlightMoment[], videoDuration: number): HighlightMoment[] {
  if (moments.length === 0) return moments;

  const roundedDuration = Math.round(videoDuration);

  const clips: HighlightMoment[] = moments.map(m => ({
    ...m,
    startTime: Math.max(0, Math.round(m.startTime)),
    endTime: Math.min(roundedDuration, Math.round(m.endTime)),
  })).filter(m => m.endTime > m.startTime);

  if (clips.length === 0) return [];

  clips.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);

  const deduped: HighlightMoment[] = [{ ...clips[0] }];

  for (let i = 1; i < clips.length; i++) {
    const prev = deduped[deduped.length - 1];
    const cur = clips[i];

    if (cur.startTime >= prev.endTime) {
      deduped.push({ ...cur });
      continue;
    }

    const overlapAmount = prev.endTime - cur.startTime;
    const curDuration = cur.endTime - cur.startTime;

    if (overlapAmount >= curDuration * 0.8) {
      if (cur.excitement > prev.excitement) {
        prev.excitement = cur.excitement;
        prev.title = cur.title;
        prev.description = cur.description;
        prev.tags = cur.tags;
      }
      prev.endTime = Math.max(prev.endTime, cur.endTime);
      continue;
    }

    const splitPoint = prev.endTime;
    if (cur.endTime > splitPoint) {
      deduped.push({
        ...cur,
        startTime: splitPoint,
      });
    }
  }

  const result: HighlightMoment[] = [];
  for (let i = 0; i < deduped.length; i++) {
    const clip = deduped[i];
    const nextStart = i < deduped.length - 1 ? deduped[i + 1].startTime : roundedDuration;
    const gap = nextStart - clip.endTime;

    if (gap > 0) {
      clip.endTime = nextStart;
    }

    result.push(clip);
  }

  if (result.length > 0) {
    result[0].startTime = 0;
    result[result.length - 1].endTime = roundedDuration;
  }

  const MIN_CLIP = 15;
  const final: HighlightMoment[] = [];
  for (const clip of result) {
    const dur = clip.endTime - clip.startTime;
    if (dur < MIN_CLIP && final.length > 0) {
      final[final.length - 1].endTime = clip.endTime;
      if (clip.excitement > final[final.length - 1].excitement) {
        final[final.length - 1].excitement = clip.excitement;
        final[final.length - 1].title = clip.title;
        final[final.length - 1].description = clip.description;
        final[final.length - 1].tags = clip.tags;
      }
    } else {
      final.push(clip);
    }
  }

  const MAX_CLIP = 90;
  const split: HighlightMoment[] = [];
  for (const clip of final) {
    const dur = clip.endTime - clip.startTime;
    if (dur <= MAX_CLIP) {
      split.push(clip);
    } else {
      const numParts = Math.ceil(dur / 60);
      const partLen = Math.round(dur / numParts);
      for (let p = 0; p < numParts; p++) {
        const s = clip.startTime + p * partLen;
        const e = p === numParts - 1 ? clip.endTime : clip.startTime + (p + 1) * partLen;
        split.push({
          ...clip,
          startTime: s,
          endTime: e,
          title: numParts > 1 ? `${clip.title} (${p + 1}/${numParts})` : clip.title,
        });
      }
      log(`Split oversized clip "${clip.title}" (${dur}s) into ${numParts} parts`, "pipeline");
    }
  }

  for (let i = 0; i < split.length - 1; i++) {
    if (split[i].endTime !== split[i + 1].startTime) {
      log(`Timeline validation: gap/overlap at clip ${i} (${split[i].endTime} vs ${split[i + 1].startTime}), forcing fix`, "pipeline");
      split[i + 1].startTime = split[i].endTime;
    }
  }

  log(`Timeline fix: ${moments.length} raw → ${split.length} clips (deduped, contiguous, max ${MAX_CLIP}s)`, "pipeline");
  return split;
}

export async function detectAllMoments(
  transcription: string,
  videoId: string,
  videoDuration: number,
  segments?: TranscriptSegment[],
  contentType?: string
): Promise<HighlightMoment[]> {
  await storage.updateVideo(videoId, { pipelineStep: "analyzing_all", pipelineProgress: 60 });

  try {
    let transcriptText: string;
    if (segments && segments.length > 0) {
      transcriptText = splitSegmentsIntoSentences(segments).substring(0, 120000);
    } else {
      transcriptText = transcription.substring(0, 100000);
    }

    const isStreamer = contentType === "streamer";
    const tagsLine = isStreamer
      ? `- tags: relevant tags from: "viral", "girls", "social", "philosophy", "funny", "rant", "hot_take", "drama", "reaction", "story", "advice", "roast", "debate", "confession", "motivation", "controversial", "emotional", "relatable", "savage", "wisdom", "routine", "chat"`
      : `- tags: relevant tags from: "all_in", "big_pot", "bluff", "bad_beat", "hero_call", "river_card", "cooler", "final_table", "celebration", "tilt", "funny", "reaction", "shove", "fold", "chat", "strategy", "routine", "viral", "girls", "social", "philosophy", "rant", "hot_take", "advice", "relatable"`;

    const roleDescription = isStreamer
      ? `You are a VIRAL content expert. Analyze this timestamped transcript from a streamer's recording and split the ENTIRE video into sequential, non-overlapping clips in chronological order. Focus on VIRAL POTENTIAL — moments about relationships, social commentary, hot takes, funny moments, and emotional reactions should get HIGH excitement scores.`
      : `You are a poker content expert who also understands viral content. Analyze this timestamped transcript from a poker stream and split the ENTIRE video into sequential, non-overlapping clips in chronological order. Give high excitement scores to both exciting poker hands AND viral social content (talk about girls, life philosophy, hot takes, funny rants).`;

    const chunks = splitTranscriptIntoChunks(transcriptText, videoDuration);
    let moments: HighlightMoment[] = [];

    log(`All-moments: analyzing in ${chunks.length} chunk(s), duration=${Math.round(videoDuration)}s`, "pipeline");

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const chunkDuration = chunk.endSec - chunk.startSec;

      const chunkPrompt = `${roleDescription}

GOAL: Divide this section of the video into back-to-back clips with ZERO gaps and ZERO overlaps. Think of it as cutting a timeline into segments — each segment starts exactly where the previous one ended.

The transcript has timestamps in [Xs-Ys | MM:SS-MM:SS] format where X and Y are pre-calculated seconds. Use the SECONDS values directly — do NOT convert from MM:SS yourself.

For each clip, provide:
- startTime: start time in seconds (MUST equal the endTime of the previous clip, or ${Math.round(chunk.startSec)} for the first clip). Use the pre-calculated seconds from the transcript.
- endTime: end time in seconds (MUST equal the startTime of the next clip)
- title: short descriptive title in Russian (max 50 chars) — MUST describe the SPECIFIC event from the transcript at this exact timestamp. For viral moments, use CATCHY clickbait titles. Every title must be UNIQUE.
- description: brief description in Russian of the content (1-2 sentences)
- excitement: score 1-100 (see SCORING GUIDE below)
${tagsLine}

═══ SCORING GUIDE (1-100) ═══

90-100: GUARANTEED VIRAL — Explosive reaction, shocking confession, extremely controversial hot take. Only 1-3 per hour.
75-89: HIGH POTENTIAL — Strong hot takes, passionate rants, big poker hands with drama, emotional moments.
60-74: GOOD CLIP — Interesting content, mild hot takes, funny stories, decent poker action.
40-59: AVERAGE — Standard gameplay, mild commentary, routine chat.
20-39: FILLER — Ordinary conversation, waiting, transitional talk.
1-19: DEAD AIR — Silence, technical issues, nothing happening.

STRICT RULES:
1. First clip MUST start at ${Math.round(chunk.startSec)}. Last clip MUST end at ${Math.round(chunk.endSec)}
2. Clips MUST be sequential: clip[i].endTime === clip[i+1].startTime — NO GAPS, NO OVERLAPS
3. Each clip MUST be between 30 and 90 seconds long. NEVER create clips longer than 90 seconds! If a segment is longer, split it into multiple clips of 30-60 seconds each.
4. Cut boundaries at NATURAL PAUSES — topic changes, sentence endings, silence gaps, transition phrases ("ладно", "короче", "ну вот", "так"). Never cut mid-sentence!
5. Do NOT create two clips covering the same time range — each second appears in exactly ONE clip
6. Include calm/routine moments too — give them lower excitement scores (1-39)
7. Give HIGH excitement (70-100) to: talk about girls/relationships, controversial opinions, funny rants, emotional outbursts, personal stories${!isStreamer ? ", big poker hands, all-ins, bad beats" : ""}
8. CRITICAL: You MUST produce enough clips to cover this section. For a ${Math.round(chunkDuration)}-second section, expect roughly ${Math.max(5, Math.round(chunkDuration / 45))} clips.

Video total duration: ${Math.round(videoDuration)} seconds. This section: ${Math.round(chunk.startSec)}s to ${Math.round(chunk.endSec)}s.

IMPORTANT: Return ONLY a valid JSON array. No markdown, no code fences, no explanation.

Transcript:
${chunk.text}`;

      for (let attempt = 0; attempt < 2; attempt++) {
        const temp = attempt === 0 ? 0.3 : 0.5;
        log(`GPT all-moments chunk ${ci + 1}/${chunks.length} attempt ${attempt + 1}/2 (temp=${temp}, range=${Math.round(chunk.startSec)}s-${Math.round(chunk.endSec)}s)`, "pipeline");

        const response = await openai.chat.completions.create({
          model: "gpt-4.1-mini",
          messages: [{ role: "user", content: chunkPrompt }],
          temperature: temp,
          max_tokens: 16000,
        });

        const content = response.choices[0]?.message?.content || "[]";
        let parsed: HighlightMoment[] = [];

        try {
          const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
          parsed = JSON.parse(cleaned);
        } catch {
          log(`Failed to parse GPT all-moments chunk ${ci + 1} (attempt ${attempt + 1}): ${content.substring(0, 300)}...end: ${content.substring(content.length - 200)}`, "pipeline");
          parsed = [];
        }

        parsed = parsed
          .filter((h) => h.startTime >= 0 && h.endTime <= videoDuration && h.endTime > h.startTime)
          .sort((a, b) => a.startTime - b.startTime);

        if (parsed.length > 0) {
          log(`GPT all-moments chunk ${ci + 1}/${chunks.length}: found ${parsed.length} moments`, "pipeline");
          moments.push(...parsed);
          break;
        }
        log(`GPT returned 0 moments for chunk ${ci + 1} attempt ${attempt + 1}, ${attempt === 0 ? "retrying..." : "giving up"}`, "pipeline");
      }
    }

    moments = deduplicateAndFixTimeline(moments, videoDuration);

    await storage.updateVideo(videoId, { highlights: moments, pipelineProgress: 75 });

    log(`Detected ${moments.length} total moments after dedup/fix (all-moments mode)`, "pipeline");
    return moments;
  } catch (err: any) {
    log(`All-moments detection failed: ${err.message}`, "pipeline");
    throw err;
  }
}

export async function realignAndAnalyzePipeline(videoId: string, mode: "highlights" | "all" = "highlights"): Promise<void> {
  log(`Starting REALIGN+ANALYZE pipeline for video ${videoId} (mode: ${mode})`, "pipeline");

  try {
    const video = await storage.getVideo(videoId);
    if (!video) throw new Error("Video not found");

    if (!video.transcription || !video.transcriptionSegments) {
      throw new Error("No transcription available — full pipeline required");
    }

    const isVps = video.vpsVideoId && video.filepath === "vps";
    if (!isVps || !isVpsConfigured()) {
      throw new Error("VPS not configured — alignment requires VPS for audio access");
    }

    const vpsVideoId = video.vpsVideoId!;
    const rawSegments: TranscriptSegment[] = (video as any).transcriptionSegments || [];

    await storage.updateVideo(videoId, {
      status: "processing",
      pipelineStep: "aligning",
      pipelineProgress: 10,
      pipelineError: null,
      analysisMode: mode,
    });

    let audioOffset = 0;
    try {
      const { vpsProbe } = await import("./vps-client");
      const probe = await vpsProbe(vpsVideoId);
      audioOffset = probe.audioOffset || 0;
      if (Math.abs(audioOffset) > 0.01) {
        log(`[Realign] Audio stream offset detected: ${audioOffset.toFixed(3)}s`, "pipeline");
      }
    } catch (e: any) {
      log(`[Realign] Warning: Could not detect audio offset: ${e.message}`, "pipeline");
    }

    log(`[Realign] Getting audio URL for RunPod WhisperX alignment...`, "pipeline");
    const { vpsPrepareAudioMp3 } = await import("./vps-client");
    await vpsPrepareAudioMp3(vpsVideoId);
    const { audioUrl } = await vpsGetAudioToken(vpsVideoId);
    log(`[Realign] Audio URL ready: ${audioUrl.substring(0, 80)}...`, "pipeline");

    let allSegments = rawSegments;
    const alignStart = Date.now();
    log(`[Realign] Running RunPod WhisperX forced alignment on ${rawSegments.length} segments...`, "pipeline");
    const alignResult = await runWhisperXAlignment(audioUrl, rawSegments.map(s => ({ text: s.text, start: s.start, end: s.end })), "ru");
    const alignElapsed = ((Date.now() - alignStart) / 1000).toFixed(1);

    if (alignResult.segments && alignResult.segments.length > 0) {
      allSegments = alignResult.segments.map(seg => ({
        start: seg.start + audioOffset,
        end: seg.end + audioOffset,
        text: (seg.text || "").trim(),
        words: (seg.words || []).map(w => ({
          word: w.word || "",
          start: w.start != null ? w.start + audioOffset : null,
          end: w.end != null ? w.end + audioOffset : null,
        })),
      }));
      if (Math.abs(audioOffset) > 0.01) {
        log(`[Realign] Applied audio offset ${audioOffset.toFixed(3)}s to all segments and words`, "pipeline");
      }
      const realignTotalWords = allSegments.reduce((n, s) => n + (s.words?.length || 0), 0);
      const realignAlignedWords = allSegments.reduce((n, s) => n + (s.words?.filter(w => w.start != null && w.end != null).length || 0), 0);
      log(`[Realign] Forced alignment done in ${alignElapsed}s: ${allSegments.length} segments, ${realignTotalWords} words (${realignAlignedWords} with timestamps)`, "pipeline");

      if (realignTotalWords === 0) {
        throw new Error(`WhisperX re-alignment failed: ${allSegments.length} segments but 0 words returned — alignment model did not produce word-level timestamps`);
      }

      const before = allSegments.length;
      allSegments = splitLongSegments(allSegments);
      log(`[Realign] Split long segments: ${before} → ${allSegments.length}`, "pipeline");
    } else {
      throw new Error(`WhisperX re-alignment returned empty result — no segments produced`);
    }

    await storage.updateVideo(videoId, {
      transcriptionSegments: allSegments,
      pipelineStep: mode === "all" ? "analyzing_all" : "analyzing",
      pipelineProgress: 40,
    });

    const duration = video.duration || 0;
    const highlights = mode === "all"
      ? await detectAllMoments(video.transcription, videoId, duration, allSegments, video.contentType || undefined)
      : await detectHighlights(video.transcription, videoId, duration, allSegments, video.contentType || undefined);

    await storage.deleteClipsByVideoId(videoId);
    for (const h of highlights) {
      await storage.createClip({
        videoId,
        startTime: h.startTime,
        endTime: h.endTime,
        confidence: Math.min(1, h.excitement / 100),
        title: h.title,
        description: h.description,
        reasons: h.tags,
        signals: { excitement: h.excitement },
        status: "pending",
        adjustedStartTime: null,
        adjustedEndTime: null,
        dropTime: h.dropTime ?? null,
      });
    }

    await storage.updateVideo(videoId, {
      status: "analyzed",
      pipelineStep: "completed",
      pipelineProgress: 100,
    });

    log(`Realign+Analyze complete for video ${videoId}: ${highlights.length} clips (mode: ${mode})`, "pipeline");
  } catch (err: any) {
    cancelledPipelines.delete(videoId);
    const isCancelled = err.message === "Pipeline cancelled by user";
    log(`Realign+Analyze ${isCancelled ? "cancelled" : "failed"} for video ${videoId}: ${err.message}`, "pipeline");
    await storage.updateVideo(videoId, {
      status: isCancelled ? "analyzed" : "error",
      pipelineStep: isCancelled ? "cancelled" : "error",
      pipelineError: isCancelled ? null : err.message,
    });
  }
}

export async function reanalyzePipeline(videoId: string, mode: "highlights" | "all" = "highlights"): Promise<void> {
  log(`Starting RE-ANALYSIS pipeline for video ${videoId} (mode: ${mode}, skip download/transcription)`, "pipeline");

  try {
    const video = await storage.getVideo(videoId);
    if (!video) throw new Error("Video not found");

    if (!video.transcription) {
      throw new Error("No transcription available — full pipeline required");
    }

    await storage.updateVideo(videoId, {
      status: "processing",
      pipelineStep: mode === "all" ? "analyzing_all" : "analyzing",
      pipelineProgress: 50,
      pipelineError: null,
      analysisMode: mode,
    });

    const duration = video.duration || 0;
    const segments: TranscriptSegment[] = (video as any).transcriptionSegments || [];

    const highlights = mode === "all"
      ? await detectAllMoments(video.transcription, videoId, duration, segments, video.contentType || undefined)
      : await detectHighlights(video.transcription, videoId, duration, segments, video.contentType || undefined);

    await storage.deleteClipsByVideoId(videoId);
    for (const h of highlights) {
      await storage.createClip({
        videoId,
        startTime: h.startTime,
        endTime: h.endTime,
        confidence: Math.min(1, h.excitement / 100),
        title: h.title,
        description: h.description,
        reasons: h.tags,
        signals: { excitement: h.excitement },
        status: "pending",
        adjustedStartTime: null,
        adjustedEndTime: null,
        dropTime: h.dropTime ?? null,
      });
    }

    await storage.updateVideo(videoId, {
      status: "analyzed",
      pipelineStep: "completed",
      pipelineProgress: 100,
    });

    log(`Re-analysis complete for video ${videoId}: ${highlights.length} clips (mode: ${mode})`, "pipeline");
  } catch (err: any) {
    cancelledPipelines.delete(videoId);
    const isCancelled = err.message === "Pipeline cancelled by user";
    log(`Re-analysis ${isCancelled ? "cancelled" : "failed"} for video ${videoId}: ${err.message}`, "pipeline");
    await storage.updateVideo(videoId, {
      status: isCancelled ? "analyzed" : "error",
      pipelineStep: isCancelled ? "cancelled" : "error",
      pipelineError: err.message,
    });
  }
}

export async function rewhisperPipeline(videoId: string, analysisMode: "highlights" | "all" = "highlights", transcribeOnly: boolean = false): Promise<void> {
  plog(`Starting RE-WHISPER pipeline for video ${videoId} (mode: ${analysisMode}, transcribeOnly: ${transcribeOnly})`);

  try {
    const video = await storage.getVideo(videoId);
    if (!video) throw new Error("Video not found");

    await storage.updateVideo(videoId, {
      status: "processing",
      pipelineStep: "extracting_audio",
      pipelineProgress: 10,
      pipelineError: null,
      analysisMode,
    });

    const isVps = video.vpsVideoId && video.filepath === "vps";
    const useVpsProcessing = isVps && isVpsConfigured();
    const duration = video.duration || 0;

    let transcription: string;
    let segments: TranscriptSegment[];

    if (useVpsProcessing) {
      const vpsId = video.vpsVideoId || videoId;
      const result = await transcribeViaVps(vpsId, videoId, false, transcribeOnly);
      transcription = result.text;
      segments = result.segments;
    } else if (video.filepath && video.filepath !== "vps" && video.filepath !== "pending") {
      const audioPath = await extractAudioLocal(video.filepath, videoId);
      const result = await transcribeAudioLocal(audioPath, videoId);
      transcription = result.text;
      segments = result.segments;
      try { fs.unlinkSync(audioPath); } catch {}
    } else {
      throw new Error("Video file not available for re-transcription");
    }

    checkCancelled(videoId);

    plog(`Re-whisper transcription complete: ${transcription.length} chars, ${segments.length} segments`);

    await storage.updateVideo(videoId, {
      transcription,
      transcriptionSegments: segments,
      pipelineStep: analysisMode === "all" ? "analyzing_all" : "analyzing",
      pipelineProgress: 50,
    });

    if (!transcription || transcription.trim().length === 0) {
      throw new Error("Whisper вернул пустую транскрипцию — возможно, в видео нет речи или аудио повреждено. Проверьте, что видео содержит речь.");
    }

    if (transcribeOnly) {
      await storage.updateVideo(videoId, {
        status: "analyzed",
        pipelineStep: "completed",
        pipelineProgress: 100,
      });
      plog(`Re-whisper (transcribe-only) complete for video ${videoId}: ${segments.length} segments, clips preserved`);
    } else {
      const highlights = analysisMode === "all"
        ? await detectAllMoments(transcription, videoId, duration, segments, video.contentType || undefined)
        : await detectHighlights(transcription, videoId, duration, segments, video.contentType || undefined);

      await storage.deleteClipsByVideoId(videoId);
      for (const h of highlights) {
        await storage.createClip({
          videoId,
          startTime: h.startTime,
          endTime: h.endTime,
          confidence: Math.min(1, h.excitement / 100),
          title: h.title,
          description: h.description,
          reasons: h.tags,
          signals: { excitement: h.excitement },
          status: "pending",
          adjustedStartTime: null,
          adjustedEndTime: null,
          dropTime: h.dropTime ?? null,
        });
      }

      await storage.updateVideo(videoId, {
        status: "analyzed",
        pipelineStep: "completed",
        pipelineProgress: 100,
      });

      plog(`Re-whisper pipeline complete for video ${videoId}: ${highlights.length} clips (mode: ${analysisMode})`);
    }
  } catch (err: any) {
    cancelledPipelines.delete(videoId);
    const isCancelled = err.message === "Pipeline cancelled by user";
    plog(`Re-whisper ${isCancelled ? "cancelled" : "failed"} for video ${videoId}: ${err.message}`);
    const hasTranscription = !!(await storage.getVideo(videoId))?.transcription;
    await storage.updateVideo(videoId, {
      status: isCancelled && hasTranscription ? "analyzed" : isCancelled ? "uploaded" : "error",
      pipelineStep: isCancelled ? "cancelled" : "error",
      pipelineError: isCancelled ? null : err.message,
    });
  }
}


export async function runSequentialPipeline(videoId: string, clipDuration: number = 60, youtubeUrl?: string): Promise<void> {
  log(`Starting sequential pipeline for video ${videoId} (clip duration: ${clipDuration}s)`, "pipeline");

  try {
    const video = await storage.getVideo(videoId);
    if (!video) throw new Error("Video not found");

    await storage.updateVideo(videoId, {
      status: "processing",
      pipelineStep: "starting",
      pipelineProgress: 0,
      pipelineError: null,
    });

    const isVps = video.vpsVideoId && video.filepath === "vps";
    let useVpsProcessing = isVps && isVpsConfigured();

    let videoPath = video.filepath;
    let duration: number;
    let width: number;
    let height: number;

    const normalizedSourceUrl = youtubeUrl && !/^https?:\/\//i.test(youtubeUrl) ? `https://${youtubeUrl}` : youtubeUrl;
    const isTwitchUrl = normalizedSourceUrl && /^https?:\/\/(www\.|clips\.)?twitch\.tv\//i.test(normalizedSourceUrl);
    const isKickUrl = normalizedSourceUrl && /^https?:\/\/(www\.)?kick\.com\//i.test(normalizedSourceUrl);
    const isGdriveUrl = normalizedSourceUrl && /^https?:\/\/(drive\.google\.com|docs\.google\.com)\//i.test(normalizedSourceUrl);
    const isVkVideoUrl = normalizedSourceUrl && /^https?:\/\/(www\.)?(vkvideo\.ru|vk\.com\/video)/i.test(normalizedSourceUrl);

    let vpsIdToCheck = video.vpsVideoId || videoId;
    let alreadyOnVps = isVpsConfigured() && (isKickUrl || isTwitchUrl || isGdriveUrl || isVkVideoUrl || (normalizedSourceUrl && /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(normalizedSourceUrl))) && await isVideoOnVps(vpsIdToCheck);

    if (!alreadyOnVps && youtubeUrl) {
      const existingVpsId = await findExistingVpsId(videoId, youtubeUrl);
      if (existingVpsId) {
        vpsIdToCheck = existingVpsId;
        alreadyOnVps = true;
      }
    }

    if (alreadyOnVps) {
      log(`Video already on VPS (${vpsIdToCheck}), skipping download`, "pipeline");
      await storage.updateVideo(videoId, { pipelineStep: "skipped_download", pipelineProgress: 15, vpsVideoId: vpsIdToCheck, vpsPath: `/data/videos/${vpsIdToCheck}/input.mp4`, filepath: "vps" });
      useVpsProcessing = true;
      videoPath = "vps";
      const probe = await vpsProbe(vpsIdToCheck);
      duration = probe.duration;
      width = probe.width;
      height = probe.height;
    } else if (isVkVideoUrl) {
      videoPath = await downloadVkVideo(youtubeUrl!, videoId, trimStart, trimEnd);
      if (videoPath === "vps" && isVpsConfigured()) {
        useVpsProcessing = true;
        const probe = await vpsProbe(videoId);
        duration = probe.duration;
        width = probe.width;
        height = probe.height;
      } else {
        throw new Error("VK Video download requires VPS");
      }
    } else if (isKickUrl) {
      videoPath = await downloadKick(youtubeUrl!, videoId, trimStart, trimEnd);
      if (videoPath === "vps" && isVpsConfigured()) {
        useVpsProcessing = true;
        const probe = await vpsProbe(videoId);
        duration = probe.duration;
        width = probe.width;
        height = probe.height;
      } else {
        throw new Error("Kick download requires VPS");
      }
    } else if (isTwitchUrl) {
      videoPath = await downloadTwitch(youtubeUrl!, videoId, trimStart, trimEnd);
      if (videoPath === "vps" && isVpsConfigured()) {
        useVpsProcessing = true;
        const probe = await vpsProbe(videoId);
        duration = probe.duration;
        width = probe.width;
        height = probe.height;
      } else {
        const { stdout } = await execFileAsync("ffprobe", [
          "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", videoPath,
        ], { timeout: 30000 });
        const info = JSON.parse(stdout);
        const videoStream = info.streams.find((s: any) => s.codec_type === "video");
        duration = parseFloat(info.format.duration || "0");
        width = videoStream?.width || 1920;
        height = videoStream?.height || 1080;
      }
    } else if (isGdriveUrl) {
      videoPath = await downloadGoogleDrive(youtubeUrl!, videoId, trimStart, trimEnd);
      if (videoPath === "vps" && isVpsConfigured()) {
        useVpsProcessing = true;
        const probe = await vpsProbe(videoId);
        duration = probe.duration;
        width = probe.width;
        height = probe.height;
      } else {
        throw new Error("Google Drive download requires VPS");
      }
    } else if (normalizedSourceUrl && /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(normalizedSourceUrl)) {
      videoPath = await downloadYouTube(youtubeUrl!, videoId, maxHeight, trimStart, trimEnd);
      if (videoPath === "vps" && isVpsConfigured()) {
        useVpsProcessing = true;
        const probe = await vpsProbe(videoId);
        duration = probe.duration;
        width = probe.width;
        height = probe.height;
      } else {
        const { stdout } = await execFileAsync("ffprobe", [
          "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", videoPath,
        ], { timeout: 30000 });
        const info = JSON.parse(stdout);
        const videoStream = info.streams.find((s: any) => s.codec_type === "video");
        duration = parseFloat(info.format.duration || "0");
        width = videoStream?.width || 1920;
        height = videoStream?.height || 1080;
      }
    } else if (useVpsProcessing) {
      const probe = await vpsProbe(video.vpsVideoId!);
      duration = probe.duration;
      width = probe.width;
      height = probe.height;
    } else {
      if (isVps) {
        videoPath = await downloadFromVps(video.vpsVideoId!);
        await storage.updateVideo(videoId, { filepath: videoPath });
      }
      const { stdout } = await execFileAsync("ffprobe", [
        "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", videoPath!,
      ], { timeout: 30000 });
      const info = JSON.parse(stdout);
      const videoStream = info.streams.find((s: any) => s.codec_type === "video");
      duration = parseFloat(info.format.duration || "0");
      width = videoStream?.width || 1920;
      height = videoStream?.height || 1080;
    }

    await storage.updateVideo(videoId, { duration, width, height, pipelineStep: "splitting", pipelineProgress: 50 });

    if (!duration || duration <= 0) {
      throw new Error("Video duration is zero or invalid");
    }

    const safeDuration = Math.max(5, Math.min(600, clipDuration));

    await storage.deleteClipsByVideoId(videoId);

    const numClips = Math.ceil(duration / safeDuration);
    for (let i = 0; i < numClips; i++) {
      const startTime = i * safeDuration;
      const endTime = Math.min((i + 1) * safeDuration, duration);
      if (endTime - startTime < 3) continue;

      await storage.createClip({
        videoId,
        startTime,
        endTime,
        confidence: 0.5,
        title: `Часть ${i + 1}`,
        description: `${formatTime(startTime)} — ${formatTime(endTime)}`,
        reasons: ["sequential"],
        signals: { part: i + 1, total: numClips },
        status: "pending",
        adjustedStartTime: null,
        adjustedEndTime: null,
        dropTime: h.dropTime ?? null,
      });
    }

    await storage.updateVideo(videoId, {
      status: "analyzed",
      pipelineStep: "completed",
      pipelineProgress: 100,
    });

    log(`Sequential pipeline complete for video ${videoId}: ${numClips} clips of ${safeDuration}s`, "pipeline");
  } catch (err: any) {
    log(`Sequential pipeline failed for video ${videoId}: ${err.message}`, "pipeline");
    await storage.updateVideo(videoId, {
      status: "error",
      pipelineStep: "error",
      pipelineError: err.message,
    });
  }
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export async function runPipeline(videoId: string, youtubeUrl?: string, analysisMode: "highlights" | "all" = "highlights", maxHeight?: number, trimStart?: number, trimEnd?: number, skipWhisperX: boolean = false, transcribeOnly: boolean = false): Promise<void> {
  log(`Starting pipeline for video ${videoId} (analysisMode: ${analysisMode})`, "pipeline");

  try {
    const video = await storage.getVideo(videoId);
    if (!video) throw new Error("Video not found");

    await storage.updateVideo(videoId, {
      status: "processing",
      pipelineStep: "starting",
      pipelineProgress: 0,
      pipelineError: null,
      analysisMode,
    });

    const isVps = video.vpsVideoId && video.filepath === "vps";
    let useVpsProcessing = isVps && isVpsConfigured();

    let videoPath = video.filepath;
    let duration: number;
    let width: number;
    let height: number;

    const normalizedSourceUrl = youtubeUrl && !/^https?:\/\//i.test(youtubeUrl) ? `https://${youtubeUrl}` : youtubeUrl;
    const isTwitchUrl = normalizedSourceUrl && /^https?:\/\/(www\.|clips\.)?twitch\.tv\//i.test(normalizedSourceUrl);
    const isKickUrl = normalizedSourceUrl && /^https?:\/\/(www\.)?kick\.com\//i.test(normalizedSourceUrl);
    const isGdriveUrl = normalizedSourceUrl && /^https?:\/\/(drive\.google\.com|docs\.google\.com)\//i.test(normalizedSourceUrl);
    const isVkVideoUrl = normalizedSourceUrl && /^https?:\/\/(www\.)?(vkvideo\.ru|vk\.com\/video)/i.test(normalizedSourceUrl);

    let vpsIdToCheck = video.vpsVideoId || videoId;
    const isYoutubeUrl = normalizedSourceUrl && /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(normalizedSourceUrl);
    let alreadyOnVps = isVpsConfigured() && (isKickUrl || isTwitchUrl || isGdriveUrl || isYoutubeUrl || isVkVideoUrl) && await isVideoOnVps(vpsIdToCheck);

    if (!alreadyOnVps && isYoutubeUrl) {
      const existingVpsId = await findExistingVpsId(videoId, youtubeUrl);
      if (existingVpsId) {
        vpsIdToCheck = existingVpsId;
        alreadyOnVps = true;
      }
    }

    if (alreadyOnVps) {
      log(`Video already on VPS (${vpsIdToCheck}), skipping download`, "pipeline");
      await storage.updateVideo(videoId, { pipelineStep: "skipped_download", pipelineProgress: 15, vpsVideoId: vpsIdToCheck, vpsPath: `/data/videos/${vpsIdToCheck}/input.mp4`, filepath: "vps" });
      useVpsProcessing = true;
      videoPath = "vps";
      await storage.updateVideo(videoId, { pipelineStep: "probing", pipelineProgress: 22 });
      const probe = await vpsProbe(vpsIdToCheck);
      duration = probe.duration;
      width = probe.width;
      height = probe.height;
      log(`VPS probe (cached): ${duration.toFixed(1)}s ${width}x${height}`, "pipeline");
    } else if (isKickUrl) {
      videoPath = await downloadKick(youtubeUrl!, videoId, trimStart, trimEnd);

      if (videoPath === "vps" && isVpsConfigured()) {
        useVpsProcessing = true;
        await storage.updateVideo(videoId, { pipelineStep: "probing", pipelineProgress: 22 });
        const probe = await vpsProbe(videoId);
        duration = probe.duration;
        width = probe.width;
        height = probe.height;
        log(`VPS probe (Kick): ${duration.toFixed(1)}s ${width}x${height}`, "pipeline");
      } else {
        throw new Error("Kick download requires VPS");
      }
    } else if (isTwitchUrl) {
      videoPath = await downloadTwitch(youtubeUrl, videoId, trimStart, trimEnd);

      if (videoPath === "vps" && isVpsConfigured()) {
        useVpsProcessing = true;
        await storage.updateVideo(videoId, { pipelineStep: "probing", pipelineProgress: 22 });
        const probe = await vpsProbe(videoId);
        duration = probe.duration;
        width = probe.width;
        height = probe.height;
        log(`VPS probe (Twitch): ${duration.toFixed(1)}s ${width}x${height}`, "pipeline");
      } else {
        throw new Error("Twitch download requires VPS");
      }
    } else if (isGdriveUrl) {
      videoPath = await downloadGoogleDrive(youtubeUrl!, videoId, trimStart, trimEnd);

      if (videoPath === "vps" && isVpsConfigured()) {
        useVpsProcessing = true;
        await storage.updateVideo(videoId, { pipelineStep: "probing", pipelineProgress: 22 });
        const probe = await vpsProbe(videoId);
        duration = probe.duration;
        width = probe.width;
        height = probe.height;
        log(`VPS probe (Google Drive): ${duration.toFixed(1)}s ${width}x${height}`, "pipeline");
      } else {
        throw new Error("Google Drive download requires VPS");
      }
    } else if (isVkVideoUrl) {
      videoPath = await downloadVkVideo(youtubeUrl!, videoId, trimStart, trimEnd);

      if (videoPath === "vps" && isVpsConfigured()) {
        useVpsProcessing = true;
        await storage.updateVideo(videoId, { pipelineStep: "probing", pipelineProgress: 22 });
        const probe = await vpsProbe(videoId);
        duration = probe.duration;
        width = probe.width;
        height = probe.height;
        log(`VPS probe (VK Video): ${duration.toFixed(1)}s ${width}x${height}`, "pipeline");
      } else {
        throw new Error("VK Video download requires VPS");
      }
    } else if (isYoutubeUrl) {
      videoPath = await downloadYouTube(youtubeUrl!, videoId, maxHeight, trimStart, trimEnd);

      if (videoPath === "vps" && isVpsConfigured()) {
        useVpsProcessing = true;
        await storage.updateVideo(videoId, { pipelineStep: "probing", pipelineProgress: 22 });
        const probe = await vpsProbe(videoId);
        duration = probe.duration;
        width = probe.width;
        height = probe.height;
        log(`VPS probe (YouTube): ${duration.toFixed(1)}s ${width}x${height}`, "pipeline");
      } else {
        const { stdout } = await execFileAsync("ffprobe", [
          "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", videoPath!,
        ], { timeout: 30000 });
        const info = JSON.parse(stdout);
        const videoStream = info.streams.find((s: any) => s.codec_type === "video");
        duration = parseFloat(info.format.duration || "0");
        width = videoStream?.width || 1920;
        height = videoStream?.height || 1080;
      }
    } else if (useVpsProcessing) {
      await storage.updateVideo(videoId, { pipelineStep: "probing", pipelineProgress: 5 });
      const probe = await vpsProbe(video.vpsVideoId!);
      duration = probe.duration;
      width = probe.width;
      height = probe.height;
      log(`VPS probe: ${duration.toFixed(1)}s ${width}x${height}`, "pipeline");
    } else {
      if (isVps) {
        await storage.updateVideo(videoId, { pipelineStep: "downloading_from_vps", pipelineProgress: 5 });
        videoPath = await downloadFromVps(video.vpsVideoId!);
        await storage.updateVideo(videoId, { filepath: videoPath, pipelineProgress: 15 });
      }

      const { stdout } = await execFileAsync("ffprobe", [
        "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", videoPath!,
      ], { timeout: 30000 });
      const info = JSON.parse(stdout);
      const videoStream = info.streams.find((s: any) => s.codec_type === "video");
      duration = parseFloat(info.format.duration || "0");
      width = videoStream?.width || 1920;
      height = videoStream?.height || 1080;
    }

    await storage.updateVideo(videoId, { duration, width, height });

    checkCancelled(videoId);

    let transcription: string;
    let segments: TranscriptSegment[];

    const freshVideo = await storage.getVideo(videoId);
    const existingSegments: TranscriptSegment[] = (freshVideo?.transcriptionSegments as TranscriptSegment[]) || [];
    const existingTranscription = freshVideo?.transcription || "";
    const hasExistingTranscription = existingTranscription.trim().length > 0 && existingSegments.length > 0;

    if (hasExistingTranscription) {
      const existingWords = existingSegments.reduce((n, s) => n + (s.words?.length || 0), 0);
      const alignedWords = existingSegments.reduce((n, s) => n + (s.words?.filter(w => w.start != null && w.end != null).length || 0), 0);
      log(`Pipeline: existing transcription found (${existingSegments.length} segments, ${existingWords} words, ${alignedWords} aligned) — skipping Whisper`, "pipeline");
      transcription = existingTranscription;
      segments = existingSegments;
      await storage.updateVideo(videoId, { pipelineProgress: 55 });
    } else if (useVpsProcessing) {
      const vpsId = video.vpsVideoId || videoId;
      const result = await transcribeViaVps(vpsId, videoId, skipWhisperX, transcribeOnly);
      transcription = result.text;
      segments = result.segments;
    } else {
      const audioPath = await extractAudioLocal(videoPath!, videoId);
      const result = await transcribeAudioLocal(audioPath, videoId);
      transcription = result.text;
      segments = result.segments;
      try { fs.unlinkSync(audioPath); } catch {}
    }

    checkCancelled(videoId);

    log(`Transcription ready: ${transcription.length} chars, ${segments.length} segments${hasExistingTranscription ? " (reused)" : ""}`, "pipeline");

    await storage.updateVideo(videoId, {
      transcription,
      transcriptionSegments: segments,
      pipelineProgress: 55,
    });

    if (!transcription || transcription.trim().length === 0) {
      throw new Error("Whisper вернул пустую транскрипцию — возможно, в видео нет речи или аудио повреждено. Проверьте, что видео содержит речь.");
    }

    const highlights = analysisMode === "all"
      ? await detectAllMoments(transcription, videoId, duration, segments, video.contentType || undefined)
      : await detectHighlights(transcription, videoId, duration, segments, video.contentType || undefined);

    await storage.deleteClipsByVideoId(videoId);
    for (const h of highlights) {
      await storage.createClip({
        videoId,
        startTime: h.startTime,
        endTime: h.endTime,
        confidence: Math.min(1, h.excitement / 100),
        title: h.title,
        description: h.description,
        reasons: h.tags,
        signals: { excitement: h.excitement },
        status: "pending",
        adjustedStartTime: null,
        adjustedEndTime: null,
        dropTime: h.dropTime ?? null,
      });
    }

    await storage.updateVideo(videoId, {
      status: "analyzed",
      pipelineStep: "completed",
      pipelineProgress: 100,
    });

    log(`Pipeline complete for video ${videoId}: ${highlights.length} highlights`, "pipeline");
  } catch (err: any) {
    cancelledPipelines.delete(videoId);
    const isCancelled = err.message === "Pipeline cancelled by user";
    log(`Pipeline ${isCancelled ? "cancelled" : "failed"} for video ${videoId}: ${err.message}`, "pipeline");
    const hasTranscription = !!(await storage.getVideo(videoId))?.transcription;
    await storage.updateVideo(videoId, {
      status: isCancelled && hasTranscription ? "analyzed" : isCancelled ? "uploaded" : "error",
      pipelineStep: isCancelled ? "cancelled" : "error",
      pipelineError: isCancelled ? null : err.message,
    });
  }
}

export async function resumeRunPodPipeline(videoId: string, vpsVideoId: string, jobId: string, _isWhisperXJob: boolean = false, transcribeOnly: boolean = false): Promise<void> {
  plog(`[RunPod] Resuming WhisperX pipeline for video ${videoId}, job ${jobId} (transcribeOnly: ${transcribeOnly})`);

  try {
    const video = await storage.getVideo(videoId);
    if (!video) throw new Error("Video not found");

    const result = await pollWhisperXAlignJob(jobId);
    plog(`[RunPod] Resumed job completed: ${result.segments.length} segments`);

    let allSegments: TranscriptSegment[] = result.segments.map(seg => ({
      start: seg.start,
      end: seg.end,
      text: (seg.text || "").trim(),
      words: (seg.words || []).map(w => ({
        word: w.word || "",
        start: w.start ?? seg.start,
        end: w.end ?? seg.end,
      })),
    }));

    const fullText = allSegments.map(s => s.text).join(" ").trim();
    const totalWords = allSegments.reduce((n, s) => n + (s.words?.length || 0), 0);
    plog(`[RunPod] Transcription: ${fullText.length} chars, ${allSegments.length} segments, ${totalWords} aligned words`);

    const before = allSegments.length;
    allSegments = splitLongSegments(allSegments);
    plog(`[RunPod Resume] Split long segments: ${before} → ${allSegments.length}`);

    await storage.updateVideo(videoId, {
      transcription: fullText,
      transcriptionSegments: allSegments,
      pipelineProgress: 55,
      pipelineError: null,
    });

    if (!fullText || fullText.trim().length === 0) {
      throw new Error("Whisper вернул пустую транскрипцию");
    }

    if (transcribeOnly) {
      await storage.updateVideo(videoId, {
        status: "analyzed",
        pipelineStep: "completed",
        pipelineProgress: 100,
      });
      plog(`[RunPod] Resumed pipeline complete for ${videoId}: transcribe-only, clips preserved`);
    } else {
      const duration = video.duration || 0;
      const analysisMode = video.analysisMode || "highlights";
      const highlights = analysisMode === "all"
        ? await detectAllMoments(fullText, videoId, duration, allSegments, video.contentType || undefined)
        : await detectHighlights(fullText, videoId, duration, allSegments, video.contentType || undefined);

      await storage.deleteClipsByVideoId(videoId);
      for (const h of highlights) {
        await storage.createClip({
          videoId,
          startTime: h.startTime,
          endTime: h.endTime,
          confidence: Math.min(1, h.excitement / 100),
          title: h.title,
          description: h.description,
          reasons: h.tags,
          signals: { excitement: h.excitement },
          status: "pending",
          adjustedStartTime: null,
          adjustedEndTime: null,
          dropTime: h.dropTime ?? null,
        });
      }

      await storage.updateVideo(videoId, {
        status: "analyzed",
        pipelineStep: "completed",
        pipelineProgress: 100,
      });

      log(`[RunPod] Resumed pipeline complete for ${videoId}: ${highlights.length} highlights`, "pipeline");
    }
  } catch (err: any) {
    log(`[RunPod] Resumed pipeline failed for ${videoId}: ${err.message}`, "pipeline");
    await storage.updateVideo(videoId, {
      status: "error",
      pipelineStep: "error",
      pipelineError: err.message,
    });
  }
}
