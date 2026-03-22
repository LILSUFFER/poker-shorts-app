import fetch from "node-fetch";

const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY || "";
const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID || "dx6xc2d1n5unmm";
const RUNPOD_WHISPERX_ENDPOINT_ID = process.env.RUNPOD_WHISPERX_ENDPOINT_ID || "89m8yc7rf84t7m";
const RUNPOD_BASE_URL = `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}`;
const RUNPOD_WHISPERX_BASE_URL = `https://api.runpod.ai/v2/${RUNPOD_WHISPERX_ENDPOINT_ID}`;

interface WhisperXWord {
  word: string;
  start: number | null;
  end: number | null;
  score: number | null;
}

interface WhisperXSegment {
  start: number;
  end: number;
  text: string;
  words: WhisperXWord[];
}

interface WhisperXResult {
  segments: WhisperXSegment[];
  word_segments: WhisperXWord[];
  language?: string;
}

interface RunPodRawOutput {
  segments?: Array<{
    id?: number;
    start: number;
    end: number;
    text: string;
    words?: Array<{ word: string; start: number; end: number; score?: number }>;
  }>;
  word_timestamps?: Array<{ word: string; start: number; end: number }>;
  word_segments?: Array<{ word: string; start: number; end: number; score?: number }>;
  detected_language?: string;
  language?: string;
  transcription?: string;
  error?: string;
  traceback?: string;
}

interface RunPodStatus {
  id: string;
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
  output?: RunPodRawOutput;
  error?: string;
  executionTime?: number;
}

function plog(msg: string) {
  console.log(`[RunPod] ${msg}`);
}

function normalizeOutput(raw: RunPodRawOutput): WhisperXResult {
  const wordList: Array<{ word: string; start: number; end: number; score?: number }> =
    raw.word_timestamps || raw.word_segments || [];

  const segments: WhisperXSegment[] = (raw.segments || []).map(seg => {
    let segWords: WhisperXWord[] = [];

    if (seg.words && seg.words.length > 0) {
      segWords = seg.words.map(w => ({
        word: w.word || "",
        start: w.start ?? null,
        end: w.end ?? null,
        score: w.score ?? null,
      }));
    } else if (wordList.length > 0) {
      segWords = wordList
        .filter(w => w.start >= seg.start && w.end <= seg.end + 0.1)
        .map(w => ({
          word: w.word || "",
          start: w.start ?? null,
          end: w.end ?? null,
          score: null,
        }));
    }

    return {
      start: seg.start,
      end: seg.end,
      text: (seg.text || "").trim(),
      words: segWords,
    };
  });

  const allWords: WhisperXWord[] = wordList.map(w => ({
    word: w.word || "",
    start: w.start ?? null,
    end: w.end ?? null,
    score: w.score ?? null,
  }));

  const totalWords = segments.reduce((n, s) => n + s.words.length, 0);
  const alignedWords = segments.reduce((n, s) => n + s.words.filter(w => w.start !== null && w.end !== null).length, 0);
  const totalSegments = segments.length;
  const segsWithText = segments.filter(s => s.text.trim().length > 0).length;

  if (totalSegments > 0 && segsWithText > 0 && totalWords === 0) {
    plog(`WARNING: WhisperX returned ${totalSegments} segments (${segsWithText} with text) but 0 words — alignment likely failed`);
  } else {
    plog(`Normalized: ${totalSegments} segments, ${totalWords} words (${alignedWords} with timestamps)`);
  }

  return {
    segments,
    word_segments: allWords,
    language: raw.detected_language || raw.language,
  };
}

export async function submitWhisperXJob(audioUrl: string, language: string = "ru"): Promise<string> {
  if (!RUNPOD_API_KEY) {
    throw new Error("RUNPOD_API_KEY not configured");
  }

  plog(`Submitting job: audio=${audioUrl.substring(0, 80)}..., lang=${language}`);

  const runResp = await fetch(`${RUNPOD_BASE_URL}/run`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RUNPOD_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: {
        audio: audioUrl,
        model: "large-v3",
        language: language,
        word_timestamps: true,
        transcription: "plain_text",
        enable_vad: true,
        initial_prompt: WHISPER_PROMPT,
      },
      policy: {
        executionTimeout: 3600000,
      },
    }),
  });

  if (!runResp.ok) {
    const errText = await runResp.text();
    throw new Error(`RunPod /run failed (${runResp.status}): ${errText}`);
  }

  const runData = await runResp.json() as { id: string; status: string };
  plog(`Job submitted: ${runData.id}, status: ${runData.status}`);
  return runData.id;
}

