import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { storage } from "./storage";
import { isRunPodConfigured, checkWhisperXAlignHealth } from "./runpod-client";
import { resumeRunPodPipeline } from "./ai-pipeline";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use((req, res, next) => {
  if (req.path === "/api/upload" || req.path === "/api/videos/upload") {
    return next();
  }
  express.json({
    limit: "10mb",
    verify: (req: any, _res: any, buf: any) => {
      req.rawBody = buf;
    },
  })(req, res, next);
});

app.use((req, res, next) => {
  if (req.path === "/api/upload" || req.path === "/api/videos/upload") {
    return next();
  }
  express.urlencoded({ extended: false })(req, res, next);
});

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    async () => {
      log(`serving on port ${port}`);

      setTimeout(async () => {
        try {
          // Reset stuck "processing" auto-cuts to "queued" so they can be restarted
          const allAutoCuts = await storage.getAutoCuts();
          const stuckCuts = allAutoCuts.filter((c: any) => c.status === "processing");
          for (const cut of stuckCuts) {
            await storage.updateAutoCut(cut.id, { status: "queued", progress: 0 });
            log(`[auto-resume] Reset stuck auto-cut ${cut.id} → queued`);
          }
          if (stuckCuts.length > 0) log(`[auto-resume] Reset ${stuckCuts.length} stuck auto-cut(s) to queued`);
        } catch (err: any) {
          log(`[auto-resume] Error resetting auto-cuts: ${err.message}`);
        }
      }, 2000);

      setTimeout(async () => {
        try {
          const runpodReady = isRunPodConfigured();
          log(`[auto-resume] RunPod configured: ${runpodReady}`);
          const stuckVideos = await storage.getStuckProcessingVideos();
          log(`[auto-resume] Found ${stuckVideos.length} stuck processing video(s)`);
          if (stuckVideos.length > 0) {
            for (const v of stuckVideos) {
              log(`[auto-resume] Video ${v.id}: step=${v.pipelineStep}, error=${v.pipelineError?.substring(0, 80)}`);
              const runpodMatch = v.pipelineError?.match(/^runpod_(whisperx_)?job:([^:]+)(:transcribe_only)?$/);
              if (runpodMatch && runpodReady) {
                const isWhisperXJob = !!runpodMatch[1];
                const jobId = runpodMatch[2];
                const isTranscribeOnly = !!runpodMatch[3];
                log(`[auto-resume] Resuming RunPod ${isWhisperXJob ? 'WhisperX' : 'Faster Whisper'} job ${jobId} for video ${v.id} (transcribeOnly: ${isTranscribeOnly})`);
                resumeRunPodPipeline(v.id, v.vpsVideoId!, jobId, isWhisperXJob, isTranscribeOnly).catch((err: any) => {
                  log(`[auto-resume] RunPod resume failed for ${v.id}: ${err.message}`);
                });
              } else {
                await storage.updateVideo(v.id, {
                  status: "error",
                  pipelineStep: "error",
                  pipelineError: "Pipeline прервана при перезапуске сервера. Нажмите «Перезапустить» для повторной обработки.",
                });
                log(`[auto-resume] Reset stuck video: ${v.id} (was at ${v.pipelineStep} ${v.pipelineProgress}%)`);
              }
            }
          }
        } catch (err: any) {
          log(`[auto-resume] Error checking stuck videos: ${err.message}`);
        }
      }, 3000);
    },
  );
})();
