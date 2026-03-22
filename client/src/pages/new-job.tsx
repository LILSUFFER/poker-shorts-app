import { useState, useRef } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Upload,
  Link,
  FileVideo,
  Loader2,
  ArrowLeft,
  Zap,
  AlertCircle,
  Cookie,
  X,
  ClipboardPaste,
  Scissors,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { StreamerProfile, ContentType } from "@shared/schema";

const MAX_FILE_SIZE = 4 * 1024 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `~${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `~${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`;
  return `~${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

interface NewJobProps {
  contentType: ContentType;
}

export default function NewJob({ contentType }: NewJobProps) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [mode, setMode] = useState<"url" | "upload">("upload");
  const [sourceUrl, setSourceUrl] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadSpeed, setUploadSpeed] = useState(0);
  const [uploadEta, setUploadEta] = useState(0);
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const lastProgressRef = useRef<{ time: number; loaded: number }>({ time: 0, loaded: 0 });
  const cookiesInputRef = useRef<HTMLInputElement>(null);
  const [cookiePasteOpen, setCookiePasteOpen] = useState(false);
  const [cookiePasteText, setCookiePasteText] = useState("");
  const [cookiePasting, setCookiePasting] = useState(false);
  const [processMode, setProcessMode] = useState<"highlights" | "all">("highlights");
  const [ytQuality, setYtQuality] = useState<string>("1080");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileDuration, setFileDuration] = useState<number>(0);
  const [trimEnabled, setTrimEnabled] = useState(false);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const previewVideoRef = useRef<HTMLVideoElement>(null);

  const { data: cookiesStatus } = useQuery<{ exists: boolean; entries?: number; modifiedAt?: string | null; vps?: boolean }>({
    queryKey: ["/api/cookies-status"],
  });

  const { data: profiles = [] } = useQuery<StreamerProfile[]>({
    queryKey: ["/api/profiles"],
    queryFn: async () => {
      const res = await fetch("/api/profiles");
      if (!res.ok) throw new Error("Failed to fetch profiles");
      return res.json();
    },
  });

  const handleProfileChange = (value: string) => {
    setSelectedProfileId(value === "__none__" ? "" : value);
  };

  const isTwitchUrl = (url: string) => /^(https?:\/\/)?(www\.|clips\.)?twitch\.tv\//.test(url);
  const isYoutubeUrl = (url: string) => /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//.test(url);
  const isKickUrl = (url: string) => /^(https?:\/\/)?(www\.)?kick\.com\//.test(url);
  const isGdriveUrl = (url: string) => /^(https?:\/\/)?(drive\.google\.com|docs\.google\.com)\//.test(url);
  const isVkVideoUrl = (url: string) => /^(https?:\/\/)?(www\.)?(vkvideo\.ru|vk\.com\/video)/.test(url);

  const [urlTrimEnabled, setUrlTrimEnabled] = useState(false);
  const [urlTrimStartStr, setUrlTrimStartStr] = useState("0:00");
  const [urlTrimEndStr, setUrlTrimEndStr] = useState("3:00");

  const parseTimeStr = (str: string): number => {
    const parts = str.split(":").map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] || 0;
  };

  const urlMutation = useMutation({
    mutationFn: async () => {
      const endpoint = isVkVideoUrl(sourceUrl) ? "/api/videos/vkvideo" : isGdriveUrl(sourceUrl) ? "/api/videos/gdrive" : isKickUrl(sourceUrl) ? "/api/videos/kick" : isTwitchUrl(sourceUrl) ? "/api/videos/twitch" : "/api/videos/youtube";
      const trimPayload = urlTrimEnabled ? { trimStart: parseTimeStr(urlTrimStartStr), trimEnd: parseTimeStr(urlTrimEndStr) } : {};
      const res = await apiRequest("POST", endpoint, {
        url: sourceUrl,
        profileId: selectedProfileId || undefined,
        contentType,
        ...(isYoutubeUrl(sourceUrl) && ytQuality !== "1080" ? { maxHeight: parseInt(ytQuality) } : {}),
        ...trimPayload,
      });
      return res.json();
    },
    onSuccess: async (video: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/videos"] });
      const trimPayload = urlTrimEnabled ? { trimStart: parseTimeStr(urlTrimStartStr), trimEnd: parseTimeStr(urlTrimEndStr) } : {};
      await apiRequest("POST", `/api/videos/${video.id}/process`, {
        mode: processMode === "all" ? "all" : "ai",
        analysisMode: processMode,
        ...(isYoutubeUrl(sourceUrl) && ytQuality !== "1080" ? { maxHeight: parseInt(ytQuality) } : {}),
        ...trimPayload,
      });
      setLocation(`/video/${video.id}`);
    },
  });

  const xhrUpload = (url: string, formData: FormData, headers?: Record<string, string>) => {
    return new Promise<any>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          setUploadProgress(pct);
          setUploadedBytes(e.loaded);

          const now = Date.now();
          const prev = lastProgressRef.current;
          const elapsed = (now - prev.time) / 1000;

          if (elapsed > 0.5) {
            const bytesDelta = e.loaded - prev.loaded;
            const speed = bytesDelta / elapsed;
            const remaining = e.total - e.loaded;
            const eta = speed > 0 ? remaining / speed : 0;

            setUploadSpeed(speed);
            setUploadEta(eta);
            lastProgressRef.current = { time: now, loaded: e.loaded };
          }
        }
      });
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          try {
            const err = JSON.parse(xhr.responseText);
            reject(new Error(err.message || err.error || `Upload failed: ${xhr.status}`));
          } catch {
            reject(new Error(`Upload failed: ${xhr.status}`));
          }
        }
      };
      xhr.onerror = () => reject(new Error("Ошибка сети при загрузке"));

      xhr.open("POST", url);
      if (headers) {
        Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
      }
      xhr.send(formData);
    });
  };

  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  const handleFileSelect = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (file.size > MAX_FILE_SIZE) {
      setUploadError(`Файл слишком большой: ${formatBytes(file.size)}. Максимум ${formatBytes(MAX_FILE_SIZE)}.`);
      return;
    }
    setSelectedFile(file);
    setUploadError(null);
    setTrimEnabled(false);
    setTrimStart(0);
    setTrimEnd(0);
    setFileDuration(0);

    const url = URL.createObjectURL(file);
    const vid = document.createElement("video");
    vid.preload = "metadata";
    vid.onloadedmetadata = () => {
      const dur = vid.duration;
      setFileDuration(dur);
      setTrimEnd(Math.floor(dur));
      URL.revokeObjectURL(url);
    };
    vid.src = url;
  };

  const handleFileUpload = async () => {
    if (!selectedFile) return;

    if (selectedFile.size > MAX_FILE_SIZE) {
      setUploadError(`Файл слишком большой: ${formatBytes(selectedFile.size)}. Максимум ${formatBytes(MAX_FILE_SIZE)}.`);
      return;
    }

    const file = selectedFile;

    setIsUploading(true);
    setUploadProgress(0);
    setUploadSpeed(0);
    setUploadEta(0);
    setUploadedBytes(0);
    setTotalBytes(file.size);
    setUploadError(null);
    lastProgressRef.current = { time: Date.now(), loaded: 0 };

    try {
      const configRes = await fetch("/api/upload/config");
      const config = await configRes.json();

      let videoData: any;

      if (config.direct && config.vpsUrl && config.vpsToken) {
        const vpsFormData = new FormData();
        vpsFormData.append("file", file);

        const vpsData = await xhrUpload(
          `${config.vpsUrl}/upload`,
          vpsFormData,
          { "Authorization": `Bearer ${config.vpsToken}` }
        );

        if (trimEnabled && (trimStart > 0 || trimEnd < fileDuration)) {
          setUploadProgress(100);
          toast({ title: "Обрезка видео на сервере..." });
          const trimRes = await fetch(`${config.vpsUrl}/trim/${vpsData.videoId}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${config.vpsToken}`,
            },
            body: JSON.stringify({ startTime: trimStart, endTime: trimEnd }),
          });
          if (!trimRes.ok) {
            const trimErr = await trimRes.json().catch(() => ({}));
            throw new Error(trimErr.error || "Trim failed");
          }
        }

        const regRes = await apiRequest("POST", "/api/videos/register", {
          vpsVideoId: vpsData.videoId,
          vpsPath: vpsData.storedPath,
          originalName: file.name,
          fileSize: vpsData.sizeBytes,
          profileId: selectedProfileId || undefined,
          contentType,
        });
        videoData = await regRes.json();
      } else {
        const formData = new FormData();
        formData.append("file", file);
        if (selectedProfileId) formData.append("profileId", selectedProfileId);
        formData.append("contentType", contentType);
        videoData = await xhrUpload("/api/upload", formData);
      }

      queryClient.invalidateQueries({ queryKey: ["/api/videos"] });

      try {
        await apiRequest("POST", `/api/videos/${videoData.id}/process`, {
          mode: processMode === "all" ? "all" : "ai",
          analysisMode: processMode,
        });
      } catch {
      }

      setLocation(`/video/${videoData.id}`);
    } catch (err: any) {
      setUploadError(err.message || "Ошибка загрузки");
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
      setUploadSpeed(0);
      setUploadEta(0);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    handleFileSelect(e.dataTransfer.files);
  };

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setLocation("/")}
            data-testid="button-back"
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div>
            <h1 className="text-xl font-medium tracking-tight" data-testid="text-new-job-title">
              {contentType === "poker" ? "Покер — новая задача" : "Стример — новая задача"}
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Загрузка файла или ссылка YouTube / Twitch / Kick / Google Drive
            </p>
          </div>
        </div>

        <div className="flex gap-2">
          <Button
            variant={mode === "upload" ? "default" : "outline"}
            onClick={() => setMode("upload")}
            className="toggle-elevate"
            data-testid="button-mode-upload"
          >
            <Upload className="w-4 h-4 mr-2" />
            Файл
          </Button>
          <Button
            variant={mode === "url" ? "default" : "outline"}
            onClick={() => setMode("url")}
            className="toggle-elevate"
            data-testid="button-mode-url"
          >
            <Link className="w-4 h-4 mr-2" />
            Ссылка
          </Button>
        </div>

        <Card>
          <CardContent className="p-5 space-y-4">
            <div>
              <label className="text-sm text-muted-foreground mb-1.5 block">Профиль стримера (опционально)</label>
              <Select value={selectedProfileId || "__none__"} onValueChange={handleProfileChange}>
                <SelectTrigger data-testid="select-profile">
                  <SelectValue placeholder="Без профиля" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Без профиля</SelectItem>
                  {profiles.map((p) => (
                    <SelectItem key={p.id} value={p.id} data-testid={`select-profile-${p.id}`}>
                      {p.name}
                      {p.calibration && " (калиброван)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-sm text-muted-foreground mb-1.5 block">Режим обработки</label>
              <div className="flex gap-2">
                <Button
                  variant={processMode === "highlights" ? "default" : "outline"}
                  onClick={() => setProcessMode("highlights")}
                  className="flex-1 toggle-elevate"
                  data-testid="button-process-mode-highlights"
                >
                  <Zap className="w-4 h-4 mr-2" />
                  AI хайлайты
                </Button>
                <Button
                  variant={processMode === "all" ? "default" : "outline"}
                  onClick={() => setProcessMode("all")}
                  className="flex-1 toggle-elevate"
                  data-testid="button-process-mode-all"
                >
                  <Scissors className="w-4 h-4 mr-2" />
                  Все моменты
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-1.5">
                {processMode === "highlights"
                  ? "AI ищет самые яркие, хуковые моменты"
                  : "AI собирает все моменты подряд, без пропусков"}
              </p>
            </div>

            {mode === "upload" ? (
              <div className="space-y-4">
                <div
                  onDrop={(e) => { e.preventDefault(); setIsDragOver(false); handleFileSelect(e.dataTransfer.files); }}
                  onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
                  onDragLeave={() => setIsDragOver(false)}
                  className={`border border-dashed rounded-md p-10 text-center transition-colors cursor-pointer ${
                    isDragOver
                      ? "border-primary bg-primary/5"
                      : "border-border hover-elevate"
                  }`}
                  onClick={() => !isUploading && document.getElementById("video-upload")?.click()}
                  data-testid="dropzone-upload"
                >
                  <input
                    id="video-upload"
                    type="file"
                    accept="video/*"
                    className="hidden"
                    onChange={(e) => handleFileSelect(e.target.files)}
                    data-testid="input-video-upload"
                  />
                  <FileVideo className="w-8 h-8 mx-auto text-muted-foreground mb-3" />
                  <p className="text-sm text-foreground">
                    {isUploading ? "Загрузка..." : selectedFile ? selectedFile.name : "Перетащи видео или нажми"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {selectedFile
                      ? `${formatBytes(selectedFile.size)}${fileDuration > 0 ? ` · ${formatTime(fileDuration)}` : ""}`
                      : "MP4, MKV, AVI, MOV (до 4 GB)"}
                  </p>
                </div>

                {selectedFile && fileDuration > 0 && !isUploading && (
                  <div className="space-y-3 p-3 rounded-md border border-border bg-muted/30">
                    <div className="flex items-center justify-between">
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={trimEnabled}
                          onChange={(e) => setTrimEnabled(e.target.checked)}
                          className="rounded"
                          data-testid="checkbox-trim-enabled"
                        />
                        <Scissors className="w-3.5 h-3.5" />
                        Обрезать видео
                      </label>
                      {trimEnabled && (
                        <span className="text-xs text-muted-foreground font-mono" data-testid="text-trim-range">
                          {formatTime(trimStart)} — {formatTime(trimEnd)} ({formatTime(trimEnd - trimStart)})
                        </span>
                      )}
                    </div>

                    {trimEnabled && (
                      <div className="space-y-2">
                        <div className="relative h-8">
                          <input
                            type="range"
                            min={0}
                            max={Math.floor(fileDuration)}
                            value={trimStart}
                            onChange={(e) => {
                              const v = Number(e.target.value);
                              setTrimStart(Math.min(v, trimEnd - 10));
                            }}
                            className="absolute inset-0 w-full pointer-events-auto appearance-none bg-transparent z-10 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-green-500 [&::-webkit-slider-thumb]:cursor-pointer"
                            data-testid="slider-trim-start"
                          />
                          <input
                            type="range"
                            min={0}
                            max={Math.floor(fileDuration)}
                            value={trimEnd}
                            onChange={(e) => {
                              const v = Number(e.target.value);
                              setTrimEnd(Math.max(v, trimStart + 10));
                            }}
                            className="absolute inset-0 w-full pointer-events-auto appearance-none bg-transparent z-20 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-red-500 [&::-webkit-slider-thumb]:cursor-pointer"
                            data-testid="slider-trim-end"
                          />
                          <div className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-1.5 bg-muted-foreground/20 rounded-full">
                            <div
                              className="absolute h-full bg-primary/60 rounded-full"
                              style={{
                                left: `${(trimStart / fileDuration) * 100}%`,
                                width: `${((trimEnd - trimStart) / fileDuration) * 100}%`,
                              }}
                            />
                          </div>
                        </div>
                        <div className="flex gap-3">
                          <div className="flex-1">
                            <label className="text-xs text-muted-foreground">Начало</label>
                            <Input
                              value={formatTime(trimStart)}
                              onChange={(e) => {
                                const parts = e.target.value.split(":");
                                if (parts.length === 2) {
                                  const sec = parseInt(parts[0]) * 60 + parseInt(parts[1]);
                                  if (!isNaN(sec) && sec < trimEnd - 10) setTrimStart(Math.max(0, sec));
                                }
                              }}
                              className="h-8 text-xs font-mono"
                              data-testid="input-trim-start"
                            />
                          </div>
                          <div className="flex-1">
                            <label className="text-xs text-muted-foreground">Конец</label>
                            <Input
                              value={formatTime(trimEnd)}
                              onChange={(e) => {
                                const parts = e.target.value.split(":");
                                if (parts.length === 2) {
                                  const sec = parseInt(parts[0]) * 60 + parseInt(parts[1]);
                                  if (!isNaN(sec) && sec > trimStart + 10) setTrimEnd(Math.min(Math.floor(fileDuration), sec));
                                }
                              }}
                              className="h-8 text-xs font-mono"
                              data-testid="input-trim-end"
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {selectedFile && !isUploading && (
                  <Button
                    onClick={() => handleFileUpload()}
                    className="w-full"
                    data-testid="button-start-upload"
                  >
                    <Upload className="w-4 h-4 mr-2" />
                    Загрузить{trimEnabled ? ` (${formatTime(trimStart)}–${formatTime(trimEnd)})` : ""}
                  </Button>
                )}

                {isUploading && (
                  <div className="space-y-2">
                    <Progress value={uploadProgress} className="h-1.5" />
                    <div className="flex items-center justify-between gap-4 flex-wrap">
                      <span className="text-xs text-muted-foreground font-mono" data-testid="text-upload-progress">
                        {uploadProgress}% &middot; {formatBytes(uploadedBytes)} / {formatBytes(totalBytes)}
                      </span>
                      <span className="text-xs text-muted-foreground font-mono" data-testid="text-upload-speed">
                        {uploadSpeed > 0 ? formatSpeed(uploadSpeed) : "..."} &middot; {uploadEta > 0 ? formatEta(uploadEta) : "..."}
                      </span>
                    </div>
                  </div>
                )}

                {uploadError && (
                  <div className="flex items-center gap-2 text-destructive">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />
                    <p className="text-sm" data-testid="text-upload-error">{uploadError}</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="text-sm text-muted-foreground mb-1.5 block">YouTube / Twitch / Kick / VK Video / Google Drive URL</label>
                  <Input
                    placeholder="https://youtube.com/watch?v=... или https://vkvideo.ru/video..."
                    value={sourceUrl}
                    onChange={(e) => setSourceUrl(e.target.value)}
                    data-testid="input-source-url"
                    className="font-mono text-sm"
                  />
                  {sourceUrl.trim() && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {isVkVideoUrl(sourceUrl)
                        ? "VK Video"
                        : isGdriveUrl(sourceUrl)
                          ? "Google Drive файл"
                          : isKickUrl(sourceUrl)
                            ? "Kick видео"
                            : isTwitchUrl(sourceUrl)
                              ? "Twitch клип"
                              : isYoutubeUrl(sourceUrl)
                                ? "YouTube видео"
                                : "Вставьте ссылку YouTube, Twitch, Kick, VK Video или Google Drive"}
                    </p>
                  )}
                  {isYoutubeUrl(sourceUrl) && (
                    <div className="flex items-center gap-2 mt-2">
                      <label className="text-xs text-muted-foreground whitespace-nowrap">Качество:</label>
                      <Select value={ytQuality} onValueChange={setYtQuality}>
                        <SelectTrigger className="w-[130px] h-8 text-xs" data-testid="select-yt-quality">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="2160">2160p (4K)</SelectItem>
                          <SelectItem value="1440">1440p (2K)</SelectItem>
                          <SelectItem value="1080">1080p (HD)</SelectItem>
                          <SelectItem value="720">720p</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>

                {!isTwitchUrl(sourceUrl) && !isKickUrl(sourceUrl) && !isVkVideoUrl(sourceUrl) && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <input
                      ref={cookiesInputRef}
                      type="file"
                      accept=".txt"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const fd = new FormData();
                        fd.append("file", file);
                        try {
                          const res = await fetch("/api/cookies", { method: "POST", body: fd });
                          const data = await res.json();
                          if (!res.ok) { toast({ title: "Ошибка", description: data.message, variant: "destructive" }); return; }
                          toast({ title: "Cookies загружены", description: data.entries ? `${data.entries} записей сохранено на сервере` : "Готово к скачиванию в HD" });
                          queryClient.invalidateQueries({ queryKey: ["/api/cookies-status"] });
                        } catch (err: any) { toast({ title: "Ошибка", description: err.message, variant: "destructive" }); }
                        e.target.value = "";
                      }}
                      data-testid="input-cookies-file"
                    />
                    {cookiesStatus?.exists ? (
                      <Badge variant="secondary" className="text-xs gap-1">
                        <Cookie className="w-3 h-3" />
                        Cookies YT ({cookiesStatus.entries || "?"} записей)
                        <button className="ml-0.5 opacity-60 hover:opacity-100" onClick={async () => {
                          await fetch("/api/cookies", { method: "DELETE" });
                          queryClient.invalidateQueries({ queryKey: ["/api/cookies-status"] });
                          toast({ title: "Cookies удалены" });
                        }} data-testid="button-cookies-delete"><X className="w-2.5 h-2.5" /></button>
                      </Badge>
                    ) : (
                      <div className="flex items-center gap-1">
                        <Button variant="outline" size="sm" onClick={() => cookiesInputRef.current?.click()} data-testid="button-cookies-upload">
                          <Cookie className="w-3 h-3 mr-1" />
                          Файл .txt
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => { setCookiePasteText(""); setCookiePasteOpen(true); }} data-testid="button-cookies-paste">
                          <ClipboardPaste className="w-3 h-3 mr-1" />
                          Вставить текст
                        </Button>
                      </div>
                    )}
                    <span className="text-[10px] text-muted-foreground">
                      {cookiesStatus?.exists
                        ? `Скачивание в 1080p HD${cookiesStatus.modifiedAt ? ` · обновлено ${new Date(cookiesStatus.modifiedAt).toLocaleDateString("ru")}` : ""}`
                        : "Без cookies — только 360p. Скопируйте cookies из расширения браузера"}
                    </span>
                  </div>
                )}

                <Dialog open={cookiePasteOpen} onOpenChange={setCookiePasteOpen}>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Вставить YouTube cookies</DialogTitle>
                    </DialogHeader>
                    <div className="flex flex-col gap-2">
                      <p className="text-xs text-muted-foreground">
                        Скопируйте cookies из расширения (например, EditThisCookie или Get cookies.txt) и вставьте сюда
                      </p>
                      <Textarea
                        data-testid="input-cookies-text"
                        value={cookiePasteText}
                        onChange={(e) => setCookiePasteText(e.target.value)}
                        placeholder="# Netscape HTTP Cookie File&#10;.youtube.com       TRUE    /       TRUE    ..."
                        rows={8}
                        className="font-mono text-xs"
                      />
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setCookiePasteOpen(false)} data-testid="button-cookies-paste-cancel">
                        Отмена
                      </Button>
                      <Button
                        disabled={cookiePasteText.trim().length < 50 || cookiePasting}
                        data-testid="button-cookies-paste-confirm"
                        onClick={async () => {
                          setCookiePasting(true);
                          try {
                            const res = await fetch("/api/cookies/text", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ text: cookiePasteText }),
                            });
                            const data = await res.json();
                            if (!res.ok) { toast({ title: "Ошибка", description: data.message, variant: "destructive" }); return; }
                            toast({ title: "Cookies сохранены", description: data.entries ? `${data.entries} записей` : "Готово к скачиванию в HD" });
                            queryClient.invalidateQueries({ queryKey: ["/api/cookies-status"] });
                            setCookiePasteOpen(false);
                          } catch (err: any) {
                            toast({ title: "Ошибка", description: err.message, variant: "destructive" });
                          } finally {
                            setCookiePasting(false);
                          }
                        }}
                      >
                        {cookiePasting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Cookie className="w-4 h-4 mr-2" />}
                        Сохранить
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                <div className="space-y-3 p-3 rounded-md border border-border bg-muted/30">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={urlTrimEnabled}
                      onChange={(e) => setUrlTrimEnabled(e.target.checked)}
                      className="rounded"
                      data-testid="checkbox-url-trim-enabled"
                    />
                    <Scissors className="w-3.5 h-3.5" />
                    Обрезать после скачивания
                  </label>
                  {urlTrimEnabled && (
                    <div className="flex gap-3">
                      <div className="flex-1">
                        <label className="text-xs text-muted-foreground">Начало (М:СС или Ч:ММ:СС)</label>
                        <Input
                          value={urlTrimStartStr}
                          onChange={(e) => setUrlTrimStartStr(e.target.value)}
                          placeholder="0:00"
                          className="h-8 text-xs font-mono"
                          data-testid="input-url-trim-start"
                        />
                      </div>
                      <div className="flex-1">
                        <label className="text-xs text-muted-foreground">Конец (М:СС или Ч:ММ:СС)</label>
                        <Input
                          value={urlTrimEndStr}
                          onChange={(e) => setUrlTrimEndStr(e.target.value)}
                          placeholder="3:00"
                          className="h-8 text-xs font-mono"
                          data-testid="input-url-trim-end"
                        />
                      </div>
                    </div>
                  )}
                </div>

                <Button
                  className="w-full"
                  onClick={() => urlMutation.mutate()}
                  disabled={!sourceUrl.trim() || (!isTwitchUrl(sourceUrl) && !isYoutubeUrl(sourceUrl) && !isKickUrl(sourceUrl) && !isGdriveUrl(sourceUrl) && !isVkVideoUrl(sourceUrl)) || urlMutation.isPending}
                  data-testid="button-start-download"
                >
                  {urlMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Zap className="w-4 h-4 mr-2" />
                  )}
                  {urlTrimEnabled
                    ? `Скачать ${urlTrimStartStr}–${urlTrimEndStr} и обработать`
                    : "Скачать и обработать"}
                </Button>

                {urlMutation.isError && (
                  <p className="text-sm text-destructive" data-testid="text-download-error">
                    {(urlMutation.error as Error).message}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