export async function submitWhisperXJobBase64(audioBase64: string, language: string = "ru"): Promise<string> {
  if (!RUNPOD_API_KEY) {
    throw new Error("RUNPOD_API_KEY not configured");
  }

  plog(`Submitting job with base64 audio (${(audioBase64.length / 1024 / 1024).toFixed(1)}MB), lang=${language}`);

  const runResp = await fetch(`${RUNPOD_BASE_URL}/run`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RUNPOD_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: {
        audio: audioBase64,
        model: "large-v3",
        language: language,
        word_timestamps: true,
        transcription: "plain_text",
        enable_vad: true,
        initial_prompt: WHISPER_PROMPT,
      },
      policy: {
        executionTimeout: 3600000,
      },
    }),
  });

  if (!runResp.ok) {
    const errText = await runResp.text();
    throw new Error(`RunPod /run base64 failed (${runResp.status}): ${errText}`);
  }

  const runData = await runResp.json() as { id: string; status: string };
  plog(`Job submitted (base64): ${runData.id}, status: ${runData.status}`);
  return runData.id;
}

export async function pollWhisperXJob(jobId: string): Promise<WhisperXResult> {
  if (!RUNPOD_API_KEY) {
    throw new Error("RUNPOD_API_KEY not configured");
  }

  plog(`Polling job: ${jobId}`);

  const MAX_POLL_TIME = 45 * 60 * 1000;
  const MAX_QUEUE_TIME = 30 * 60 * 1000;
  const MAX_EXEC_TIME = 10 * 60 * 1000;
  const POLL_INTERVAL = 5000;
  const startTime = Date.now();
  let queueStartTime = Date.now();
  let wasInProgress = false;

  while (Date.now() - startTime < MAX_POLL_TIME) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));

    let statusResp: Response;
    try {
      statusResp = await fetch(`${RUNPOD_BASE_URL}/status/${jobId}`, {
        headers: { "Authorization": `Bearer ${RUNPOD_API_KEY}` },
      });
    } catch (fetchErr: any) {
      plog(`Status fetch error: ${fetchErr.message}`);
      continue;
    }

    if (statusResp.status === 404) {
      plog(`Job ${jobId} not found (404) — purged or expired`);
      throw new Error("RunPod job not found (purged or expired)");
    }

    if (!statusResp.ok) {
      plog(`Status check failed: ${statusResp.status}`);
      continue;
    }

    const statusData = await statusResp.json() as RunPodStatus;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

    if (statusData.status === "COMPLETED") {
      plog(`Job completed in ${elapsed}s, execTime: ${statusData.executionTime}ms`);
      if (!statusData.output) {
        throw new Error("RunPod returned COMPLETED but no output");
      }
      if (statusData.output.error) {
        throw new Error(`RunPod worker error: ${statusData.output.error}`);
      }
      return normalizeOutput(statusData.output);
    }

    if (statusData.status === "FAILED" || statusData.status === "TIMED_OUT" || statusData.status === "CANCELLED") {
      const errDetail = statusData.error || (statusData.output?.error) || "unknown error";
      throw new Error(`RunPod job ${statusData.status}: ${errDetail}`);
    }

    if (statusData.status === "IN_PROGRESS") {
      wasInProgress = true;
      const execMs = statusData.executionTime;
      if (execMs && execMs > MAX_EXEC_TIME) {
        plog(`Job ${jobId} stuck IN_PROGRESS for ${Math.round(execMs / 1000)}s — cancelling (possible CUDA hang)`);
        try {
          await fetch(`${RUNPOD_BASE_URL}/cancel/${jobId}`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${RUNPOD_API_KEY}` },
          });
        } catch {}
        throw new Error(`RunPod job stuck (execution > ${Math.round(execMs / 1000)}s) — worker may have CUDA issues, please retry`);
      }
    }

    if (statusData.status === "IN_QUEUE" && !wasInProgress && (Date.now() - queueStartTime > MAX_QUEUE_TIME)) {
      plog(`Job stuck IN_QUEUE for ${MAX_QUEUE_TIME / 1000}s — no workers available, cancelling`);
      try {
        await fetch(`${RUNPOD_BASE_URL}/cancel/${jobId}`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${RUNPOD_API_KEY}` },
        });
      } catch {}
      throw new Error(`RunPod: no GPU workers available (IN_QUEUE > ${MAX_QUEUE_TIME / 1000}s)`);
    }

    if (Number(elapsed) % 30 < 6) {
      plog(`Polling... status=${statusData.status}, elapsed=${elapsed}s, execTime=${statusData.executionTime || 'N/A'}ms`);
    }
  }

  throw new Error(`RunPod job timed out after ${MAX_POLL_TIME / 1000}s`);
}

export async function runWhisperX(audioUrl: string, language: string = "ru"): Promise<WhisperXResult> {
  const jobId = await submitWhisperXJob(audioUrl, language);
  return pollWhisperXJob(jobId);
}

export async function checkRunPodHealth(): Promise<{ available: boolean; healthy: boolean; workers: any }> {
  if (!RUNPOD_API_KEY) {
    return { available: false, healthy: false, workers: null };
  }
  try {
    const resp = await fetch(`${RUNPOD_BASE_URL}/health`, {
      headers: { "Authorization": `Bearer ${RUNPOD_API_KEY}` },
    });
    if (!resp.ok) return { available: false, healthy: false, workers: null };
    const data = await resp.json() as any;
    const w = data.workers || {};
    const hasHealthyWorkers = (w.idle || 0) + (w.ready || 0) + (w.running || 0) > 0;
    const hasUnhealthy = (w.unhealthy || 0) > 0;
    const isInitializing = (w.initializing || 0) > 0;
    const healthy = hasHealthyWorkers || isInitializing || !hasUnhealthy;
    return { available: true, healthy, workers: data };
  } catch {
    return { available: false, healthy: false, workers: null };
  }
}

export function isRunPodConfigured(): boolean {
  return !!RUNPOD_API_KEY;
}

export const WHISPER_PROMPT = "Стрим на русском языке. Покерные термины: олл-ин, колл, фолд, рейз, блеф, чек, бет, флоп, тёрн, ривер, бэд-бит, кулер, сет, флеш, стрит, каре, фулл-хаус, баунти, ITM, шов, пуш, ре-рейз, 3-бет, банкролл, стэк, баббл, тильт, переезд. Стримерская лексика: донат, подписка, стримить, чат, лайк.";

export async function submitWhisperXTranscribeAlignJob(
  audioUrl: string,
  language: string = "ru",
  modelSize: string = "large-v3",
  batchSize: number = 32,
  initialPrompt?: string
): Promise<string> {
  if (!RUNPOD_API_KEY) {
    throw new Error("RUNPOD_API_KEY not configured");
  }

  const prompt = initialPrompt || WHISPER_PROMPT;
  plog(`Submitting Whisper transcribe+align job: lang=${language}, model=${modelSize}, engine=openai-whisper`);

  const runResp = await fetch(`${RUNPOD_WHISPERX_BASE_URL}/run`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RUNPOD_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: {
        mode: "transcribe_align",
        audio_url: audioUrl,
        audio: audioUrl,
        language: language,
        model: modelSize,
        batch_size: batchSize,
        initial_prompt: prompt,
      },
      policy: {
        executionTimeout: 3600000,
      },
    }),
  });

  if (!runResp.ok) {
    const errText = await runResp.text();
    throw new Error(`RunPod WhisperX transcribe+align /run failed (${runResp.status}): ${errText}`);
  }

  const runData = await runResp.json() as { id: string; status: string };
  plog(`WhisperX transcribe+align job submitted: ${runData.id}, status: ${runData.status}`);
  return runData.id;
}

export async function runWhisperXTranscribeAlign(
  audioUrl: string,
  language: string = "ru"
): Promise<WhisperXResult> {
  const jobId = await submitWhisperXTranscribeAlignJob(audioUrl, language);
  return pollWhisperXAlignJob(jobId);
}

export async function submitWhisperXAlignJob(
  audioUrl: string,
  segments: Array<{ start: number; end: number; text: string }>,
  language: string = "ru"
): Promise<string> {
  if (!RUNPOD_API_KEY) {
    throw new Error("RUNPOD_API_KEY not configured");
  }

  plog(`Submitting WhisperX align job: ${segments.length} segments, lang=${language}`);

  const runResp = await fetch(`${RUNPOD_WHISPERX_BASE_URL}/run`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RUNPOD_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: {
        mode: "align_only",
        audio_url: audioUrl,
        audio: audioUrl,
        segments: segments,
        language: language,
      },
      policy: {
        executionTimeout: 3600000,
      },
    }),
  });

  if (!runResp.ok) {
    const errText = await runResp.text();
    throw new Error(`RunPod WhisperX /run failed (${runResp.status}): ${errText}`);
  }

  const runData = await runResp.json() as { id: string; status: string };
  plog(`WhisperX align job submitted: ${runData.id}, status: ${runData.status}`);
  return runData.id;
}

export async function pollWhisperXAlignJob(jobId: string): Promise<WhisperXResult> {
  if (!RUNPOD_API_KEY) {
    throw new Error("RUNPOD_API_KEY not configured");
  }

  plog(`Polling WhisperX align job: ${jobId}`);

  const MAX_POLL_TIME = 45 * 60 * 1000;
  const MAX_QUEUE_TIME = 30 * 60 * 1000;
  const POLL_INTERVAL = 5000;
  const startTime = Date.now();
  let queueStartTime = Date.now();
  let wasInProgress = false;

  while (Date.now() - startTime < MAX_POLL_TIME) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));

    const statusResp = await fetch(`${RUNPOD_WHISPERX_BASE_URL}/status/${jobId}`, {
      headers: { "Authorization": `Bearer ${RUNPOD_API_KEY}` },
    });

    if (statusResp.status === 404) {
      plog(`WhisperX align job ${jobId} not found (404)`);
      throw new Error("RunPod WhisperX align job not found");
    }

    if (!statusResp.ok) {
      plog(`WhisperX align status check failed: ${statusResp.status}`);
      continue;
    }

    const statusData = await statusResp.json() as RunPodStatus;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

    if (statusData.status === "COMPLETED") {
      plog(`WhisperX align job completed in ${elapsed}s, execTime: ${statusData.executionTime}ms`);
      if (!statusData.output) {
        throw new Error("RunPod WhisperX returned COMPLETED but no output");
      }
      if (statusData.output.error) {
        throw new Error(`RunPod WhisperX worker error: ${statusData.output.error}`);
      }
      return normalizeOutput(statusData.output);
    }

    if (statusData.status === "FAILED" || statusData.status === "TIMED_OUT" || statusData.status === "CANCELLED") {
      throw new Error(`RunPod WhisperX job ${statusData.status}: ${statusData.error || "unknown error"}`);
    }

    if (statusData.status === "IN_PROGRESS") {
      wasInProgress = true;
    }

    if (statusData.status === "IN_QUEUE" && !wasInProgress && (Date.now() - queueStartTime > MAX_QUEUE_TIME)) {
      plog(`WhisperX align job stuck IN_QUEUE for ${MAX_QUEUE_TIME / 1000}s — cancelling`);
      try {
        await fetch(`${RUNPOD_WHISPERX_BASE_URL}/cancel/${jobId}`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${RUNPOD_API_KEY}` },
        });
      } catch {}
      throw new Error(`RunPod WhisperX: no GPU workers available (IN_QUEUE > ${MAX_QUEUE_TIME / 1000}s)`);
    }

    if (Number(elapsed) % 30 < 6) {
      plog(`WhisperX align polling... status=${statusData.status}, elapsed=${elapsed}s`);
    }
  }

  throw new Error(`RunPod WhisperX align job timed out after ${MAX_POLL_TIME / 1000}s`);
}

export async function runWhisperXAlignment(
  audioUrl: string,
  segments: Array<{ start: number; end: number; text: string }>,
  language: string = "ru"
): Promise<WhisperXResult> {
  const jobId = await submitWhisperXAlignJob(audioUrl, segments, language);
  return pollWhisperXAlignJob(jobId);
}

export async function submitWhisperTranscribeOnlyJob(
  audioUrl: string,
  language: string = "ru",
): Promise<string> {
  if (!RUNPOD_API_KEY) {
    throw new Error("RUNPOD_API_KEY not configured");
  }

  plog(`Submitting transcribe-only job (faster-whisper): lang=${language}`);

  const runResp = await fetch(`${RUNPOD_BASE_URL}/run`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RUNPOD_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: {
        audio: audioUrl,
        model: "large-v3",
        language: language,
        word_timestamps: true,
        transcription: "plain_text",
        enable_vad: true,
        initial_prompt: WHISPER_PROMPT,
      },
      policy: {
        executionTimeout: 3600000,
      },
    }),
  });

  if (!runResp.ok) {
    const errText = await runResp.text();
    throw new Error(`RunPod transcribe-only /run failed (${runResp.status}): ${errText}`);
  }

  const runData = await runResp.json() as { id: string; status: string };
  plog(`Transcribe-only job submitted: ${runData.id}, status: ${runData.status}`);
  return runData.id;
}

export async function runWhisperTranscribeOnly(
  audioUrl: string,
  language: string = "ru"
): Promise<WhisperXResult> {
  const jobId = await submitWhisperTranscribeOnlyJob(audioUrl, language);
  return pollWhisperXJob(jobId);
}

const RUNPOD_POD_ID = process.env.RUNPOD_POD_ID || "jlozmxn8xfcjae";
const RUNPOD_GRAPHQL_URL = "https://api.runpod.io/graphql";

let podAutoStopTimer: ReturnType<typeof setTimeout> | null = null;
const POD_AUTO_STOP_DELAY_MS = 5 * 60 * 1000;
let activeGpuJobs = 0;

export function acquireGpuLease(): void {
  activeGpuJobs++;
  if (podAutoStopTimer) {
    clearTimeout(podAutoStopTimer);
    podAutoStopTimer = null;
  }
  console.log(`[runpod-pod] GPU lease acquired (active: ${activeGpuJobs})`);
}

export function releaseGpuLease(): void {
  activeGpuJobs = Math.max(0, activeGpuJobs - 1);
  console.log(`[runpod-pod] GPU lease released (active: ${activeGpuJobs})`);
}

async function runpodGraphql(query: string, variables?: Record<string, any>): Promise<any> {
  const resp = await fetch(RUNPOD_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${RUNPOD_API_KEY}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`RunPod GraphQL error: ${resp.status} ${text}`);
  }
  return resp.json();
}

export async function getPodStatus(): Promise<{ id: string; name: string; desiredStatus: string; runtime: any; machine: any; gpuCount: number }> {
  if (!RUNPOD_API_KEY) throw new Error("RUNPOD_API_KEY not configured");
  const result = await runpodGraphql(`
    query Pod($input: PodFilter!) {
      pod(input: $input) {
        id name desiredStatus gpuCount
        runtime { uptimeInSeconds gpus { id } }
        machine { gpuDisplayName }
      }
    }
  `, { input: { podId: RUNPOD_POD_ID } });
  if (result.errors) throw new Error(`RunPod: ${result.errors[0]?.message || JSON.stringify(result.errors)}`);
  if (!result.data?.pod) throw new Error(`Pod ${RUNPOD_POD_ID} not found`);
  return result.data.pod;
}

export async function startPod(): Promise<{ id: string; desiredStatus: string }> {
  if (!RUNPOD_API_KEY) throw new Error("RUNPOD_API_KEY not configured");
  console.log(`[runpod-pod] Starting pod ${RUNPOD_POD_ID}...`);
  const result = await runpodGraphql(`
    mutation PodResume($input: PodResumeInput!) {
      podResume(input: $input) {
        id desiredStatus gpuCount
      }
    }
  `, { input: { podId: RUNPOD_POD_ID, gpuCount: 1 } });
  if (result.errors) throw new Error(`RunPod start: ${result.errors[0]?.message || JSON.stringify(result.errors)}`);
  return result.data.podResume;
}

export async function stopPod(): Promise<{ id: string; desiredStatus: string }> {
  if (!RUNPOD_API_KEY) throw new Error("RUNPOD_API_KEY not configured");
  console.log(`[runpod-pod] Stopping pod ${RUNPOD_POD_ID}...`);
  const result = await runpodGraphql(`
    mutation PodStop($input: PodStopInput!) {
      podStop(input: $input) {
        id desiredStatus
      }
    }
  `, { input: { podId: RUNPOD_POD_ID } });
  if (result.errors) throw new Error(`RunPod stop: ${result.errors[0]?.message || JSON.stringify(result.errors)}`);
  return result.data.podStop;
}

export async function ensurePodRunning(): Promise<void> {
  if (podAutoStopTimer) {
    clearTimeout(podAutoStopTimer);
    podAutoStopTimer = null;
  }

  const pod = await getPodStatus();
  if (pod.desiredStatus === "RUNNING" && pod.runtime?.uptimeInSeconds > 0) {
    console.log(`[runpod-pod] Pod already running (uptime: ${pod.runtime.uptimeInSeconds}s)`);
    const healthy = await checkPodServerHealth();
    if (healthy) return;
    console.log(`[runpod-pod] Pod running but pod-server not responding yet, waiting...`);
  }

  if (pod.desiredStatus !== "RUNNING") {
    await startPod();
  }

  console.log(`[runpod-pod] Waiting for pod to be ready...`);
  const maxWait = 180000;
  const start = Date.now();
  let podRunning = false;
  while (Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      if (!podRunning) {
        const status = await getPodStatus();
        if (status.desiredStatus === "RUNNING" && status.runtime?.uptimeInSeconds > 0) {
          console.log(`[runpod-pod] Pod container is up (uptime: ${status.runtime.uptimeInSeconds}s), waiting for pod-server.py...`);
          podRunning = true;
        } else {
          console.log(`[runpod-pod] Container still starting...`);
          continue;
        }
      }
      const healthy = await checkPodServerHealth();
      if (healthy) {
        console.log(`[runpod-pod] Pod server is ready and healthy`);
        return;
      }
      console.log(`[runpod-pod] pod-server.py not ready yet, retrying...`);
    } catch (e) {
      console.log(`[runpod-pod] Still waiting... ${(e as Error).message}`);
    }
  }
  throw new Error("Pod did not become ready within 3 minutes");
}

const RUNPOD_POD_URL = process.env.RUNPOD_POD_URL || `https://${RUNPOD_POD_ID}-8788.proxy.runpod.net`;

async function checkPodServerHealth(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(`${RUNPOD_POD_URL}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return false;
    const data = await resp.json() as any;
    return data.ffmpeg?.ready === true;
  } catch {
    return false;
  }
}

export function schedulePodAutoStop(): void {
  if (podAutoStopTimer) {
    clearTimeout(podAutoStopTimer);
  }
  console.log(`[runpod-pod] Scheduling auto-stop in ${POD_AUTO_STOP_DELAY_MS / 1000}s`);
  podAutoStopTimer = setTimeout(async () => {
    try {
      const pod = await getPodStatus();
      if (pod.desiredStatus === "RUNNING") {
        console.log(`[runpod-pod] Auto-stopping pod after idle timeout`);
        await stopPod();
      }
    } catch (e) {
      console.error(`[runpod-pod] Auto-stop error:`, e);
    }
    podAutoStopTimer = null;
  }, POD_AUTO_STOP_DELAY_MS);
}

export async function checkWhisperXAlignHealth(): Promise<{ available: boolean; healthy: boolean; workers: any }> {
  if (!RUNPOD_API_KEY) {
    return { available: false, healthy: false, workers: null };
  }
  try {
    const resp = await fetch(`${RUNPOD_WHISPERX_BASE_URL}/health`, {
      headers: { "Authorization": `Bearer ${RUNPOD_API_KEY}` },
    });
    if (!resp.ok) return { available: false, healthy: false, workers: null };
    const data = await resp.json() as any;
    return { available: true, healthy: true, workers: data };
  } catch {
    return { available: false, healthy: false, workers: null };
  }
}
