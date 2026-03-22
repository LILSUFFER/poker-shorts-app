import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft,
  Download,
  Loader2,
  Clock,
  AlertCircle,
  Zap,
  Settings,
  Film,
  FileText,
  ChevronDown,
  ChevronUp,
  Play,
  Pause,
  RotateCcw,
  Rewind,
  FastForward,
  Search,
  Package,
  Plus,
  Scissors,
  Eye,
  Repeat,
  Upload,
  X,
  Trash2,
  Check,
  RefreshCw,
  Pencil,
  Volume2,
  VolumeX,
  Maximize,
  FolderOpen,
  Brain,
  Share2,
  ExternalLink,
  Cookie,
  AudioLines,
  Monitor,
  ImageIcon,
  Sparkles,
  Square,
} from "lucide-react";
import { SiYoutube, SiVk, SiTiktok, SiInstagram, SiFacebook, SiThreads } from "react-icons/si";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import type { Video, SuggestedClip, ExportJob, StreamerProfile, TranscriptSegment } from "@shared/schema";
import CalibrationDialog from "@/components/calibration-dialog";

const PROFANITY_PATTERNS = [
  /^бля/i, /^сук/i, /^еб/i, /^ёб/i, /^пизд/i, /^ху[йяюёеи]/i,
  /^муда/i, /^пидо/i, /^дерьм/i, /^залуп/i, /^гандон/i,
  /^охуе/i, /^наху/i, /^поху/i, /^заеб/i, /^отъеб/i,
  /^выеб/i, /^проеб/i, /^доеб/i, /^уеб/i, /^жоп/i,
];

function censorProfanity(word: string): string {
  for (const p of PROFANITY_PATTERNS) {
    if (p.test(word)) {
      const chars = [...word];
      if (chars.length > 1) chars[1] = "*";
      return chars.join("");
    }
  }
  return word;
}

interface VideoDetailProps {
  videoId: string;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function parseTimeInput(val: string): number | null {
  const parts = val.trim().split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}

function formatTimeFull(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}


function ClipTimelinePlayer({
  videoSrc,
  duration: durationProp,
  inTime,
  outTime,
  onInChange,
  onOutChange,
  onCreateClip,
  isCreating,
  clipTitle,
  onClipTitleChange,
  sourceWidth,
  sourceHeight,
  seekToRef,
  onTimeUpdate,
  videoElRef,
}: {
  videoSrc: string;
  duration: number;
  inTime: number | null;
  outTime: number | null;
  onInChange: (t: number | null) => void;
  onOutChange: (t: number | null) => void;
  onCreateClip?: () => void;
  isCreating?: boolean;
  clipTitle?: string;
  onClipTitleChange?: (v: string) => void;
  sourceWidth?: number | null;
  sourceHeight?: number | null;
  seekToRef?: React.MutableRefObject<((time: number) => void) | null>;
  onTimeUpdate?: (time: number) => void;
  videoElRef?: React.MutableRefObject<HTMLVideoElement | null>;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(durationProp || 0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [looping, setLooping] = useState(false);
  const loopingRef = useRef(false);
  const draggingRef = useRef<"in" | "out" | "seek" | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [realResolution, setRealResolution] = useState<{ w: number; h: number } | null>(null);

  const duration = videoDuration || durationProp || 0;

  useEffect(() => { loopingRef.current = looping; }, [looping]);

  useEffect(() => {
    if (seekToRef) {
      seekToRef.current = (time: number) => {
        const v = videoRef.current;
        if (v) {
          v.currentTime = time;
          v.play().catch(() => {});
          setIsPlaying(true);
        }
      };
    }
    return () => { if (seekToRef) seekToRef.current = null; };
  }, [seekToRef]);

  useEffect(() => {
    if (videoElRef) videoElRef.current = videoRef.current;
    return () => { if (videoElRef) videoElRef.current = null; };
  });

  const onTimeUpdateRef = useRef(onTimeUpdate);
  onTimeUpdateRef.current = onTimeUpdate;
  const rafIdRef = useRef<number>(0);

  const handleLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    if (v && v.duration && isFinite(v.duration)) {
      setVideoDuration(v.duration);
    }
    if (v && v.videoWidth && v.videoHeight) {
      setRealResolution({ w: v.videoWidth, h: v.videoHeight });
    }
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    let lastRafTime = 0;
    let lastSetTime = 0;
    const RAF_INTERVAL = 50;
    const rafLoop = () => {
      const v2 = videoRef.current;
      if (v2 && !v2.paused) {
        const now = v2.currentTime;
        const elapsed = performance.now() - lastSetTime;
        if (now !== lastRafTime && elapsed >= RAF_INTERVAL) {
          lastRafTime = now;
          lastSetTime = performance.now();
          setCurrentTime(now);
          onTimeUpdateRef.current?.(now);
          if (loopingRef.current && inTime !== null && outTime !== null) {
            if (now >= outTime) {
              v2.currentTime = inTime;
            }
          }
        }
      }
      rafIdRef.current = requestAnimationFrame(rafLoop);
    };

    const handleTimeUpdate = () => {
      const v2 = videoRef.current;
      if (v2 && v2.paused) {
        setCurrentTime(v2.currentTime);
        onTimeUpdateRef.current?.(v2.currentTime);
      }
    };

    v.addEventListener("timeupdate", handleTimeUpdate);
    v.addEventListener("loadedmetadata", handleLoadedMetadata);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    rafIdRef.current = requestAnimationFrame(rafLoop);
    return () => {
      cancelAnimationFrame(rafIdRef.current);
      v.removeEventListener("timeupdate", handleTimeUpdate);
      v.removeEventListener("loadedmetadata", handleLoadedMetadata);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
  }, [handleLoadedMetadata, inTime, outTime]);

  const getTimeFromPointer = useCallback((clientX: number) => {
    const el = timelineRef.current;
    if (!el || !duration) return 0;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * duration;
  }, [duration]);

  const applyDrag = useCallback((clientX: number, type: "in" | "out" | "seek") => {
    const t = getTimeFromPointer(clientX);
    if (type === "seek") {
      if (videoRef.current) videoRef.current.currentTime = t;
    } else if (type === "in") {
      onInChange(Math.min(t, outTime ?? duration));
    } else {
      onOutChange(Math.max(t, inTime ?? 0));
    }
  }, [getTimeFromPointer, duration, inTime, outTime, onInChange, onOutChange]);

  const handlePointerDown = useCallback((e: React.PointerEvent, type: "in" | "out" | "seek") => {
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = type;
    applyDrag(e.clientX, type);
  }, [applyDrag]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      applyDrag(e.clientX, draggingRef.current);
    };
    const onUp = () => {
      draggingRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [applyDrag]);

  const setIn = useCallback(() => {
    if (videoRef.current) {
      const t = videoRef.current.currentTime;
      onInChange(outTime !== null ? Math.min(t, outTime) : t);
    }
  }, [outTime, onInChange]);

  const setOut = useCallback(() => {
    if (videoRef.current) {
      const t = videoRef.current.currentTime;
      onOutChange(inTime !== null ? Math.max(t, inTime) : t);
    }
  }, [inTime, onOutChange]);

  const playSelection = useCallback(() => {
    const v = videoRef.current;
    if (!v || inTime === null || outTime === null) return;
    setLooping(true);
    if (v.currentTime < inTime || v.currentTime >= outTime) {
      v.currentTime = inTime;
    }
    v.play().catch(() => {});
  }, [inTime, outTime]);

  const stopLoop = useCallback(() => {
    setLooping(false);
    videoRef.current?.pause();
  }, []);

  const clearMarkers = useCallback(() => {
    onInChange(null);
    onOutChange(null);
    setLooping(false);
  }, [onInChange, onOutChange]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const v = videoRef.current;
      if (!v) return;

      if (e.key === "i" || e.key === "I" || e.key === "ш" || e.key === "Ш") {
        e.preventDefault();
        setIn();
      } else if (e.key === "o" || e.key === "O" || e.key === "щ" || e.key === "Щ") {
        e.preventDefault();
        setOut();
      } else if (e.key === " ") {
        e.preventDefault();
        if (v.paused) v.play().catch(() => {}); else v.pause();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        v.currentTime = Math.max(0, v.currentTime - (e.shiftKey ? 0.1 : 1));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        v.currentTime = Math.min(duration, v.currentTime + (e.shiftKey ? 0.1 : 1));
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [duration, setIn, setOut]);

  const inPct = inTime !== null && duration ? (inTime / duration) * 100 : null;
  const outPct = outTime !== null && duration ? (outTime / duration) * 100 : null;
  const playPct = duration ? (currentTime / duration) * 100 : 0;

  const seekTo = useCallback((seconds: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(duration, seconds));
  }, [duration]);

  const skipBack = useCallback((amount: number) => {
    const v = videoRef.current;
    if (v) v.currentTime = Math.max(0, v.currentTime - amount);
  }, []);

  const skipForward = useCallback((amount: number) => {
    const v = videoRef.current;
    if (v) v.currentTime = Math.min(duration, v.currentTime + amount);
  }, [duration]);

  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen().catch(() => {});
    }
  }, []);

  const streamRes = realResolution
    ? `${realResolution.w}x${realResolution.h}`
    : null;
  const sourceRes = sourceWidth && sourceHeight ? `${sourceWidth}x${sourceHeight}` : null;
  const isSourceHD = sourceHeight && sourceHeight >= 1080;
  const isStreamPreview = realResolution && sourceHeight && realResolution.h < sourceHeight;

  return (
    <div className="space-y-1">
      <div ref={containerRef} className={`relative rounded-md overflow-hidden bg-black group/video ${isFullscreen ? "flex items-center justify-center h-screen w-screen" : ""}`}>
        <video
          ref={videoRef}
          src={videoSrc}
          className={isFullscreen ? "max-w-full max-h-full object-contain" : "w-full max-h-[30vh]"}
          onDoubleClick={toggleFullscreen}
          data-testid="video-main-player"
        />
        <div className="absolute top-1.5 right-1.5 flex items-center gap-1">
          {sourceRes && (
            <Badge
              variant="secondary"
              className={`text-[10px] px-1.5 py-0 ${isSourceHD ? "bg-green-600/80 text-white border-green-700" : "bg-yellow-500/80 text-white border-yellow-600"}`}
              data-testid="badge-source-resolution"
            >
              {sourceRes}
            </Badge>
          )}
          {streamRes && isStreamPreview && (
            <Badge
              variant="secondary"
              className="text-[10px] px-1.5 py-0 bg-orange-500/80 text-white border-orange-600"
              data-testid="badge-stream-resolution"
            >
              {streamRes} preview
            </Badge>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 bg-black/50 text-white hover:bg-black/70 no-default-hover-elevate"
            onClick={toggleFullscreen}
            data-testid="button-fullscreen"
          >
            <Maximize className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      <div className="space-y-0.5">
        <div className="flex items-center gap-2 px-1">
          <span className="text-xs font-mono text-foreground tabular-nums w-[52px] text-center" data-testid="text-current-time">
            {formatTimeFull(currentTime)}
          </span>

          <div
            ref={timelineRef}
            className="relative flex-1 h-10 cursor-pointer select-none touch-none group"
            onPointerDown={(e) => handlePointerDown(e, "seek")}
            data-testid="timeline-bar"
          >
            <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="absolute left-0 top-0 bottom-0 bg-foreground/20 rounded-full"
                style={{ width: `${playPct}%` }}
              />
            </div>

            {inPct !== null && outPct !== null && (
              <div
                className="absolute top-1/2 -translate-y-1/2 h-2 bg-primary/30 rounded-sm pointer-events-none"
                style={{ left: `${inPct}%`, width: `${outPct - inPct}%` }}
                data-testid="timeline-range"
              />
            )}

            <div
              className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-foreground border-2 border-background shadow-sm -ml-1.5 z-20 pointer-events-none transition-transform group-hover:scale-125"
              style={{ left: `${playPct}%` }}
              data-testid="timeline-playhead"
            />

            {inPct !== null && (
              <div
                className="absolute top-0 bottom-0 w-5 cursor-col-resize z-10 flex items-center justify-center -ml-2.5"
                style={{ left: `${inPct}%` }}
                onPointerDown={(e) => handlePointerDown(e, "in")}
                data-testid="marker-in"
              >
                <div className="w-1 h-6 rounded-sm bg-green-500 shadow-sm" />
              </div>
            )}

            {outPct !== null && (
              <div
                className="absolute top-0 bottom-0 w-5 cursor-col-resize z-10 flex items-center justify-center -ml-2.5"
                style={{ left: `${outPct}%` }}
                onPointerDown={(e) => handlePointerDown(e, "out")}
                data-testid="marker-out"
              >
                <div className="w-1 h-6 rounded-sm bg-red-500 shadow-sm" />
              </div>
            )}
          </div>

          <span className="text-xs font-mono text-muted-foreground tabular-nums w-[52px] text-center">
            {formatTimeFull(duration)}
          </span>
        </div>

        <div className="flex items-center gap-1 px-1 flex-wrap">
          <Button
            size="icon"
            variant="ghost"
            onClick={() => skipBack(5)}
            data-testid="button-skip-back-5"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </Button>
          <Button
            size="icon"
            variant={isPlaying ? "default" : "ghost"}
            onClick={() => {
              const v = videoRef.current;
              if (!v) return;
              if (v.paused) v.play().catch(() => {}); else v.pause();
            }}
            data-testid="button-play-pause"
          >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => skipForward(5)}
            data-testid="button-skip-forward-5"
          >
            <RotateCcw className="w-3.5 h-3.5" style={{ transform: "scaleX(-1)" }} />
          </Button>

          <div className="w-px h-5 bg-border mx-0.5" />

          <Button size="sm" variant="outline" onClick={setIn} data-testid="button-set-in">
            IN {inTime !== null ? formatTimeFull(inTime) : "—"}
          </Button>
          <Button size="sm" variant="outline" onClick={setOut} data-testid="button-set-out">
            OUT {outTime !== null ? formatTimeFull(outTime) : "—"}
          </Button>
          {inTime !== null && outTime !== null && (
            <>
              <Button
                size="sm"
                variant={looping ? "default" : "outline"}
                onClick={looping ? stopLoop : playSelection}
                data-testid="button-play-selection"
              >
                <Repeat className="w-3 h-3 mr-1" />
                {Math.round(outTime - inTime)}с
              </Button>
              <Button size="sm" variant="ghost" onClick={clearMarkers} data-testid="button-clear-markers">
                <X className="w-3 h-3" />
              </Button>
            </>
          )}

          <div className="ml-auto text-[10px] text-muted-foreground font-mono hidden sm:block">
            I/O — маркеры, Пробел — пауза, Стрелки ±1с (Shift ±0.1с)
          </div>
        </div>
      </div>

      {inTime !== null && outTime !== null && onCreateClip && (
        <div className="flex items-center gap-2 px-1 pt-1 border-t border-dashed">
          <Input
            placeholder="Название клипа (необязательно)"
            value={clipTitle ?? ""}
            onChange={(e) => onClipTitleChange?.(e.target.value)}
            className="flex-1 h-8 text-sm"
            data-testid="input-clip-title-inline"
          />
          <Button
            size="sm"
            disabled={isCreating}
            onClick={onCreateClip}
            data-testid="button-create-clip-inline"
          >
            {isCreating ? (
              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
            ) : (
              <Scissors className="w-3 h-3 mr-1" />
            )}
            Вырезать {formatTimeFull(inTime)} — {formatTimeFull(outTime)}
          </Button>
        </div>
      )}
    </div>
  );
}




function ClipEditorDialog({
  open,
  onOpenChange,
  videoSrc,
  fallbackVideoSrc,
  videoDuration,
  initialStart,
  initialEnd,
  title,
  onSave,
  onApproveAndSave,
  onPreviewExport,
  onFullExport,
  onAiCalibrate,
  onManualCalibrate,
  isApproved,
  hasCalibration,
  isExporting,
  transcriptSegments,
  onRewhisper,
  isRewhispering,
  videoId,
  onTranscriptSave,
  contentType,
  calibration,
  exportSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  videoSrc: string;
  fallbackVideoSrc?: string;
  videoDuration: number;
  initialStart: number;
  initialEnd: number;
  title?: string;
  onSave: (startTime: number, endTime: number) => void;
  onApproveAndSave?: (startTime: number, endTime: number) => void;
  onPreviewExport?: (startTime: number, endTime: number) => void;
  onFullExport?: (startTime: number, endTime: number) => void;
  onAiCalibrate?: (time: number) => void;
  onManualCalibrate?: (time: number) => void;
  isApproved?: boolean;
  hasCalibration?: boolean;
  isExporting?: boolean;
  transcriptSegments?: TranscriptSegment[];
  onRewhisper?: () => void;
  isRewhispering?: boolean;
  videoId?: string;
  onTranscriptSave?: (segments: TranscriptSegment[]) => void;
  contentType?: string;
  calibration?: { table?: { x: number; y: number; width: number; height: number }; webcam?: { x: number; y: number; width: number; height: number }; sourceWidth?: number; sourceHeight?: number; regionAspectRatio?: string };
  exportSettings?: {
    uniqualize: boolean;
    setUniqualize: (v: boolean) => void;
    filterPreset: "subtle" | "medium" | "strong";
    setFilterPreset: (v: "subtle" | "medium" | "strong") => void;
    videoFilter: string;
    setVideoFilter: (v: string) => void;
    muteAudio: boolean;
    setMuteAudio: (v: boolean) => void;
    bleepProfanity: boolean;
    setBleepProfanity: (v: boolean) => void;
    bgAudioFilename: string;
    setBgAudioFilename: (v: string) => void;
    bgAudioVolume: number;
    setBgAudioVolume: (v: number) => void;
    sounds: Array<{ id: string; filename: string }>;
    resolution: "1080p" | "4k";
    setResolution: (v: "1080p" | "4k") => void;
    useCrawlCaption: boolean;
    setUseCrawlCaption: (v: boolean) => void;
    playingSound: string | null;
    toggleSoundPreview: (filename: string, forcePlay?: boolean) => void;
    favoriteSounds: string[];
    musicDropEnabled: boolean;
    setMusicDropEnabled: (v: boolean) => void;
    musicDropTime: number | null;
    setMusicDropTime: (v: number | null) => void;
    musicDropVolumeBefore: number;
    setMusicDropVolumeBefore: (v: number) => void;
    musicStartOffset: number;
    setMusicStartOffset: (v: number) => void;
    voiceVolume: number;
    setVoiceVolume: (v: number) => void;
    captionPositionY: number;
    setCaptionPositionY: (v: number) => void;
    subtitleOffsetMs: number;
    setSubtitleOffsetMs: (v: number) => void;
    captionStyle: "classic" | "mrbeast" | "glow";
    setCaptionStyle: (v: "classic" | "mrbeast" | "glow") => void;
  };
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<"in" | "out" | "seek" | null>(null);
  const loopingRef = useRef(false);
  const playheadLineRef = useRef<HTMLDivElement>(null);
  const playheadDotRef = useRef<HTMLDivElement>(null);
  const timeDisplayRef = useRef<HTMLSpanElement>(null);
  const rafIdRef = useRef<number>(0);
  const clipTranscriptRef = useRef<HTMLDivElement>(null);
  const prevWordElRef = useRef<{ el: HTMLElement; start: number; end: number } | null>(null);
  const { toast } = useToast();

  const highlightWord = useCallback((t: number) => {
    const container = clipTranscriptRef.current;
    if (!container) return;

    const prev = prevWordElRef.current;

    if (prev) {
      const nextSibling = prev.el.nextElementSibling as HTMLElement | null;
      const nextWs = nextSibling?.dataset?.ws ? Number(nextSibling.dataset.ws) : prev.end;
      if (t >= prev.start && t < nextWs) return;
    }

    const spans = container.querySelectorAll<HTMLElement>('[data-ws]');
    if (spans.length === 0) return;

    let found: HTMLElement | null = null;
    let foundStart = 0;
    let foundNextStart = Infinity;

    for (let i = 0; i < spans.length; i++) {
      const ws = Number(spans[i].dataset.ws);
      const nextWs = i < spans.length - 1 ? Number(spans[i + 1].dataset.ws) : Infinity;
      if (t >= ws && t < nextWs) {
        found = spans[i];
        foundStart = ws;
        foundNextStart = nextWs;
        break;
      }
    }

    if (!found && spans.length > 0) {
      const lastWs = Number(spans[spans.length - 1].dataset.ws);
      if (t >= lastWs) {
        found = spans[spans.length - 1];
        foundStart = lastWs;
        foundNextStart = Infinity;
      }
    }

    if (found && found !== prev?.el) {
      if (prev) prev.el.classList.remove('word-hl');
      found.classList.add('word-hl');
      prevWordElRef.current = { el: found, start: foundStart, end: foundNextStart };
    } else if (!found && prev) {
      prev.el.classList.remove('word-hl');
      prevWordElRef.current = null;
    }
  }, []);

  const { data: clipStreamInfo } = useQuery<{ type: string; url: string; token?: string; clipOffset?: number }>({
    queryKey: ["/api/videos", videoId, "clip-stream", initialStart, initialEnd],
    queryFn: async () => {
      const res = await fetch(`/api/videos/${videoId}/stream-url?start=${initialStart}&end=${initialEnd}`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: open && !!videoId,
    staleTime: 1000 * 60 * 30,
  });

  const clipSegmentSrc = useMemo(() => {
    if (clipStreamInfo?.type === "vps" && clipStreamInfo.url && clipStreamInfo.token) {
      return `${clipStreamInfo.url}&token=${encodeURIComponent(clipStreamInfo.token)}`;
    }
    return null;
  }, [clipStreamInfo]);

  const clipOffset = clipStreamInfo?.clipOffset || 0;
  const clipOffsetRef = useRef(0);
  clipOffsetRef.current = clipOffset;
  const effectiveVideoSrc = clipSegmentSrc || (clipStreamInfo ? videoSrc : null);

  const seekVideo = useCallback((absTime: number) => {
    const v = videoRef.current;
    if (v) v.currentTime = absTime - clipOffsetRef.current;
  }, []);

  const getVideoAbsTime = useCallback(() => {
    const v = videoRef.current;
    return v ? v.currentTime + clipOffsetRef.current : 0;
  }, []);

  const [clipStart, setClipStart] = useState(initialStart);
  const [clipEnd, setClipEnd] = useState(initialEnd);
  const [currentTime, setCurrentTime] = useState(initialStart);
  const [isPlaying, setIsPlaying] = useState(false);
  const [looping, setLooping] = useState(true);
  const [volume, setVolume] = useState(50);
  const [editStartStr, setEditStartStr] = useState("");
  const [editEndStr, setEditEndStr] = useState("");
  const [editingField, setEditingField] = useState<"start" | "end" | null>(null);
  const [localDuration, setLocalDuration] = useState(videoDuration);
  const [isAligning, setIsAligning] = useState(false);
  const [isCorrecting, setIsCorrecting] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const show916 = !!(calibration?.table || calibration?.webcam);
  const preview916Ref = useRef<HTMLVideoElement>(null);
  const [preview916Url, setPreview916Url] = useState<string | null>(null);
  const [preview916Loading, setPreview916Loading] = useState(false);
  const [preview916Error, setPreview916Error] = useState<string | null>(null);
  const [preview916Playing, setPreview916Playing] = useState(false);
  const [preview916Muted, setPreview916Muted] = useState(true);
  const [preview916Time, setPreview916Time] = useState(0);

  const maxDuration = localDuration || videoDuration || initialEnd + 60;
  const clipDuration = clipEnd - clipStart;
  const windowStart = Math.max(0, initialStart - 120);
  const windowEnd = Math.min(maxDuration, initialEnd + 120);
  const windowDuration = windowEnd - windowStart;

  useEffect(() => { loopingRef.current = looping; }, [looping]);

  const generate916Preview = () => {
    if (!show916 || !videoId || (!calibration?.table && !calibration?.webcam)) return;
    setPreview916Loading(true);
    setPreview916Error(null);
    setPreview916Url(null);
    const previewBody: any = { startTime: clipStart, endTime: clipEnd, calibration, contentType };
    if (exportSettings?.videoFilter && exportSettings.videoFilter !== "none") {
      previewBody.videoFilter = exportSettings.videoFilter;
    } else if (exportSettings?.uniqualize) {
      previewBody.uniqualize = true;
      previewBody.filterPreset = exportSettings.filterPreset || "medium";
    }
    if (exportSettings?.bgAudioFilename) {
      previewBody.bgAudioFilename = exportSettings.bgAudioFilename;
      previewBody.bgAudioVolume = exportSettings.bgAudioVolume ?? 0.2;
      if (exportSettings.musicStartOffset > 0) {
        previewBody.musicStartOffset = exportSettings.musicStartOffset;
      }
      previewBody.voiceVolume = exportSettings.voiceVolume ?? 1.4;
    }
    if (exportSettings?.muteAudio) {
      previewBody.muteOriginalAudio = true;
    }
    if (exportSettings?.bleepProfanity) {
      previewBody.bleepProfanity = true;
    }
    if (exportSettings?.musicDropEnabled && exportSettings?.musicDropTime != null) {
      previewBody.musicDropTime = exportSettings.musicDropTime;
      previewBody.musicDropVolumeBefore = exportSettings.musicDropVolumeBefore ?? 0.15;
    }
    if (exportSettings?.captionPositionY != null) {
      previewBody.captionPositionY = exportSettings.captionPositionY;
    }
    if (exportSettings?.subtitleOffsetMs) {
      previewBody.subtitleOffsetMs = exportSettings.subtitleOffsetMs;
    }
    if (exportSettings?.captionStyle && exportSettings.captionStyle !== "classic") {
      previewBody.captionStyle = exportSettings.captionStyle;
    }
    fetch(`/api/videos/${videoId}/preview-clip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(previewBody),
    })
      .then(r => r.json())
      .then(data => {
        if (data.url) setPreview916Url(data.url);
        else setPreview916Error(data.message || "Failed");
      })
      .catch(err => setPreview916Error(err.message))
      .finally(() => setPreview916Loading(false));
  };

  useEffect(() => {
    if (!show916 || !preview916Url) return;
    const prev = preview916Ref.current;
    if (!prev) return;
    prev.currentTime = 0;
    setPreview916Playing(false);
  }, [show916, preview916Url]);

  const clipStartRef = useRef(clipStart);
  const clipEndRef = useRef(clipEnd);
  useEffect(() => { clipStartRef.current = clipStart; }, [clipStart]);
  useEffect(() => { clipEndRef.current = clipEnd; }, [clipEnd]);

  const windowStartRef = useRef(windowStart);
  const windowDurationRef = useRef(windowDuration);
  windowStartRef.current = windowStart;
  windowDurationRef.current = windowDuration;

  const movePlayhead = useCallback((t: number) => {
    const ws = windowStartRef.current;
    const wd = windowDurationRef.current;
    const pct = wd > 0 ? Math.max(0, Math.min(100, ((t - ws) / wd) * 100)) : 0;
    const pctStr = `${pct}%`;
    if (playheadLineRef.current) playheadLineRef.current.style.left = pctStr;
    if (playheadDotRef.current) playheadDotRef.current.style.left = pctStr;
    if (timeDisplayRef.current) timeDisplayRef.current.textContent = formatTimeFull(t);
  }, []);

  const videoCallbackRef = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    if (!node || !open) return;

    cancelAnimationFrame(rafIdRef.current);

    const v = node;
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onError = () => {
      const fallback = fallbackVideoSrc || videoSrc;
      if (fallback && v.src !== fallback && !v.src.endsWith(fallback)) {
        console.log("[clip-editor] Clip segment failed, falling back to full video");
        clipOffsetRef.current = 0;
        v.src = `${fallback}#t=${initialStart}`;
        v.load();
      }
    };
    const onLoadedData = () => {
      setVideoReady(true);
      v.removeEventListener("loadeddata", onLoadedData);
    };
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("error", onError);
    v.addEventListener("loadeddata", onLoadedData);
    setVideoReady(v.readyState >= 2);

    let lastStateUpdate = 0;
    const tick = () => {
      const absT = v.currentTime + clipOffsetRef.current;
      movePlayhead(absT);
      highlightWord(absT);
      if (loopingRef.current && !v.paused && absT >= clipEndRef.current) {
        v.currentTime = clipStartRef.current - clipOffsetRef.current;
      }
      const now = performance.now();
      if (now - lastStateUpdate > 250) {
        lastStateUpdate = now;
        setCurrentTime(absT);
      }
      rafIdRef.current = requestAnimationFrame(tick);
    };
    rafIdRef.current = requestAnimationFrame(tick);

    v.preload = "auto";
    v.volume = 0.5;

    const seekToStart = () => {
      if (v.duration && isFinite(v.duration)) setLocalDuration(v.duration + clipOffsetRef.current);
      v.currentTime = initialStart - clipOffsetRef.current;
      movePlayhead(initialStart);
      setCurrentTime(initialStart);
    };

    const onMeta = () => {
      v.removeEventListener("loadedmetadata", onMeta);
      seekToStart();
    };
    
    if (v.readyState >= 1) {
      seekToStart();
    } else {
      v.addEventListener("loadedmetadata", onMeta);
    }
  }, [open, initialStart, movePlayhead, fallbackVideoSrc]);

  useEffect(() => {
    if (!open) {
      cancelAnimationFrame(rafIdRef.current);
      if (videoRef.current) videoRef.current.pause();
      return;
    }
    setClipStart(initialStart);
    setClipEnd(initialEnd);
    setLooping(true);
    setIsPlaying(false);
    setVideoReady(false);
    clipStartRef.current = initialStart;
    clipEndRef.current = initialEnd;
  }, [open, initialStart, initialEnd]);

  const getTimeFromPointer = useCallback((clientX: number) => {
    const el = timelineRef.current;
    if (!el || !windowDuration) return windowStart;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return windowStart + ratio * windowDuration;
  }, [windowStart, windowDuration]);

  const applyDrag = useCallback((clientX: number, type: "in" | "out" | "seek") => {
    const t = getTimeFromPointer(clientX);
    if (type === "seek") {
      seekVideo(t);
      setCurrentTime(t);
      movePlayhead(t);
    } else if (type === "in") {
      setClipStart(Math.max(0, Math.min(t, clipEnd - 1)));
    } else {
      setClipEnd(Math.min(maxDuration, Math.max(t, clipStart + 1)));
    }
  }, [getTimeFromPointer, clipStart, clipEnd, maxDuration, movePlayhead]);

  const handlePointerDown = useCallback((e: React.PointerEvent, type: "in" | "out" | "seek") => {
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = type;
    applyDrag(e.clientX, type);
  }, [applyDrag]);

  useEffect(() => {
    if (!open) return;
    const onMove = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      applyDrag(e.clientX, draggingRef.current);
    };
    const onUp = () => { draggingRef.current = null; };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [applyDrag, open]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const v = videoRef.current;
      if (!v) return;
      if (e.key === " ") {
        e.preventDefault();
        if (v.paused) v.play().catch(() => {}); else v.pause();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        const absT = getVideoAbsTime();
        seekVideo(Math.max(0, absT - (e.shiftKey ? 0.1 : 1)));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const absT = getVideoAbsTime();
        seekVideo(Math.min(maxDuration, absT + (e.shiftKey ? 0.1 : 1)));
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, maxDuration]);

  const toPct = (t: number) => windowDuration ? ((t - windowStart) / windowDuration) * 100 : 0;

  const inPct = toPct(clipStart);
  const outPct = toPct(clipEnd);
  const playPct = toPct(currentTime);

  const adjustTime = (which: "start" | "end", delta: number) => {
    if (which === "start") {
      const newVal = Math.max(0, clipStart + delta);
      if (newVal < clipEnd - 1) {
        setClipStart(newVal);
        if (looping) seekVideo(newVal);
      }
    } else {
      const newVal = Math.min(maxDuration, clipEnd + delta);
      if (newVal > clipStart + 1) setClipEnd(newVal);
    }
  };

  const commitFieldEdit = (which: "start" | "end") => {
    const val = which === "start" ? editStartStr : editEndStr;
    const parsed = parseTimeInput(val);
    if (parsed === null) {
      toast({ title: "Неверный формат", description: "Используйте M:SS или H:MM:SS", variant: "destructive" });
      return;
    }
    if (which === "start") {
      if (parsed >= clipEnd - 1) {
        toast({ title: "Начало должно быть раньше конца", variant: "destructive" });
        return;
      }
      setClipStart(Math.max(0, parsed));
      if (looping) seekVideo(Math.max(0, parsed));
    } else {
      if (parsed <= clipStart + 1) {
        toast({ title: "Конец должен быть позже начала", variant: "destructive" });
        return;
      }
      setClipEnd(Math.min(maxDuration, parsed));
    }
    setEditingField(null);
  };

  const hasChanges = clipStart !== initialStart || clipEnd !== initialEnd;

  const clipTranscript = useMemo(() => {
    if (!transcriptSegments || transcriptSegments.length === 0) return [];
    const pad = 30;
    return transcriptSegments.filter(
      (s) => s.end > clipStart - pad && s.start < clipEnd + pad
    );
  }, [transcriptSegments, clipStart, clipEnd]);

  const transcriptPanelRef = useRef<HTMLDivElement>(null);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const editRef = useRef<HTMLInputElement>(null);
  const [syncMode, setSyncMode] = useState(false);

  const splitToSentences = (text: string): string[] => {
    const parts = text.split(/(?<=[.!?А-Яа-яёЁ])\s+(?=[А-ЯA-ZЁ])/).filter(s => s.trim());
    if (parts.length <= 1) {
      const byComma = text.split(/,\s+/).filter(s => s.trim());
      if (byComma.length > 3) return byComma.map((s, i) => i < byComma.length - 1 ? s + "," : s);
    }
    return parts.length > 0 ? parts : [text];
  };

  const handleSentenceEdit = (segGlobalIdx: number, sentenceIdx: number, text: string) => {
    setEditKey(`${segGlobalIdx}:${sentenceIdx}`);
    setEditText(text);
    setTimeout(() => editRef.current?.focus(), 50);
  };

  const handleWordSync = (segGlobalIdx: number, wordIdx: number) => {
    if (!transcriptSegments || !onTranscriptSave) return;
    const v = videoRef.current;
    if (!v) return;
    const t = v.currentTime;
    const updated = [...transcriptSegments];
    const seg = updated[segGlobalIdx];
    if (!seg || !seg.words || !seg.words[wordIdx]) return;

    const oldStart = seg.words[wordIdx].start;
    const shift = t - oldStart;

    const newWords = [...seg.words];
    newWords[wordIdx] = { ...newWords[wordIdx], start: t, end: t + (newWords[wordIdx].end - newWords[wordIdx].start) };

    for (let wi = wordIdx + 1; wi < newWords.length; wi++) {
      const dur = newWords[wi].end - newWords[wi].start;
      const newStart = newWords[wi].start + shift;
      newWords[wi] = { ...newWords[wi], start: newStart, end: newStart + dur };
    }

    updated[segGlobalIdx] = { ...seg, words: newWords };
    onTranscriptSave(updated);
    toast({ title: `Слово привязано к ${t.toFixed(1)}с` });
  };

  const handleSentenceSave = () => {
    if (!editKey || !transcriptSegments || !onTranscriptSave) return;
    const [segStr, sentStr] = editKey.split(":");
    const segIdx = parseInt(segStr);
    const sentIdx = parseInt(sentStr);
    const updated = [...transcriptSegments];
    if (updated[segIdx]) {
      const seg = updated[segIdx];
      const sentences = splitToSentences(seg.text);
      sentences[sentIdx] = editText.trim();
      const newText = sentences.join(" ");
      const newWords = newText.split(/\s+/).filter((w: string) => w.length > 0);
      let newWordsArr: any[] | undefined;
      if (seg.words && seg.words.length > 0) {
        const oldWords = seg.words.filter((w: any) => w.start != null && w.end != null);
        if (oldWords.length > 0) {
          const segStart = oldWords[0].start;
          const segEnd = oldWords[oldWords.length - 1].end;
          const totalDur = segEnd - segStart;
          const wordDur = totalDur / newWords.length;
          newWordsArr = newWords.map((w: string, wi: number) => {
            if (wi < oldWords.length) {
              return { word: w, start: oldWords[wi].start, end: oldWords[wi].end };
            }
            const wStart = segStart + wi * wordDur;
            return { word: w, start: wStart, end: wStart + wordDur };
          });
          const last = newWordsArr[newWordsArr.length - 1];
          last.end = segEnd;
        }
      }
      updated[segIdx] = {
        ...seg,
        text: newText,
        ...(newWordsArr ? { words: newWordsArr } : {}),
      };
    }
    onTranscriptSave(updated);
    setEditKey(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[97vw] w-[97vw] p-4" style={{ maxHeight: "92vh", display: "flex", flexDirection: "column", overflow: "hidden" }} onPointerDownOutside={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader className="pb-1 flex-shrink-0">
          <DialogTitle className="text-sm">{title || `Редактор клипа`}</DialogTitle>
        </DialogHeader>

        <div className="flex gap-3 flex-1 min-h-0">
        {clipTranscript.length > 0 && (
          <div
            ref={transcriptPanelRef}
            className={`${show916 ? "w-[22vw] min-w-[280px]" : "w-96 min-w-[320px]"} overflow-y-auto border rounded-md p-2 space-y-1 flex-shrink-0 bg-muted/30 scrollbar-thin`}
            style={{ scrollbarWidth: "thin", scrollbarColor: "hsl(var(--muted-foreground) / 0.3) transparent" }}
            data-testid="clip-transcript-panel"
          >
            <div className="flex items-center justify-between mb-1 sticky top-0 bg-muted/80 backdrop-blur-sm py-1 z-10">
              <span className="text-[10px] font-medium text-muted-foreground">Транскрипция <span className="opacity-50">{syncMode ? "(клик на слово = привязать)" : "(клик = ред.)"}</span></span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setSyncMode(!syncMode)}
                  className={`text-[10px] flex items-center gap-1 px-1.5 py-0.5 rounded ${syncMode ? "bg-yellow-500/20 text-yellow-400 ring-1 ring-yellow-500/50" : "text-muted-foreground hover:text-foreground"}`}
                  data-testid="button-sync-mode"
                >
                  <Clock className="w-3 h-3" />
                  {syncMode ? "Синхр. ВКЛ" : "Синхр."}
                </button>
              {videoId && (
                <button
                  onClick={async () => {
                    setIsAligning(true);
                    try {
                      const padStart = Math.max(0, clipStart - 15);
                      const padEnd = clipEnd + 15;
                      const res = await fetch(`/api/videos/${videoId}/align-clip`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ startTime: padStart, endTime: padEnd }),
                      });
                      const data = await res.json();
                      if (!res.ok) throw new Error(data.message);
                      toast({ title: `WhisperX: ${data.enrichedSegments} сегм., ${data.totalWords} слов` });
                      queryClient.invalidateQueries({ queryKey: ["/api/videos", videoId] });
                    } catch (err: any) {
                      toast({ title: "Ошибка WhisperX", description: err.message, variant: "destructive" });
                    } finally {
                      setIsAligning(false);
                    }
                  }}
                  disabled={isAligning}
                  className="text-[10px] text-blue-400 hover:text-blue-300 flex items-center gap-1 disabled:opacity-50"
                  data-testid="button-align-clip"
                >
                  <AudioLines className={`w-3 h-3 ${isAligning ? "animate-spin" : ""}`} />
                  {isAligning ? "WhisperX..." : "WhisperX"}
                </button>
              )}
              {videoId && (
                <button
                  onClick={async () => {
                    setIsCorrecting(true);
                    try {
                      const res = await fetch(`/api/videos/${videoId}/correct-clip`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ startTime: clipStart, endTime: clipEnd }),
                      });
                      const data = await res.json();
                      if (!res.ok) throw new Error(data.message);
                      toast({ title: `AI коррекция: ${data.correctedCount} сегм. исправлено` });
                      queryClient.invalidateQueries({ queryKey: ["/api/videos", videoId] });
                    } catch (err: any) {
                      toast({ title: "Ошибка AI коррекции", description: err.message, variant: "destructive" });
                    } finally {
                      setIsCorrecting(false);
                    }
                  }}
                  disabled={isCorrecting}
                  className="text-[10px] text-emerald-400 hover:text-emerald-300 flex items-center gap-1 disabled:opacity-50"
                  data-testid="button-correct-clip"
                >
                  <Sparkles className={`w-3 h-3 ${isCorrecting ? "animate-pulse" : ""}`} />
                  {isCorrecting ? "GPT..." : "AI коррекция"}
                </button>
              )}
              {onRewhisper && (
                <button
                  onClick={onRewhisper}
                  disabled={isRewhispering}
                  className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1 disabled:opacity-50"
                  data-testid="button-rewhisper-clip"
                >
                  <RefreshCw className={`w-3 h-3 ${isRewhispering ? "animate-spin" : ""}`} />
                  {isRewhispering ? "Whisper..." : "Re-Whisper"}
                </button>
              )}
              </div>
            </div>
            <div ref={clipTranscriptRef}>
            {clipTranscript.map((seg, i) => {
              const isInRange = seg.end > clipStart && seg.start < clipEnd;
              const nextSeg = clipTranscript[i + 1];
              const isActiveSeg = currentTime >= seg.start && (nextSeg ? currentTime < nextSeg.start : currentTime <= seg.end + 2);
              const globalIdx = transcriptSegments ? transcriptSegments.indexOf(seg) : -1;
              const sentences = splitToSentences(seg.text);
              const fmtSec = (s: number) => {
                const m = Math.floor(s / 60);
                const sec = Math.floor(s % 60);
                return `${m}:${String(sec).padStart(2, "0")}`;
              };
              return (
                <div
                  key={i}
                  className={`text-sm leading-relaxed rounded px-2 py-1 transition-colors ${isActiveSeg ? "text-foreground" : isInRange ? "text-foreground" : "text-muted-foreground"}`}
                  data-testid={`clip-transcript-seg-${i}`}
                >
                  <span
                    className={`font-mono text-xs cursor-pointer ${isActiveSeg ? "text-primary font-bold" : "text-muted-foreground"}`}
                    onClick={() => seekVideo(seg.start)}
                  >{fmtSec(seg.start)}</span>
                  {sentences.map((sentence, si) => {
                    const sentKey = `${globalIdx}:${si}`;
                    const isEditingSent = editKey === sentKey;
                    return (
                      <div key={si} className="group relative pl-1 mt-0.5" data-testid={`transcript-sentence-${i}-${si}`}>
                        {isEditingSent ? (
                          <div className="flex gap-1 items-start" onClick={(e) => e.stopPropagation()}>
                            <input
                              ref={editRef}
                              value={editText}
                              onChange={(e) => setEditText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") { e.preventDefault(); handleSentenceSave(); }
                                if (e.key === "Escape") setEditKey(null);
                              }}
                              className="flex-1 bg-background border rounded px-1.5 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                              data-testid="input-edit-sentence"
                            />
                            <button onClick={handleSentenceSave} className="text-[10px] bg-primary text-primary-foreground px-1.5 py-1 rounded shrink-0" data-testid="button-save-sentence">✓</button>
                            <button onClick={() => setEditKey(null)} className="text-[10px] text-muted-foreground px-1 py-1 shrink-0" data-testid="button-cancel-sentence">✕</button>
                          </div>
                        ) : (
                          <span
                            className="cursor-pointer rounded px-0.5 inline"
                          >
                            {(() => {
                              const textWords = seg.text.split(/(\s+)/).filter((w: string) => w.trim());
                              const segDur = seg.end - seg.start;
                              const wDur = textWords.length > 0 ? segDur / textWords.length : segDur;
                              const allWords: Array<{word: string; start: number; end: number}> = (() => {
                                const sw = seg.words as any[] | undefined;
                                const n = textWords.length;
                                if (sw && sw.length === n) {
                                  return textWords.map((tw: string, ti: number) => ({
                                    word: tw + " ",
                                    start: sw[ti].start ?? seg.start + ti * wDur,
                                    end: sw[ti].end ?? seg.start + (ti + 1) * wDur,
                                  }));
                                }
                                return textWords.map((w: string, wi: number) => ({
                                  word: w + " ",
                                  start: seg.start + wi * wDur,
                                  end: seg.start + (wi + 1) * wDur,
                                }));
                              })();
                              let offset = 0;
                              for (let pi = 0; pi < si; pi++) {
                                offset += sentences[pi].split(/(\s+)/).filter((w: string) => w.trim()).length;
                              }
                              const sentWords = sentence.split(/(\s+)/).filter((w: string) => w.trim());
                              return sentWords.map((_: string, swi: number) => {
                                const absWordIdx = offset + swi;
                                const w = allWords[absWordIdx] || { word: sentWords[swi] + " ", start: seg.start, end: seg.end };
                                const wStart = w.start ?? seg.start;
                                const wEnd = w.end ?? seg.end;
                                const hasTimestamps = w.start != null && w.end != null;
                                const isWordInRange = wEnd > clipStart && wStart < clipEnd;
                                const isBeforeIn = wEnd <= clipStart;
                                const isAfterOut = wStart >= clipEnd;
                                const isAtInBoundary = isWordInRange && wStart <= clipStart + 0.05;
                                const isAtOutBoundary = isWordInRange && wEnd >= clipEnd - 0.05;
                                let borderClass = "";
                                if (isAtInBoundary) borderClass = "border-l-2 border-green-500 pl-0.5";
                                else if (isAtOutBoundary) borderClass = "border-r-2 border-red-500 pr-0.5";
                                return (
                                  <span
                                    key={swi}
                                    {...(hasTimestamps ? { "data-ws": wStart, "data-we": wEnd } : {})}
                                    className={`${isWordInRange ? "bg-blue-500/30 rounded-[2px]" : ""} ${borderClass} ${syncMode ? "cursor-crosshair hover:underline hover:decoration-yellow-400" : isBeforeIn || isAfterOut ? "cursor-pointer hover:bg-green-500/20" : "cursor-pointer hover:bg-primary/10"}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (syncMode && globalIdx !== -1) {
                                        handleWordSync(globalIdx, absWordIdx);
                                      } else if (e.altKey || e.metaKey) {
                                        setClipStart(Math.max(0, wStart));
                                        seekVideo(wStart);
                                      } else if (e.shiftKey) {
                                        setClipEnd(Math.min(maxDuration, wEnd));
                                      } else if (isBeforeIn) {
                                        setClipStart(Math.max(0, wStart));
                                        seekVideo(wStart);
                                      } else if (isAfterOut) {
                                        setClipEnd(Math.min(maxDuration, wEnd));
                                      } else if (e.detail === 2) {
                                        if (globalIdx !== -1) handleSentenceEdit(globalIdx, si, sentence);
                                      } else {
                                        const midPoint = (clipStart + clipEnd) / 2;
                                        if (wStart < midPoint) {
                                          setClipStart(Math.max(0, wStart));
                                          seekVideo(wStart);
                                        } else {
                                          setClipEnd(Math.min(maxDuration, wEnd));
                                        }
                                      }
                                    }}
                                    title={syncMode ? `Привязать к ${currentTime.toFixed(1)}с (сейчас: ${wStart.toFixed(1)}с)` : isBeforeIn ? `← Сдвинуть IN сюда (${wStart.toFixed(1)}с)` : isAfterOut ? `Сдвинуть OUT сюда → (${wEnd.toFixed(1)}с)` : `${w.word.trim()} (${wStart.toFixed(1)}с) — клик = ${wStart < (clipStart + clipEnd) / 2 ? "IN" : "OUT"}, dblclick = ред.`}
                                  >{w.word}</span>
                                );
                              });
                            })()}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
            </div>
          </div>
        )}

        <div className={`min-w-0 overflow-y-auto space-y-1 ${show916 ? "flex-1" : "flex-1"}`} style={{ scrollbarWidth: "thin", maxWidth: show916 ? "42vw" : undefined }}>
        <div className="rounded-md overflow-hidden bg-black flex items-center justify-center relative">
          {!videoReady && (
            <div className="absolute inset-0 flex flex-col items-center justify-center z-10 bg-black/80">
              <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mb-2" />
              <span className="text-xs text-muted-foreground">Загрузка видео...</span>
            </div>
          )}
          <video
            ref={videoCallbackRef}
            src={effectiveVideoSrc ? `${effectiveVideoSrc}${effectiveVideoSrc.includes('#') ? '' : `#t=${initialStart - clipOffset}`}` : undefined}
            preload="auto"
            className={`w-full ${show916 ? "max-h-[32vh]" : "max-h-[55vh]"}`}
            data-testid="video-clip-editor-player"
          />
        </div>

        <div className="flex items-center gap-2 px-1">
          <Button
            size="icon"
            variant="ghost"
            onClick={() => {
              const newVol = volume > 0 ? 0 : 50;
              setVolume(newVol);
              if (videoRef.current) videoRef.current.volume = newVol / 100;
            }}
            data-testid="button-editor-mute"
          >
            {volume === 0 ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </Button>
          <Slider
            value={[volume]}
            min={0}
            max={100}
            step={1}
            onValueChange={([v]) => {
              setVolume(v);
              if (videoRef.current) videoRef.current.volume = v / 100;
            }}
            className="flex-1 max-w-[120px]"
            data-testid="slider-editor-volume"
          />
          <span className="text-xs text-muted-foreground font-mono w-8">{volume}%</span>
        </div>

        <div className="space-y-2">
          <div className="space-y-1 px-1">
            <div className="flex items-center justify-between">
              <span ref={timeDisplayRef} className="text-sm font-mono text-foreground tabular-nums font-medium" data-testid="text-editor-current-time">
                {formatTimeFull(currentTime)}
              </span>
              <span className="text-xs font-mono text-muted-foreground tabular-nums">
                {formatTimeFull(clipDuration)}с
              </span>
            </div>

            <div
              ref={timelineRef}
              className="relative flex-1 h-14 cursor-pointer select-none touch-none"
              onPointerDown={(e) => handlePointerDown(e, "seek")}
              data-testid="timeline-clip-editor"
            >
              <div className="absolute left-0 right-0 top-[18px] h-3 bg-muted rounded-full" />

              <div
                className="absolute top-[18px] h-3 bg-primary/30 rounded-sm"
                style={{ left: `${inPct}%`, width: `${Math.max(0, outPct - inPct)}%` }}
                data-testid="timeline-clip-range"
              />

              <div
                ref={playheadLineRef}
                className="absolute top-[12px] w-0.5 h-[24px] bg-foreground z-20 pointer-events-none"
                style={{ left: `${windowDuration > 0 ? ((initialStart - windowStart) / windowDuration) * 100 : 0}%` }}
                data-testid="timeline-editor-playhead"
              />
              <div
                ref={playheadDotRef}
                className="absolute top-[6px] w-2.5 h-2.5 rounded-full bg-foreground border-2 border-background z-20 pointer-events-none -ml-[4px]"
                style={{ left: `${windowDuration > 0 ? ((initialStart - windowStart) / windowDuration) * 100 : 0}%` }}
              />

              <div
                className="absolute top-0 bottom-0 w-8 cursor-col-resize z-10 flex items-center justify-center -ml-4"
                style={{ left: `${inPct}%` }}
                onPointerDown={(e) => handlePointerDown(e, "in")}
                data-testid="marker-clip-in"
              >
                <div className="w-1.5 h-9 rounded-sm bg-green-500 shadow-md" />
              </div>

              <div
                className="absolute top-0 bottom-0 w-8 cursor-col-resize z-10 flex items-center justify-center -ml-4"
                style={{ left: `${outPct}%` }}
                onPointerDown={(e) => handlePointerDown(e, "out")}
                data-testid="marker-clip-out"
              >
                <div className="w-1.5 h-9 rounded-sm bg-red-500 shadow-md" />
              </div>

              <div className="absolute left-0 bottom-0 text-[10px] text-muted-foreground font-mono">
                {formatTimeFull(windowStart)}
              </div>
              <div className="absolute right-0 bottom-0 text-[10px] text-muted-foreground font-mono">
                {formatTimeFull(windowEnd)}
              </div>
            </div>

            <div className="flex items-center justify-center gap-1 text-[10px] font-mono text-muted-foreground">
              <span>I/O — маркеры, Пробел — пауза, Стрелки ±1с (Shift ±0.1с)</span>
            </div>
          </div>

          <div className="flex items-center gap-1 px-1 flex-wrap">
            <Button
              size="icon"
              variant="ghost"
              onClick={() => seekVideo(Math.max(0, getVideoAbsTime() - 5))}
              data-testid="button-editor-back5"
            >
              <Rewind className="w-3.5 h-3.5" />
            </Button>
            <Button
              size="icon"
              variant={isPlaying ? "default" : "ghost"}
              onClick={() => {
                const v = videoRef.current;
                if (!v) return;
                if (v.paused) {
                  const absT = getVideoAbsTime();
                  const needSeek = absT < clipStart || absT > clipEnd;
                  const doPlay = () => v.play().catch(() => {});
                  if (needSeek) {
                    const onSeeked = () => { v.removeEventListener("seeked", onSeeked); doPlay(); };
                    v.addEventListener("seeked", onSeeked);
                    seekVideo(clipStart);
                  } else {
                    doPlay();
                  }
                } else {
                  v.pause();
                }
              }}
              data-testid="button-editor-play"
            >
              {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => seekVideo(Math.min(maxDuration, getVideoAbsTime() + 5))}
              data-testid="button-editor-fwd5"
            >
              <FastForward className="w-3.5 h-3.5" />
            </Button>

            <Button
              size="sm"
              variant={looping ? "default" : "outline"}
              onClick={() => setLooping(!looping)}
              data-testid="button-editor-loop"
            >
              <Repeat className="w-3 h-3 mr-1" />Цикл
            </Button>

            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const v = videoRef.current;
                if (v) {
                    const onSeeked = () => { v.removeEventListener("seeked", onSeeked); v.play().catch(() => {}); };
                    v.addEventListener("seeked", onSeeked);
                    seekVideo(clipStart);
                  }
                setLooping(true);
              }}
              data-testid="button-editor-play-clip"
            >
              <Play className="w-3 h-3 mr-1" />С начала
            </Button>
          </div>

          <div className="border-t pt-2 space-y-2">
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>
                {editingField === "start" ? (
                  <Input
                    autoFocus
                    value={editStartStr}
                    onChange={(e) => setEditStartStr(e.target.value)}
                    onBlur={() => commitFieldEdit("start")}
                    onKeyDown={(e) => { if (e.key === "Enter") commitFieldEdit("start"); if (e.key === "Escape") setEditingField(null); }}
                    className="w-20 text-xs font-mono text-center inline-block"
                    data-testid="input-editor-start"
                  />
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="font-mono tabular-nums h-6 px-1"
                    onClick={() => { setEditStartStr(formatTimeFull(clipStart)); setEditingField("start"); }}
                    data-testid="button-editor-start-display"
                  >
                    {formatTimeFull(clipStart)}
                  </Button>
                )}
                <span className="mx-1">→</span>
                {editingField === "end" ? (
                  <Input
                    autoFocus
                    value={editEndStr}
                    onChange={(e) => setEditEndStr(e.target.value)}
                    onBlur={() => commitFieldEdit("end")}
                    onKeyDown={(e) => { if (e.key === "Enter") commitFieldEdit("end"); if (e.key === "Escape") setEditingField(null); }}
                    className="w-20 text-xs font-mono text-center inline-block"
                    data-testid="input-editor-end"
                  />
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="font-mono tabular-nums h-6 px-1"
                    onClick={() => { setEditEndStr(formatTimeFull(clipEnd)); setEditingField("end"); }}
                    data-testid="button-editor-end-display"
                  >
                    {formatTimeFull(clipEnd)}
                  </Button>
                )}
                <span className="ml-2 text-muted-foreground">({Math.round(clipDuration)}с)</span>
              </span>
              <div className="flex-1" />
              {hasChanges && (
                <span className="text-primary">Изменено</span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 flex-wrap border-t pt-2">
          {onAiCalibrate && (
            <Button variant="outline" size="sm" onClick={() => onAiCalibrate(clipStart)} data-testid="button-editor-ai-calib">
              <Search className="w-3 h-3 mr-1" />AI калибр.
            </Button>
          )}
          {onManualCalibrate && (
            <Button variant="outline" size="sm" onClick={() => onManualCalibrate(clipStart)} data-testid="button-editor-manual-calib">
              <Settings className="w-3 h-3 mr-1" />Калибровка
            </Button>
          )}
          <div className="flex-1" />
          {hasCalibration && onPreviewExport && (
            <Button variant="outline" size="sm" onClick={() => { if (hasChanges) onSave(clipStart, clipEnd); onPreviewExport(clipStart, clipEnd); }} disabled={isExporting} data-testid="button-editor-preview-export">
              <Eye className="w-3 h-3 mr-1" />Превью
            </Button>
          )}
          {hasCalibration && onFullExport && (
            <Button variant="outline" size="sm" onClick={() => { if (hasChanges) onSave(clipStart, clipEnd); onFullExport(clipStart, clipEnd); }} disabled={isExporting} data-testid="button-editor-full-export">
              <Film className="w-3 h-3 mr-1" />Рендер
            </Button>
          )}
        </div>

        {exportSettings && (
          <div className="border-t pt-2 mt-1 space-y-2">
            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center gap-1 cursor-pointer">
                <Checkbox checked={exportSettings.muteAudio} onCheckedChange={(v) => exportSettings.setMuteAudio(v === true)} data-testid="checkbox-editor-mute" />
                <span className="text-[10px] text-muted-foreground">Без звука</span>
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <Checkbox checked={exportSettings.bleepProfanity} onCheckedChange={(v) => { exportSettings.setBleepProfanity(v === true); try { localStorage.setItem("bleepProfanity", String(v === true)); } catch {} }} data-testid="checkbox-editor-bleep" />
                <span className="text-[10px] text-muted-foreground">Запикать мат</span>
              </label>
              <select
                value={exportSettings.videoFilter}
                onChange={(e) => { exportSettings.setVideoFilter(e.target.value); }}
                className="h-5 text-[10px] bg-background border border-border rounded px-1 text-muted-foreground min-w-[100px]"
                data-testid="select-editor-video-filter"
              >
                <option value="none">Без фильтра</option>
                <option value="sharpen">🔍 Резкость</option>
                <option value="warm">🌅 Тёплый</option>
                <option value="cool">❄️ Холодный</option>
                <option value="vibrant">🎨 Насыщенный</option>
                <option value="cinematic">🎬 Кинематограф</option>
                <option value="vintage">📷 Винтаж</option>
                <option value="hdr">✨ HDR</option>
                <option value="bw">⬛ Ч/Б</option>
                <option value="soft">☁️ Мягкий</option>
                <option value="dramatic">🔥 Драматичный</option>
              </select>
              <label className="flex items-center gap-1 cursor-pointer">
                <Checkbox checked={exportSettings.resolution === "4k"} onCheckedChange={(v) => { const val = v === true ? "4k" as const : "1080p" as const; exportSettings.setResolution(val); try { localStorage.setItem("exportResolution", val); } catch {} }} data-testid="checkbox-editor-4k" />
                <span className="text-[10px] text-muted-foreground">4K</span>
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <Checkbox checked={exportSettings.useCrawlCaption} onCheckedChange={(v) => { exportSettings.setUseCrawlCaption(v === true); try { localStorage.setItem("useCrawlCaption", String(v === true)); } catch {} }} data-testid="checkbox-editor-caption" />
                <span className="text-[10px] text-muted-foreground">Бег. строка</span>
              </label>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground whitespace-nowrap">📍 Кэпшн Y:</span>
              <input
                type="range"
                min={30}
                max={95}
                step={1}
                value={exportSettings.captionPositionY}
                onChange={(e) => exportSettings.setCaptionPositionY(Number(e.target.value))}
                className="w-24 h-3 accent-blue-500"
                data-testid="slider-caption-position-y"
              />
              <span className="text-[10px] text-muted-foreground w-8">{exportSettings.captionPositionY}%</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground whitespace-nowrap">⏱ Сдвиг:</span>
              <input
                type="range"
                min={-5000}
                max={5000}
                step={100}
                value={exportSettings.subtitleOffsetMs}
                onChange={(e) => exportSettings.setSubtitleOffsetMs(Number(e.target.value))}
                className="w-20 h-3 accent-blue-500"
                data-testid="slider-subtitle-offset"
              />
              <span className="text-[10px] text-muted-foreground w-12">{exportSettings.subtitleOffsetMs > 0 ? "+" : ""}{(exportSettings.subtitleOffsetMs / 1000).toFixed(1)}с</span>
              {exportSettings.subtitleOffsetMs !== 0 && (
                <button onClick={() => exportSettings.setSubtitleOffsetMs(0)} className="text-[9px] text-red-400 hover:text-red-300" data-testid="btn-reset-subtitle-offset">✕</button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground whitespace-nowrap">🅰️ Стиль:</span>
              <button
                onClick={() => exportSettings.setCaptionStyle("classic")}
                className={`px-2 py-0.5 rounded text-[10px] font-bold transition-colors ${exportSettings.captionStyle === "classic" ? "bg-green-500/20 text-green-400 ring-1 ring-green-500/50" : "bg-muted text-muted-foreground hover:text-foreground"}`}
                style={{ fontFamily: "'Inter', sans-serif" }}
                data-testid="btn-caption-style-classic"
              >
                CLASSIC
              </button>
              <button
                onClick={() => exportSettings.setCaptionStyle("mrbeast")}
                className={`px-2 py-0.5 rounded text-[10px] font-bold transition-colors ${exportSettings.captionStyle === "mrbeast" ? "bg-pink-500/20 text-pink-400 ring-1 ring-pink-500/50" : "bg-muted text-muted-foreground hover:text-foreground"}`}
                style={{ fontFamily: "'Komika Title', cursive" }}
                data-testid="btn-caption-style-mrbeast"
              >
                MRBEAST
              </button>
              <button
                onClick={() => exportSettings.setCaptionStyle("glow")}
                className={`px-2 py-0.5 rounded text-[10px] font-bold transition-colors ${exportSettings.captionStyle === "glow" ? "bg-purple-500/20 text-purple-400 ring-1 ring-purple-500/50" : "bg-muted text-muted-foreground hover:text-foreground"}`}
                style={{ fontFamily: "'Montserrat', sans-serif", letterSpacing: "0.5px" }}
                data-testid="btn-caption-style-glow"
              >
                GLOW ✨
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground">🎵</span>
              <select
                value={exportSettings.bgAudioFilename}
                onChange={(e) => { const v = e.target.value; exportSettings.setBgAudioFilename(v); try { localStorage.setItem("bgAudioFilename", v); } catch {}; if (v) exportSettings.toggleSoundPreview(v, true); else if (exportSettings.playingSound) exportSettings.toggleSoundPreview(exportSettings.playingSound); }}
                className="h-6 text-[11px] bg-background border border-border rounded px-1.5 text-muted-foreground max-w-[200px]"
                data-testid="select-editor-bg-audio"
              >
                <option value="">Без музыки</option>
                {(() => {
                  const favs = exportSettings.sounds.filter(s => exportSettings.favoriteSounds.includes(s.filename));
                  const rest = exportSettings.sounds.filter(s => !exportSettings.favoriteSounds.includes(s.filename));
                  return (<>
                    {favs.length > 0 && <optgroup label="⭐ Мои треки">{favs.map(s => <option key={s.id} value={s.filename}>{s.filename.replace(/\.mp3$/i, "")}</option>)}</optgroup>}
                    {rest.length > 0 && <optgroup label="Библиотека">{rest.map(s => <option key={s.id} value={s.filename}>{s.filename.replace(/\.mp3$/i, "")}</option>)}</optgroup>}
                  </>);
                })()}
              </select>
              {exportSettings.bgAudioFilename && (
                <button
                  type="button"
                  onClick={() => exportSettings.toggleSoundPreview(exportSettings.bgAudioFilename)}
                  className={`w-6 h-6 flex items-center justify-center rounded text-[11px] ${exportSettings.playingSound === exportSettings.bgAudioFilename ? "bg-green-600 text-white" : "bg-muted hover:bg-muted/80 text-foreground"}`}
                  data-testid="button-preview-selected-sound"
                  title="Прослушать"
                >
                  {exportSettings.playingSound === exportSettings.bgAudioFilename ? "⏸" : "▶"}
                </button>
              )}
            </div>
            {exportSettings.bgAudioFilename && (
              <div className="space-y-1.5 mt-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground w-12">🔊 Муз</span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={exportSettings.bgAudioVolume}
                    onChange={(e) => { const v = parseFloat(e.target.value); exportSettings.setBgAudioVolume(v); try { localStorage.setItem("bgAudioVolume", String(v)); } catch {} }}
                    className="flex-1 h-3"
                    data-testid="slider-editor-bg-volume"
                  />
                  <span className="text-[10px] text-muted-foreground w-7">{Math.round(exportSettings.bgAudioVolume * 100)}%</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground w-12">🗣 Голос</span>
                  <input
                    type="range"
                    min="0.5"
                    max="3"
                    step="0.1"
                    value={exportSettings.voiceVolume}
                    onChange={(e) => exportSettings.setVoiceVolume(parseFloat(e.target.value))}
                    className="flex-1 h-3"
                    data-testid="slider-voice-volume"
                  />
                  <span className="text-[10px] text-muted-foreground w-7">{Math.round(exportSettings.voiceVolume * 100)}%</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground w-12">⏩ Старт</span>
                  <input
                    type="range"
                    min="0"
                    max="120"
                    step="1"
                    value={exportSettings.musicStartOffset}
                    onChange={(e) => exportSettings.setMusicStartOffset(parseFloat(e.target.value))}
                    className="flex-1 h-3"
                    data-testid="slider-music-start-offset"
                  />
                  <span className="text-[10px] text-muted-foreground w-7">{exportSettings.musicStartOffset}s</span>
                </div>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={exportSettings.musicDropEnabled}
                      onChange={(e) => exportSettings.setMusicDropEnabled(e.target.checked)}
                      className="w-3 h-3"
                      data-testid="checkbox-music-drop"
                    />
                    <span className="text-[11px] text-muted-foreground">Дроп</span>
                  </label>
                  {exportSettings.musicDropEnabled && (
                    <>
                      {exportSettings.musicDropTime != null ? (
                        <span className="text-[10px] text-green-500" data-testid="text-drop-time">
                          @ {exportSettings.musicDropTime.toFixed(1)}s
                        </span>
                      ) : (
                        <span className="text-[10px] text-yellow-500">нет dropTime</span>
                      )}
                      <span className="text-[10px] text-muted-foreground ml-1">до:</span>
                      <input
                        type="range"
                        min="0.05"
                        max="0.5"
                        step="0.05"
                        value={exportSettings.musicDropVolumeBefore}
                        onChange={(e) => exportSettings.setMusicDropVolumeBefore(parseFloat(e.target.value))}
                        className="w-14 h-3"
                        data-testid="slider-drop-volume-before"
                      />
                      <span className="text-[10px] text-muted-foreground w-7">{Math.round(exportSettings.musicDropVolumeBefore * 100)}%</span>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => { setClipStart(initialStart); setClipEnd(initialEnd); }} disabled={!hasChanges} data-testid="button-editor-reset">
            <RotateCcw className="w-3 h-3 mr-1" />Сбросить
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-editor-cancel">
            Закрыть
          </Button>
          {onApproveAndSave && !isApproved && (
            <Button onClick={() => { onApproveAndSave(clipStart, clipEnd); onOpenChange(false); }} data-testid="button-editor-approve">
              <Check className="w-3 h-3 mr-1" />Одобрить
            </Button>
          )}
          <Button onClick={() => { onSave(clipStart, clipEnd); onOpenChange(false); }} disabled={!hasChanges} data-testid="button-editor-save">
            <Check className="w-3 h-3 mr-1" />{isApproved ? "Сохранить" : "Сохранить"}
          </Button>
        </DialogFooter>
        </div>{/* flex-1 */}

        {show916 && (() => {
          const previewH = Math.min(650, Math.round(window.innerHeight * 0.78));
          const previewW = Math.round(previewH * 9 / 16);

          const clipSegs = (transcriptSegments || []).filter(
            (s: TranscriptSegment) => s.end > clipStart && s.start < clipEnd && s.text.trim().length > 0
          );

          const allSubphrasesRaw: { words: { word: string; start: number | null; end: number | null }[]; startTime: number; endTime: number }[] = [];
          for (const seg of clipSegs) {
            const words = seg.words && seg.words.length > 0
              ? seg.words
              : seg.text.split(/\s+/).filter((w: string) => w).map((w: string, wi: number, arr: string[]) => {
                  const d = (seg.end - seg.start) / arr.length;
                  return { word: w, start: seg.start + wi * d, end: seg.start + (wi + 1) * d };
                });
            if (words.length === 0) continue;

            const maxWordsPerPhrase = 3;
            let current: typeof words = [];
            for (const w of words) {
              current.push(w);
              if (current.length >= maxWordsPerPhrase || /[.!?…]$/.test(w.word)) {
                allSubphrasesRaw.push({
                  words: current,
                  startTime: current[0].start ?? seg.start,
                  endTime: current[current.length - 1].end ?? seg.end,
                });
                current = [];
              }
            }
            if (current.length > 0) {
              allSubphrasesRaw.push({
                words: current,
                startTime: current[0].start ?? seg.start,
                endTime: current[current.length - 1].end ?? seg.end,
              });
            }
          }

          allSubphrasesRaw.sort((a, b) => a.startTime - b.startTime);
          const allSubphrases: typeof allSubphrasesRaw = [];
          let lastEnd = -Infinity;
          for (const p of allSubphrasesRaw) {
            if (p.startTime < lastEnd - 0.01 && p.endTime <= lastEnd + 0.05) continue;
            allSubphrases.push(p);
            lastEnd = Math.max(lastEnd, p.endTime);
          }

          const getActivePhrase = () => {
            const t = preview916Url ? (preview916Time + clipStart) : currentTime;

            const phraseIndex = allSubphrases.findIndex(p => t >= p.startTime && t <= p.endTime);
            if (phraseIndex === -1) return null;
            const phrase = allSubphrases[phraseIndex];

            const totalChars = phrase.words.reduce((sum, w) => sum + w.word.length, 0);
            const baseFontSize = Math.round(previewW * 0.065);
            const fontSize = totalChars > 30
              ? Math.max(Math.round(baseFontSize * 0.45), Math.round(baseFontSize * 18 / totalChars))
              : totalChars > 20
              ? Math.round(baseFontSize * 0.65)
              : totalChars > 14
              ? Math.round(baseFontSize * 0.8)
              : baseFontSize;

            return {
              words: phrase.words.map((w, i) => ({
                word: w.word,
                isActive: w.start != null && w.end != null && t >= w.start && t < (w.end ?? 0),
                idx: i,
              })),
              fontSize,
              phraseIdx: phraseIndex,
            };
          };

          const activePhrase = getActivePhrase();

          return (
            <div className="flex-shrink-0 flex flex-col items-center" style={{ width: previewW }} data-testid="preview-916-panel">
              <div
                className="relative rounded-lg overflow-hidden bg-black shadow-xl ring-1 ring-white/10"
                style={{ width: previewW, height: previewH }}
              >
                {!preview916Url && !preview916Loading && !preview916Error && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 z-10 px-4">
                    <span className="text-xs text-muted-foreground text-center">Выберите отрезок и нажмите кнопку</span>
                    <Button size="sm" variant="outline" onClick={generate916Preview} data-testid="button-generate-916">
                      <Eye className="w-3 h-3 mr-1" />Превью 9:16
                    </Button>
                  </div>
                )}
                {preview916Loading && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 z-10">
                    <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                    <span className="text-xs text-muted-foreground">Генерация 9:16...</span>
                  </div>
                )}
                {preview916Error && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 z-10 px-4">
                    <span className="text-xs text-destructive text-center">{preview916Error}</span>
                    <Button size="sm" variant="outline" onClick={generate916Preview} data-testid="button-retry-916">
                      <Eye className="w-3 h-3 mr-1" />Повторить
                    </Button>
                  </div>
                )}
                {preview916Url && (
                  <video
                    ref={preview916Ref}
                    src={preview916Url}
                    className="w-full h-full object-contain cursor-pointer"
                    style={exportSettings?.captionStyle === "glow" ? {
                      filter: "brightness(0.88) contrast(1.10) saturate(1.25)",
                      transform: "scale(1.08)",
                    } : undefined}
                    muted={preview916Muted}
                    playsInline
                    preload="auto"
                    data-testid="video-916-preview"
                    onClick={() => {
                      const v = preview916Ref.current;
                      if (!v) return;
                      if (v.paused) {
                        v.muted = false;
                        setPreview916Muted(false);
                        v.play().catch(() => {});
                        setPreview916Playing(true);
                      } else {
                        v.pause();
                        setPreview916Playing(false);
                      }
                    }}
                    onPlay={() => setPreview916Playing(true)}
                    onPause={() => setPreview916Playing(false)}
                    onEnded={() => setPreview916Playing(false)}
                    onTimeUpdate={(e) => setPreview916Time((e.target as HTMLVideoElement).currentTime)}
                    onError={() => { setPreview916Error("Не удалось загрузить превью. Нажмите обновить."); setPreview916Url(null); setPreview916Playing(false); }}
                  />
                )}
                {exportSettings?.captionStyle === "glow" && preview916Url && (
                  <div
                    className="absolute inset-0 z-15 pointer-events-none rounded-lg"
                    style={{
                      background: "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.5) 100%)",
                    }}
                    data-testid="glow-vignette-overlay"
                  />
                )}
                {exportSettings && (
                  <div
                    className="absolute left-0 right-0 z-20 cursor-ns-resize group"
                    style={{ top: `${previewH * exportSettings.captionPositionY / 100}px`, transform: "translateY(-50%)" }}
                    data-testid="caption-position-handle"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const container = (e.currentTarget.parentElement as HTMLElement);
                      const rect = container.getBoundingClientRect();
                      const onMove = (ev: MouseEvent) => {
                        const pct = Math.max(20, Math.min(95, ((ev.clientY - rect.top) / rect.height) * 100));
                        exportSettings.setCaptionPositionY(Math.round(pct));
                      };
                      const onUp = () => {
                        document.removeEventListener("mousemove", onMove);
                        document.removeEventListener("mouseup", onUp);
                      };
                      document.addEventListener("mousemove", onMove);
                      document.addEventListener("mouseup", onUp);
                    }}
                  >
                    <div className="h-[2px] border-t-2 border-dashed border-yellow-400/60 group-hover:border-yellow-400 mx-1" />
                  </div>
                )}
                {activePhrase && preview916Url && (() => {
                  const style = exportSettings?.captionStyle ?? "classic";
                  const isMrBeast = style === "mrbeast";
                  const isGlow = style === "glow";
                  const glowGradientList = [
                    { top: "#FFF700", bottom: "#A3FF0A" },
                    { top: "#FF4AFF", bottom: "#AA0AFF" },
                    { top: "#FF9800", bottom: "#CC6000" },
                    { top: "#E872D6", bottom: "#9040B0" },
                  ];
                  const glowGrad = isGlow ? glowGradientList[(activePhrase.phraseIdx || 0) % glowGradientList.length] : null;
                  return (
                    <div className="absolute left-0 right-0 z-30 flex flex-wrap justify-center px-3 pointer-events-none" style={{ top: `${previewH * (exportSettings?.captionPositionY ?? 82) / 100}px`, transform: "translateY(-50%)", gap: isMrBeast ? "4px 8px" : isGlow ? "4px 6px" : "4px 6px" }}>
                      {activePhrase.words.map((w, i) => (
                        <span
                          key={`${w.idx}-${w.word}`}
                          className={`uppercase leading-tight transition-colors duration-150 ${isMrBeast ? "font-normal" : "font-black"} ${isGlow ? "" : w.isActive ? (isMrBeast ? "text-pink-400" : "text-green-400") : "text-white"}`}
                          style={{
                            fontSize: `${isMrBeast ? Math.round(activePhrase.fontSize * 1.3) : isGlow ? Math.round(activePhrase.fontSize * 1.15) : activePhrase.fontSize}px`,
                            fontFamily: isMrBeast ? "'Komika Title', cursive" : isGlow ? "'Montserrat', 'Inter', sans-serif" : "'Inter', sans-serif",
                            fontWeight: isGlow ? 800 : undefined,
                            ...(isGlow && glowGrad ? {
                              background: `linear-gradient(to bottom, ${glowGrad.top}, ${glowGrad.bottom})`,
                              WebkitBackgroundClip: "text",
                              WebkitTextFillColor: "transparent",
                              backgroundClip: "text",
                              filter: `drop-shadow(0 3px 4px rgba(0,0,0,0.7)) drop-shadow(0 0 8px ${glowGrad.top}44)`,
                            } : {}),
                            textShadow: isGlow
                              ? undefined
                              : isMrBeast
                              ? "2px 2px 4px rgba(0,0,0,0.8), 0 0 8px rgba(0,0,0,0.6)"
                              : "0 0 8px rgba(0,0,0,0.95), 0 2px 8px rgba(0,0,0,0.8), 2px 2px 4px rgba(0,0,0,0.6)",
                          }}
                        >
                          {censorProfanity(w.word.replace(/[\/\\]/g, "").replace(/[-–—]/g, "").trim())}
                        </span>
                      ))}
                    </div>
                  );
                })()}
                <div className="absolute top-2 left-2 text-[9px] text-white/50 font-mono bg-black/40 px-1.5 py-0.5 rounded">9:16</div>
                {preview916Url && !preview916Loading && (
                  <div className="absolute top-2 right-2 flex items-center gap-1">
                    <button
                      className="text-[9px] text-white/60 hover:text-white bg-black/50 hover:bg-black/70 px-2 py-1 rounded transition-colors"
                      onClick={generate916Preview}
                      data-testid="button-refresh-916"
                    >
                      ↻
                    </button>
                  </div>
                )}
                {preview916Url && (
                  <div className="absolute bottom-0 left-0 right-0 z-20 bg-gradient-to-t from-black/80 to-transparent pt-6 pb-2 px-3">
                    <div
                      className="w-full h-5 flex items-center cursor-pointer group mb-1"
                      data-testid="seekbar-916"
                      onMouseDown={(e) => {
                        const v = preview916Ref.current;
                        if (!v || !v.duration) return;
                        const rect = e.currentTarget.getBoundingClientRect();
                        const seek = (clientX: number) => {
                          const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                          v.currentTime = pct * v.duration;
                        };
                        seek(e.clientX);
                        const onMove = (ev: MouseEvent) => seek(ev.clientX);
                        const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
                        document.addEventListener("mousemove", onMove);
                        document.addEventListener("mouseup", onUp);
                      }}
                    >
                      <div className="w-full h-1 group-hover:h-1.5 bg-white/30 rounded-full relative transition-all">
                        <div
                          className="absolute left-0 top-0 h-full bg-green-400 rounded-full transition-all"
                          style={{ width: `${preview916Ref.current?.duration ? (preview916Time / preview916Ref.current.duration) * 100 : 0}%` }}
                        />
                        <div
                          className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow opacity-0 group-hover:opacity-100 transition-opacity"
                          style={{ left: `${preview916Ref.current?.duration ? (preview916Time / preview916Ref.current.duration) * 100 : 0}%`, transform: "translate(-50%, -50%)" }}
                        />
                      </div>
                    </div>
                    <div className="flex items-center justify-center gap-2">
                      <span className="text-[10px] text-white/60 font-mono min-w-[32px] text-right">{formatTime(preview916Time)}</span>
                      <button
                        className="w-7 h-7 flex items-center justify-center rounded-full bg-black/60 hover:bg-black/80 text-white text-sm transition-colors"
                        onClick={() => { const v = preview916Ref.current; if (v) { v.currentTime = 0; v.muted = false; setPreview916Muted(false); v.play().catch(() => {}); setPreview916Playing(true); } }}
                        data-testid="button-916-restart"
                        title="С начала"
                      >
                        ↺
                      </button>
                      <button
                        className="w-8 h-8 flex items-center justify-center rounded-full bg-black/60 hover:bg-black/80 text-white text-base transition-colors"
                        onClick={() => {
                          const v = preview916Ref.current;
                          if (!v) return;
                          if (v.paused) { v.muted = false; setPreview916Muted(false); v.play().catch(() => {}); setPreview916Playing(true); }
                          else { v.pause(); setPreview916Playing(false); }
                        }}
                        data-testid="button-916-playpause"
                        title={preview916Playing ? "Пауза" : "Воспроизвести"}
                      >
                        {preview916Playing ? "⏸" : "▶"}
                      </button>
                      <button
                        className={`w-7 h-7 flex items-center justify-center rounded-full ${preview916Muted ? "bg-red-600/60 hover:bg-red-600/80" : "bg-black/60 hover:bg-black/80"} text-white text-sm transition-colors`}
                        onClick={() => setPreview916Muted(!preview916Muted)}
                        data-testid="button-916-mute"
                        title={preview916Muted ? "Включить звук" : "Выключить звук"}
                      >
                        {preview916Muted ? "🔇" : "🔊"}
                      </button>
                      <span className="text-[10px] text-white/60 font-mono min-w-[32px]">{formatTime(preview916Ref.current?.duration || 0)}</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        </div>{/* flex gap-3 */}
      </DialogContent>
    </Dialog>
  );
}


function TranscriptViewer({
  segments,
  onSeekTo,
  currentTime,
  videoRef: externalVideoRef,
}: {
  segments: TranscriptSegment[];
  onSeekTo?: (time: number) => void;
  currentTime?: number;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const activeSegRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const prevWordRef = useRef<{ el: HTMLElement; start: number; end: number } | null>(null);
  const tvRafRef = useRef<number>(0);

  const filtered = searchQuery.trim()
    ? segments.filter((s) => s.text.toLowerCase().includes(searchQuery.toLowerCase()))
    : segments;

  const activeSegIndex = currentTime !== undefined
    ? filtered.findIndex((seg, i) => {
        const nextSeg = filtered[i + 1];
        return currentTime >= seg.start && (nextSeg ? currentTime < nextSeg.start : currentTime <= seg.end + 2);
      })
    : -1;

  useEffect(() => {
    if (!externalVideoRef) return;
    const hlWord = (t: number) => {
      const prev = prevWordRef.current;
      if (prev && t >= prev.start && t < prev.end) return;
      if (prev) {
        prev.el.classList.remove('word-hl');
        prevWordRef.current = null;
      }
      const container = scrollContainerRef.current;
      if (!container) return;
      const next = prev?.el?.nextElementSibling as HTMLElement | null;
      if (next?.dataset?.ws) {
        const ws = Number(next.dataset.ws);
        const we = Number(next.dataset.we);
        if (t >= ws && t < we) {
          next.classList.add('word-hl');
          prevWordRef.current = { el: next, start: ws, end: we };
          return;
        }
      }
      const spans = container.querySelectorAll<HTMLElement>('[data-ws]');
      for (const span of spans) {
        const ws = Number(span.dataset.ws);
        const we = Number(span.dataset.we);
        if (t >= ws && t < we) {
          span.classList.add('word-hl');
          prevWordRef.current = { el: span, start: ws, end: we };
          return;
        }
      }
    };
    const tick = () => {
      const v = externalVideoRef.current;
      if (v && !v.paused) hlWord(v.currentTime);
      tvRafRef.current = requestAnimationFrame(tick);
    };
    tvRafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(tvRafRef.current);
  }, [externalVideoRef]);

  useEffect(() => {
    if (autoScroll && activeSegRef.current && scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      const el = activeSegRef.current;
      const elTop = el.offsetTop - container.offsetTop;
      const elBottom = elTop + el.offsetHeight;
      const viewTop = container.scrollTop;
      const viewBottom = viewTop + container.clientHeight;
      if (elTop < viewTop + 40 || elBottom > viewBottom - 40) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  }, [activeSegIndex, autoScroll]);

  const handleScroll = useCallback(() => {
    setAutoScroll(false);
  }, []);

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            placeholder="Поиск по тексту..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8"
            data-testid="input-transcript-search"
          />
        </div>
        {!autoScroll && (
          <button
            onClick={() => setAutoScroll(true)}
            className="text-[10px] text-muted-foreground hover:text-foreground px-2 whitespace-nowrap"
            data-testid="button-transcript-autoscroll"
          >
            ↓ Следить
          </button>
        )}
      </div>
      <div
        ref={scrollContainerRef}
        className="max-h-[500px] overflow-auto space-y-1"
        onWheel={handleScroll}
      >
        {filtered.map((seg, i) => {
          const isActive = i === activeSegIndex;
          return (
            <div
              key={i}
              ref={isActive ? activeSegRef : undefined}
              className={`flex gap-3 py-2 px-3 rounded-md hover-elevate cursor-pointer group transition-colors ${isActive ? "bg-primary/10 ring-1 ring-primary/30" : ""}`}
              onClick={() => onSeekTo?.(seg.start)}
              data-testid={`transcript-segment-${i}`}
            >
              <span className={`text-sm font-mono whitespace-nowrap min-w-[50px] pt-0.5 ${isActive ? "text-primary font-bold" : "text-muted-foreground"}`}>
                {formatTime(seg.start)}
              </span>
              <span className="text-sm leading-relaxed">
                {currentTime !== undefined && isActive ? (() => {
                  const words = seg.words && seg.words.length > 0
                    ? seg.words.map(w => ({ ...w, word: w.word.endsWith(" ") ? w.word : w.word + " " }))
                    : seg.text.split(/(\s+)/).filter(w => w.trim()).map((w, wi, arr) => {
                        const segDur = seg.end - seg.start;
                        const wDur = segDur / arr.length;
                        return { word: w + " ", start: seg.start + wi * wDur, end: seg.start + (wi + 1) * wDur };
                      });
                  return words.map((w, wi) => {
                    const tvWStart = w.start ?? seg.start;
                    const tvWEnd = w.end ?? seg.end;
                    const tvHasTs = w.start != null && w.end != null;
                    return (
                      <span
                        key={wi}
                        {...(tvHasTs ? { "data-ws": tvWStart, "data-we": tvWEnd } : {})}
                        className="text-foreground"
                        onClick={(e) => { e.stopPropagation(); onSeekTo?.(tvWStart); }}
                      >
                        {w.word}
                      </span>
                    );
                  });
                })() : (
                  <span className={isActive ? "text-foreground font-medium" : "text-foreground"}>{seg.text}</span>
                )}
              </span>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">Ничего не найдено</p>
        )}
      </div>
    </div>
  );
}

function ClipRow({
  clip,
  video,
  clipExport,
  clipExportSquare,
  clipPreviewExport,
  selectedProfile,
  onApprove,
  onReject,
  onDelete,
  onExport,
  onPreviewExport,
  onPreview,
  onShowInPanel,
  onSaveTime,
  onAiCalibrate,
  onManualCalibrate,
  onYoutubeUpload,
  youtubeConnected,
  youtubeUploading,
  onSocialUpload,
  onBulkUpload,
  socialStatuses,
  socialUploading,
  bulkUploading,
  activePanelExportId,
  onRetryExport,
  pmpPubTracking,
  onUnpublish,
  isUploading,
  isViewed,
}: {
  clip: SuggestedClip;
  video: Video;
  clipExport?: ExportJob;
  clipExportSquare?: ExportJob;
  clipPreviewExport?: ExportJob;
  selectedProfile?: StreamerProfile;
  onApprove: (clipId: string, startTime: number, endTime: number) => void;
  onReject: (clipId: string) => void;
  onDelete: (clipId: string) => void;
  onExport: (clipId: string) => void;
  onPreviewExport: (clipId: string) => void;
  onPreview: (clip: SuggestedClip) => void;
  onShowInPanel: (exportJob: ExportJob, label: string, clipTitle?: string) => void;
  onSaveTime: (clipId: string, startTime: number, endTime: number) => void;
  onAiCalibrate?: (time: number) => void;
  onManualCalibrate?: (time: number) => void;
  onYoutubeUpload?: (exportId: string, title: string, description: string) => void;
  youtubeConnected?: boolean;
  youtubeUploading?: boolean;
  onSocialUpload?: (platform: string, exportId: string, title: string, description: string) => void;
  onBulkUpload?: (exportId: string, title: string, description: string, hashtagPlatforms?: Record<string, boolean>, tiktokCustomTags?: string) => void;
  socialStatuses?: Record<string, { connected: boolean; accountName?: string | null; [key: string]: any }>;
  socialUploading?: string | null;
  bulkUploading?: boolean;
  activePanelExportId?: string;
  onRetryExport?: (exportId: string) => void;
  pmpPubTracking?: Record<string, { publicationId: number; platform: string; status: string; polling: boolean }>;
  onUnpublish?: (exportId: string, platform: string) => void;
  isUploading?: boolean;
  isViewed?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { toast } = useToast();
  const [editingTitle, setEditingTitle] = useState(false);
  const [editTitleValue, setEditTitleValue] = useState(clip.title || "");
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [ytThumbUploading, setYtThumbUploading] = useState(false);
  const ytThumbInputRef = useRef<HTMLInputElement>(null);
  const [ytDialogOpen, setYtDialogOpen] = useState(false);
  const [ytTitle, setYtTitle] = useState("");
  const [ytDescription, setYtDescription] = useState("");
  const [ytWithTags, setYtWithTags] = useState(false);
  const [ytExportId, setYtExportId] = useState("");
  const [socialDialogOpen, setSocialDialogOpen] = useState(false);
  const [socialPlatform, setSocialPlatform] = useState("");
  const [socialTitle, setSocialTitle] = useState("");
  const [socialDescription, setSocialDescription] = useState("");
  const [socialExportId, setSocialExportId] = useState("");
  const [socialWithTags, setSocialWithTags] = useState(true);
  const [socialTiktokCustomTags, setSocialTiktokCustomTags] = useState("");
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [bulkTitle, setBulkTitle] = useState("");
  const [bulkDescription, setBulkDescription] = useState("");
  const [bulkHashtagPlatforms, setBulkHashtagPlatforms] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem("bulkHashtagPlatforms");
      if (saved) return JSON.parse(saved);
    } catch {}
    return { youtube: true, tiktok: true, instagram: true, facebook: true, threads: true, vk: true };
  });
  const [bulkTiktokCustomTags, setBulkTiktokCustomTags] = useState("");
  const [bulkExportId, setBulkExportId] = useState("");
  const [thumbLoading, setThumbLoading] = useState(false);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [thumbDialogOpen, setThumbDialogOpen] = useState(false);
  const [thumbText, setThumbText] = useState("");

  const isPoker = video?.contentType !== "streamer";
  const pokerTags: Record<string, string> = isPoker ? {
    youtube: "#покер #покерок #покерок_shorts @POKEROK_Life",
    instagram: "#покер #покерок #покерок_shorts @pokerok_official",
    vk: "#покер #покерок #покерок_shorts",
    tiktok: "#покерок #покерок_shorts",
    facebook: "#покер #покерок #покерок_shorts",
    threads: "#покер #покерок #покерок_shorts",
  } : {
    youtube: "",
    instagram: "",
    vk: "",
    tiktok: "",
    facebook: "",
    threads: "",
  };

  const handleYtThumbnailUpload = async (file: File, youtubeVideoId: string) => {
    setYtThumbUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("youtubeVideoId", youtubeVideoId);
      const res = await fetch("/api/youtube/thumbnail", { method: "POST", body: formData });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Ошибка загрузки");
      }
      toast({ title: "Превью обновлено на YouTube" });
    } catch (err: any) {
      toast({ title: "Ошибка", description: err.message, variant: "destructive" });
    } finally {
      setYtThumbUploading(false);
      if (ytThumbInputRef.current) ytThumbInputRef.current.value = "";
    }
  };

  const effectiveStart = clip.adjustedStartTime ?? clip.startTime;
  const effectiveEnd = clip.adjustedEndTime ?? clip.endTime;
  const [trimRange, setTrimRange] = useState<[number, number]>([effectiveStart, effectiveEnd]);
  const [editing, setEditing] = useState(false);
  const [editStart, setEditStart] = useState(formatTime(effectiveStart));
  const [editEnd, setEditEnd] = useState(formatTime(effectiveEnd));

  useEffect(() => {
    setTrimRange([effectiveStart, effectiveEnd]);
    setEditStart(formatTime(effectiveStart));
    setEditEnd(formatTime(effectiveEnd));
  }, [effectiveStart, effectiveEnd]);

  const hasTimeChanges = trimRange[0] !== effectiveStart || trimRange[1] !== effectiveEnd;

  const duration = trimRange[1] - trimRange[0];
  const excitement = (clip.signals as any)?.excitement || Math.round(clip.confidence * 100);
  const reasons = clip.reasons as string[];

  const isApproved = clip.status === "approved";
  const hasCompletedExport = clipExport?.status === "completed";
  const isPublished = clipExport?.publishedTo && clipExport.publishedTo.length > 0;

  return (
    <Card className={`${isUploading ? "ring-2 ring-yellow-500/70 border-yellow-500/50 bg-yellow-500/10" : isPublished ? "border-purple-500/50 bg-purple-500/5" : hasCompletedExport ? "border-blue-500/50 bg-blue-500/5" : isApproved ? "border-green-500/50 bg-green-500/5" : ""}`} data-testid={`card-clip-${clip.id}`}>
      <CardContent className="p-3">
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                {editingTitle ? (
                  <input
                    ref={titleInputRef}
                    data-testid={`input-clip-title-${clip.id}`}
                    className="text-sm font-medium bg-transparent border-b border-primary outline-none w-full"
                    value={editTitleValue}
                    onChange={(e) => setEditTitleValue(e.target.value)}
                    onBlur={async () => {
                      setEditingTitle(false);
                      const trimmed = editTitleValue.trim();
                      if (trimmed && trimmed !== clip.title) {
                        try {
                          await fetch(`/api/clips/${clip.id}`, {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ title: trimmed }),
                          });
                          queryClient.invalidateQueries({ queryKey: ["/api/clips", { videoId: clip.videoId }] });
                        } catch {}
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") { setEditTitleValue(clip.title || ""); setEditingTitle(false); }
                    }}
                    autoFocus
                  />
                ) : (
                  <span
                    className="text-sm font-medium cursor-pointer hover:underline"
                    data-testid={`text-clip-title-${clip.id}`}
                    onClick={() => { setEditTitleValue(clip.title || ""); setEditingTitle(true); }}
                    title="Нажмите чтобы переименовать"
                  >
                    {clip.title || `${formatTime(clip.startTime)} - ${formatTime(clip.endTime)}`}
                  </span>
                )}
                {isUploading && (
                  <Badge variant="default" className="text-xs bg-yellow-600 border-yellow-700" data-testid={`badge-uploading-${clip.id}`}>
                    <Loader2 className="w-3 h-3 mr-0.5 animate-spin" />
                    Загрузка...
                  </Badge>
                )}
                {isApproved && !isUploading && (
                  <Badge variant="default" className={`text-xs ${isPublished ? "bg-purple-600 border-purple-700" : hasCompletedExport ? "bg-blue-600 border-blue-700" : "bg-green-600 border-green-700"}`} data-testid={`badge-approved-${clip.id}`}>
                    <Check className="w-3 h-3 mr-0.5" />
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                <Badge variant="outline" className="text-xs font-mono">
                  {formatTime(effectiveStart)} — {formatTime(effectiveEnd)}
                </Badge>
                <Badge variant="outline" className="text-xs font-mono">
                  {Math.round(duration)}с
                </Badge>
                <Badge
                  variant={excitement >= 70 ? "default" : "secondary"}
                  className={`text-xs ${excitement >= 90 ? "bg-red-600 border-red-700" : excitement >= 75 ? "bg-orange-600 border-orange-700" : ""}`}
                >
                  {excitement}
                </Badge>
                {clip.dropTime != null && (
                  <Badge variant="outline" className="text-xs text-purple-400 border-purple-500/50" data-testid={`badge-drop-${clip.id}`}>
                    🎵 {clip.dropTime.toFixed(1)}s
                  </Badge>
                )}
              </div>
            </div>
            <div className="flex items-center gap-0.5 flex-shrink-0">
              <Button size="icon" variant="ghost" className={isViewed ? "ring-1 ring-blue-400/40 text-blue-400/70" : ""} onClick={() => onPreview(clip)} data-testid={`button-preview-${clip.id}`}>
                <Play className="w-4 h-4" />
              </Button>
              {onManualCalibrate && (
                <Button size="icon" variant="ghost" onClick={() => onManualCalibrate(trimRange[0])} title="Рекалибровка" data-testid={`button-recalib-${clip.id}`}>
                  <Settings className="w-4 h-4" />
                </Button>
              )}
              {onAiCalibrate && (
                <Button size="icon" variant="ghost" onClick={() => onAiCalibrate(trimRange[0])} title="AI калибровка" data-testid={`button-ai-calib-${clip.id}`}>
                  <Search className="w-4 h-4" />
                </Button>
              )}
              <Button size="icon" variant="ghost" onClick={() => onDelete(clip.id)} title="Удалить клип" data-testid={`button-delete-${clip.id}`}>
                <Trash2 className="w-4 h-4" />
              </Button>
              <Button size="icon" variant="ghost" onClick={() => setExpanded(!expanded)} data-testid={`button-expand-${clip.id}`}>
                {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </Button>
            </div>
          </div>

          {clip.description && (
            <p className="text-xs text-muted-foreground">{clip.description}</p>
          )}

          <div className="flex items-center gap-1 flex-wrap">
            {editing ? (
              <div className="flex items-center gap-1">
                <Input
                  value={editStart}
                  onChange={(e) => setEditStart(e.target.value)}
                  className="w-16 text-xs font-mono"
                  placeholder="0:00"
                  data-testid={`input-start-time-${clip.id}`}
                />
                <span className="text-xs text-muted-foreground">—</span>
                <Input
                  value={editEnd}
                  onChange={(e) => setEditEnd(e.target.value)}
                  className="w-16 text-xs font-mono"
                  placeholder="0:00"
                  data-testid={`input-end-time-${clip.id}`}
                />
                <Button size="sm" variant="default" onClick={() => {
                  const s = parseTimeInput(editStart);
                  const e = parseTimeInput(editEnd);
                  if (s === null || e === null) {
                    toast({ title: "Неверный формат", description: "Используйте формат M:SS или H:MM:SS", variant: "destructive" });
                    return;
                  }
                  if (e <= s) {
                    toast({ title: "Конец должен быть позже начала", variant: "destructive" });
                    return;
                  }
                  if (s < 0) {
                    toast({ title: "Время не может быть отрицательным", variant: "destructive" });
                    return;
                  }
                  setTrimRange([s, e]);
                  setEditing(false);
                }} data-testid={`button-save-time-${clip.id}`}>
                  <Check className="w-3 h-3" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => {
                  setEditStart(formatTime(trimRange[0]));
                  setEditEnd(formatTime(trimRange[1]));
                  setEditing(false);
                }} data-testid={`button-cancel-time-${clip.id}`}>
                  <X className="w-3 h-3" />
                </Button>
              </div>
            ) : (
              <button
                className="text-xs text-muted-foreground font-mono cursor-pointer hover:text-foreground transition-colors"
                onClick={() => {
                  setEditStart(formatTime(trimRange[0]));
                  setEditEnd(formatTime(trimRange[1]));
                  setEditing(true);
                }}
                title="Нажмите чтобы изменить время"
                data-testid={`button-edit-time-${clip.id}`}
              >
                {formatTime(trimRange[0])} - {formatTime(trimRange[1])}
              </button>
            )}
            {reasons.map((tag, i) => (
              <Badge key={i} variant="secondary" className="text-xs">{tag}</Badge>
            ))}
          </div>

          <div className="flex items-center gap-1 flex-wrap">
            {!isApproved && (
              <>
                {hasTimeChanges ? (
                  <Button size="sm" variant="default" onClick={() => {
                    onApprove(clip.id, trimRange[0], trimRange[1]);
                  }} data-testid={`button-save-approve-${clip.id}`}>
                    <Check className="w-3 h-3 mr-1" />Сохранить + Утвердить
                  </Button>
                ) : (
                  <Button size="sm" variant="default" onClick={() => {
                    onApprove(clip.id, effectiveStart, effectiveEnd);
                  }} data-testid={`button-approve-${clip.id}`}>
                    <Check className="w-3 h-3 mr-1" />Утвердить
                  </Button>
                )}
              </>
            )}
            {isApproved && hasTimeChanges && (
              <Button size="sm" variant="default" onClick={() => {
                onApprove(clip.id, trimRange[0], trimRange[1]);
              }} data-testid={`button-save-approve-${clip.id}`}>
                <Check className="w-3 h-3 mr-1" />Сохранить границы
              </Button>
            )}
          </div>

          {isApproved && (
            <div className="flex items-center gap-1 flex-wrap">
              {selectedProfile?.calibration ? (
                <>
                  {(!clipPreviewExport || clipPreviewExport.status !== "processing") && (!clipExport || clipExport.status !== "processing") && (!clipExportSquare || clipExportSquare.status !== "processing") && (
                    <Button variant="outline" size="sm" onClick={() => onPreviewExport(clip.id)} data-testid={`button-preview-render-${clip.id}`}>
                      <Eye className="w-3 h-3 mr-1" />Превью
                    </Button>
                  )}
                  {(!clipExport || clipExport.status !== "processing") && (!clipPreviewExport || clipPreviewExport.status !== "processing") && (!clipExportSquare || clipExportSquare.status !== "processing") && (
                    <Button variant="outline" size="sm" onClick={() => onExport(clip.id)} data-testid={`button-export-${clip.id}`}>
                      <Film className="w-3 h-3 mr-1" />Экспорт
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={thumbLoading}
                    onClick={() => {
                      setThumbText(clip.title || "");
                      setThumbDialogOpen(true);
                    }}
                    data-testid={`button-thumbnail-preexport-${clip.id}`}
                  >
                    {thumbLoading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <ImageIcon className="w-3 h-3 mr-1" />}
                    Обложка
                  </Button>
                </>
              ) : (
                <span className="text-xs text-muted-foreground" data-testid={`text-need-calibration-${clip.id}`}>
                  <AlertCircle className="w-3 h-3 inline mr-1" />Для экспорта нужна калибровка профиля
                </span>
              )}
            </div>
          )}

          {(clipExport?.status === "processing" || clipPreviewExport?.status === "processing") && (() => {
            const activeJob = clipPreviewExport?.status === "processing" ? clipPreviewExport : clipExport;
            const label = clipPreviewExport?.status === "processing" ? "Превью" : "Рендер";
            const pct = activeJob?.progress ?? 0;
            return (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Loader2 className="w-3 h-3 animate-spin text-muted-foreground flex-shrink-0" />
                  <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full transition-all duration-500"
                      style={{ width: `${Math.max(pct, 2)}%` }}
                      data-testid={`progress-bar-${clip.id}`}
                    />
                  </div>
                  <span className="text-xs text-muted-foreground font-mono flex-shrink-0">{label} {pct}%</span>
                  {activeJob && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 flex-shrink-0"
                      onClick={async () => {
                        try {
                          await apiRequest("POST", `/api/exports/${activeJob.id}/cancel`);
                          queryClient.invalidateQueries({ queryKey: ["/api/exports"] });
                          toast({ title: "Экспорт отменён" });
                        } catch {
                          toast({ title: "Не удалось отменить", variant: "destructive" });
                        }
                      }}
                      data-testid={`button-cancel-export-${clip.id}`}
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })()}

          {clipPreviewExport && clipPreviewExport.status === "completed" && (
            <Button
              variant={activePanelExportId === clipPreviewExport.id ? "secondary" : "default"}
              size="sm"
              onClick={() => onShowInPanel(clipPreviewExport, "Превью", clip.title || `${formatTime(clip.startTime)} - ${formatTime(clip.endTime)}`)}
              data-testid={`button-view-preview-${clip.id}`}
            >
              <Eye className="w-3 h-3 mr-1" />
              {activePanelExportId === clipPreviewExport.id ? "Показано" : "Превью 9:16"}
            </Button>
          )}

          {clipExport && clipExport.status === "completed" && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1 flex-wrap">
                <Button
                  variant={activePanelExportId === clipExport.id ? "secondary" : "default"}
                  size="sm"
                  onClick={() => onShowInPanel(clipExport, "Short", clip.title || `${formatTime(clip.startTime)} - ${formatTime(clip.endTime)}`)}
                  data-testid={`button-preview-export-${clip.id}`}
                >
                  <Film className="w-3 h-3 mr-1" />
                  {activePanelExportId === clipExport.id ? "Показано" : "9:16"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    const url = `/api/exports/${clipExport.id}/download`;
                    const defaultName = (clip.title || `poker_short_${clip.id}`).replace(/[^a-zA-Zа-яА-ЯёЁ0-9_-]/g, "_") + ".mp4";
                    try {
                      if ("showSaveFilePicker" in window) {
                        const handle = await (window as any).showSaveFilePicker({
                          suggestedName: defaultName,
                          types: [{ description: "MP4 Video", accept: { "video/mp4": [".mp4"] } }],
                        });
                        const res = await fetch(url);
                        const blob = await res.blob();
                        const writable = await handle.createWritable();
                        await writable.write(blob);
                        await writable.close();
                      } else {
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = defaultName;
                        a.click();
                      }
                    } catch (e: any) {
                      if (e?.name !== "AbortError") {
                        window.open(url, "_blank");
                      }
                    }
                  }}
                  data-testid={`button-download-${clip.id}`}
                >
                  <Download className="w-3 h-3 mr-1" />Скачать
                </Button>
                {socialStatuses?.youtube?.connected && onSocialUpload && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={socialUploading === "youtube"}
                    onClick={() => {
                      setSocialPlatform("youtube");
                      setSocialTitle(clip.title || `Poker ${formatTime(clip.startTime)}`);
                      setSocialDescription("");
                      setSocialExportId(clipExport.id);
                      setSocialDialogOpen(true);
                    }}
                    data-testid={`button-youtube-${clip.id}`}
                  >
                    {socialUploading === "youtube" ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <SiYoutube className="w-3 h-3 mr-1 text-red-500" />}
                    YouTube
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-1 flex-wrap">
                {(() => {
                  const connectedCount = [
                    socialStatuses?.youtube?.connected,
                    socialStatuses?.vk?.connected,
                    socialStatuses?.tiktok?.connected,
                    socialStatuses?.instagram?.connected,
                    socialStatuses?.facebook?.connected,
                    socialStatuses?.threads?.connected,
                  ].filter(Boolean).length;
                  return connectedCount >= 2 && onBulkUpload ? (
                    <Button
                      variant="default"
                      size="sm"
                      disabled={!!bulkUploading || !!socialUploading || youtubeUploading}
                      onClick={() => {
                        setBulkTitle(clip.title || `Poker ${formatTime(clip.startTime)}`);
                        setBulkDescription("");
                        setBulkHashtagPlatforms({ youtube: true, tiktok: true, instagram: true, facebook: true, threads: true, vk: true });
                        setBulkTiktokCustomTags("");
                        setBulkExportId(clipExport.id);
                        setBulkDialogOpen(true);
                      }}
                      data-testid={`button-bulk-upload-${clip.id}`}
                    >
                      {bulkUploading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Share2 className="w-3 h-3 mr-1" />}
                      Во все ({connectedCount})
                    </Button>
                  ) : null;
                })()}
                {socialStatuses?.vk?.connected && onSocialUpload && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={socialUploading === "vk"}
                    onClick={() => {
                      setSocialPlatform("vk");
                      setSocialTitle(clip.title || `Poker ${formatTime(clip.startTime)}`);
                      setSocialDescription("");
                      setSocialExportId(clipExport.id);
                      setSocialDialogOpen(true);
                    }}
                    data-testid={`button-vk-${clip.id}`}
                  >
                    {socialUploading === "vk" ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <SiVk className="w-3 h-3 mr-1 text-blue-500" />}
                    VK
                  </Button>
                )}
                {socialStatuses?.tiktok?.connected && onSocialUpload && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={socialUploading === "tiktok"}
                    onClick={() => {
                      setSocialPlatform("tiktok");
                      setSocialTitle(clip.title || `Poker ${formatTime(clip.startTime)}`);
                      setSocialDescription("");
                      setSocialTiktokCustomTags("");
                      setSocialExportId(clipExport.id);
                      setSocialDialogOpen(true);
                    }}
                    data-testid={`button-tiktok-${clip.id}`}
                  >
                    {socialUploading === "tiktok" ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <SiTiktok className="w-3 h-3 mr-1" />}
                    TikTok
                  </Button>
                )}
                {socialStatuses?.instagram?.connected && onSocialUpload && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={socialUploading === "instagram"}
                    onClick={() => {
                      setSocialPlatform("instagram");
                      setSocialTitle(clip.title || `Poker ${formatTime(clip.startTime)}`);
                      setSocialDescription("");
                      setSocialExportId(clipExport.id);
                      setSocialDialogOpen(true);
                    }}
                    data-testid={`button-instagram-${clip.id}`}
                  >
                    {socialUploading === "instagram" ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <SiInstagram className="w-3 h-3 mr-1 text-pink-500" />}
                    IG
                  </Button>
                )}
                {socialStatuses?.facebook?.connected && onSocialUpload && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={socialUploading === "facebook"}
                    onClick={() => {
                      setSocialPlatform("facebook");
                      setSocialTitle(clip.title || `Poker ${formatTime(clip.startTime)}`);
                      setSocialDescription("");
                      setSocialExportId(clipExport.id);
                      setSocialDialogOpen(true);
                    }}
                    data-testid={`button-facebook-${clip.id}`}
                  >
                    {socialUploading === "facebook" ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <SiFacebook className="w-3 h-3 mr-1 text-blue-600" />}
                    FB
                  </Button>
                )}
                {socialStatuses?.threads?.connected && onSocialUpload && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={socialUploading === "threads"}
                    onClick={() => {
                      setSocialPlatform("threads");
                      setSocialTitle(clip.title || `Poker ${formatTime(clip.startTime)}`);
                      setSocialDescription("");
                      setSocialExportId(clipExport.id);
                      setSocialDialogOpen(true);
                    }}
                    data-testid={`button-threads-${clip.id}`}
                  >
                    {socialUploading === "threads" ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <SiThreads className="w-3 h-3 mr-1" />}
                    Threads
                  </Button>
                )}
              </div>
              {clipExport.publishedTo && clipExport.publishedTo.length > 0 && (() => {
                const urls = (clipExport.publishedUrls as Record<string, string>) || {};
                const allPlatforms: { key: string; label: string; icon: any; iconClass: string }[] = [
                  { key: "youtube", label: "YT", icon: SiYoutube, iconClass: "w-2.5 h-2.5 text-red-500" },
                  { key: "vk", label: "VK", icon: SiVk, iconClass: "w-2.5 h-2.5 text-blue-500" },
                  { key: "tiktok", label: "TT", icon: SiTiktok, iconClass: "w-2.5 h-2.5" },
                  { key: "instagram", label: "IG", icon: SiInstagram, iconClass: "w-2.5 h-2.5 text-pink-500" },
                  { key: "facebook", label: "FB", icon: SiFacebook, iconClass: "w-2.5 h-2.5 text-blue-600" },
                  { key: "threads", label: "TH", icon: SiThreads, iconClass: "w-2.5 h-2.5" },
                ];
                const published = clipExport.publishedTo || [];
                return (
                  <div className="flex items-center gap-1 flex-wrap" data-testid={`published-to-${clip.id}`}>
                    {allPlatforms.map(p => {
                      const isPublished = published.includes(p.key);
                      const Icon = p.icon;
                      const ytUrl = p.key === "youtube" ? urls["youtube"] : null;
                      if (isPublished && ytUrl) {
                        const ytVideoId = p.key === "youtube" ? (ytUrl.match(/shorts\/([^/?]+)/) || ytUrl.match(/watch\?v=([^&]+)/) || [])[1] : null;
                        return (
                          <span key={p.key} className="inline-flex items-center gap-0.5">
                            <a href={ytUrl} target="_blank" rel="noopener noreferrer">
                              <Badge variant="secondary" className="text-[10px] gap-1 cursor-pointer" data-testid={`badge-published-${p.key}-${clip.id}`}>
                                <Icon className={p.iconClass} />{p.label}
                                <ExternalLink className="w-2 h-2 ml-0.5 opacity-60" />
                              </Badge>
                            </a>
                            {p.key === "youtube" && ytVideoId && (
                              <button
                                className="inline-flex items-center justify-center w-5 h-5 rounded hover:bg-muted transition-colors"
                                title="Сменить превью на YouTube"
                                disabled={ytThumbUploading}
                                onClick={() => ytThumbInputRef.current?.click()}
                                data-testid={`btn-yt-thumbnail-${clip.id}`}
                              >
                                {ytThumbUploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <ImageIcon className="w-3 h-3 opacity-60" />}
                              </button>
                            )}
                            <input
                              ref={ytThumbInputRef}
                              type="file"
                              accept="image/jpeg,image/png,image/webp"
                              className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file && ytVideoId) handleYtThumbnailUpload(file, ytVideoId);
                              }}
                            />
                          </span>
                        );
                      }
                      return (
                        <Badge
                          key={p.key}
                          variant={isPublished ? "secondary" : "outline"}
                          className={`text-[10px] gap-1${!isPublished ? " opacity-30" : ""}${isPublished && onUnpublish ? " cursor-pointer" : ""}`}
                          data-testid={`badge-published-${p.key}-${clip.id}`}
                          onClick={isPublished && onUnpublish ? () => {
                            if (confirm(`Сбросить статус публикации ${p.label}?`)) {
                              onUnpublish(clipExport.id, p.key);
                            }
                          } : undefined}
                          title={isPublished ? "Клик — сбросить статус" : undefined}
                        >
                          <Icon className={p.iconClass} />{p.label}
                          {isPublished && <Check className="w-2 h-2 ml-0.5 opacity-60" />}
                        </Badge>
                      );
                    })}
                    {pmpPubTracking && (() => {
                      const platformIcons: Record<string, { icon: any; cls: string }> = {
                        youtube: { icon: SiYoutube, cls: "w-2.5 h-2.5 text-red-500" },
                        vk: { icon: SiVk, cls: "w-2.5 h-2.5 text-blue-500" },
                        tiktok: { icon: SiTiktok, cls: "w-2.5 h-2.5" },
                        instagram: { icon: SiInstagram, cls: "w-2.5 h-2.5 text-pink-500" },
                        facebook: { icon: SiFacebook, cls: "w-2.5 h-2.5 text-blue-600" },
                      };
                      return Object.entries(pmpPubTracking)
                        .filter(([key, v]) => key.startsWith(clipExport.id) && v.polling)
                        .map(([key, v]) => {
                          const pi = platformIcons[v.platform] || { icon: SiVk, cls: "w-2.5 h-2.5" };
                          const PIcon = pi.icon;
                          return (
                            <Badge key={key} variant="outline" className="text-[10px] gap-1 animate-pulse" data-testid={`badge-pmp-status-${v.platform}-${clip.id}`}>
                              <PIcon className={pi.cls} />{v.status}
                            </Badge>
                          );
                        });
                    })()}
                  </div>
                );
              })()}
              {clipExport.cleanOutputPath && (
                <a
                  href={`/api/files/clean-export/${clipExport.id}`}
                  download
                  title="Скачать чистый клип (без фильтров и субтитров)"
                  className="inline-flex items-center"
                  data-testid={`btn-clean-download-${clip.id}`}
                >
                  <Badge variant="outline" className="text-[10px] gap-1 cursor-pointer hover:bg-muted">
                    <Download className="w-2.5 h-2.5" />Clean
                  </Badge>
                </a>
              )}
            </div>
          )}

          {clipExportSquare && clipExportSquare.status === "processing" && (
            <div className="flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span className="text-xs text-muted-foreground">1:1 {clipExportSquare.progress || 0}%</span>
            </div>
          )}

          {clipExportSquare && clipExportSquare.status === "completed" && (
            <div className="flex items-center gap-1 flex-wrap">
              <Button
                variant={activePanelExportId === clipExportSquare.id ? "secondary" : "outline"}
                size="sm"
                onClick={() => onShowInPanel(clipExportSquare, "1:1", clip.title || `${formatTime(clip.startTime)} - ${formatTime(clip.endTime)}`)}
                data-testid={`button-preview-square-${clip.id}`}
              >
                <Film className="w-3 h-3 mr-1" />
                {activePanelExportId === clipExportSquare.id ? "Показано" : "1:1"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  const url = `/api/exports/${clipExportSquare.id}/download`;
                  const defaultName = (clip.title || `poker_square_${clip.id}`).replace(/[^a-zA-Zа-яА-ЯёЁ0-9_-]/g, "_") + "_1x1.mp4";
                  try {
                    if ("showSaveFilePicker" in window) {
                      const handle = await (window as any).showSaveFilePicker({
                        suggestedName: defaultName,
                        types: [{ description: "MP4 Video", accept: { "video/mp4": [".mp4"] } }],
                      });
                      const res = await fetch(url);
                      const blob = await res.blob();
                      const writable = await handle.createWritable();
                      await writable.write(blob);
                      await writable.close();
                    } else {
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = defaultName;
                      a.click();
                    }
                  } catch (e: any) {
                    if (e?.name !== "AbortError") {
                      window.open(url, "_blank");
                    }
                  }
                }}
                data-testid={`button-download-square-${clip.id}`}
              >
                <Download className="w-3 h-3 mr-1" />Скачать 1:1
              </Button>
              {youtubeConnected && onYoutubeUpload && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={youtubeUploading}
                  onClick={() => {
                    setYtExportId(clipExportSquare.id);
                    setYtTitle(clip.title || `${formatTime(clip.startTime)}`);
                    setYtDescription("");
                    setYtDialogOpen(true);
                  }}
                  data-testid={`button-youtube-square-${clip.id}`}
                >
                  {youtubeUploading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <SiYoutube className="w-3 h-3 mr-1 text-red-500" />}
                  YouTube 1:1
                </Button>
              )}
            </div>
          )}

          {clipExportSquare && clipExportSquare.status === "error" && (
            <div className="flex items-center gap-1">
              <Badge variant="destructive" className="text-xs">Ошибка 1:1</Badge>
              {onRetryExport && (
                <Button variant="ghost" size="sm" onClick={() => onRetryExport(clipExportSquare.id)} data-testid={`button-retry-square-${clip.id}`}>
                  <RotateCcw className="w-3 h-3 mr-1" />Повторить
                </Button>
              )}
            </div>
          )}

          {clipExport && clipExport.status === "error" && (
            <div className="flex items-center gap-1">
              <Badge variant="destructive" className="text-xs">Ошибка</Badge>
              {onRetryExport && (
                <Button variant="ghost" size="sm" onClick={() => onRetryExport(clipExport.id)} data-testid={`button-retry-export-${clip.id}`}>
                  <RotateCcw className="w-3 h-3 mr-1" />Повторить
                </Button>
              )}
            </div>
          )}
          {clipPreviewExport && clipPreviewExport.status === "error" && (
            <div className="flex items-center gap-1">
              <Badge variant="destructive" className="text-xs">Ошибка превью</Badge>
              {onRetryExport && (
                <Button variant="ghost" size="sm" onClick={() => onRetryExport(clipPreviewExport.id)} data-testid={`button-retry-preview-${clip.id}`}>
                  <RotateCcw className="w-3 h-3 mr-1" />Повторить
                </Button>
              )}
            </div>
          )}
        </div>

        {expanded && (
          <div className="mt-4 space-y-4 border-t pt-4">
            <div>
              <p className="text-xs text-muted-foreground mb-2">Подрезка клипа</p>
              <div className="px-2">
                <Slider
                  min={Math.max(0, clip.startTime - 15)}
                  max={Math.min(video.duration || clip.endTime + 15, clip.endTime + 15)}
                  step={0.5}
                  value={trimRange}
                  onValueChange={(val) => setTrimRange(val as [number, number])}
                  data-testid={`slider-trim-${clip.id}`}
                />
              </div>
              <div className="flex justify-between mt-1">
                <span className="text-xs text-muted-foreground font-mono">{formatTimeFull(trimRange[0])}</span>
                <span className="text-xs font-mono">{Math.round(trimRange[1] - trimRange[0])}с</span>
                <span className="text-xs text-muted-foreground font-mono">{formatTimeFull(trimRange[1])}</span>
              </div>
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-2">Сигналы</p>
              <div className="grid grid-cols-2 gap-2">
                {Object.entries(clip.signals as Record<string, number>).map(([key, value]) => (
                  <div key={key} className="flex justify-between text-xs">
                    <span className="text-muted-foreground">{key}</span>
                    <span className="font-mono">{typeof value === "number" ? value.toFixed(2) : value}</span>
                  </div>
                ))}
              </div>
            </div>

          </div>
        )}

      </CardContent>

      <Dialog open={ytDialogOpen} onOpenChange={setYtDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Загрузка на YouTube</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="yt-title">Название видео (необязательно)</Label>
              <Input
                id="yt-title"
                data-testid="input-youtube-title"
                value={ytTitle}
                onChange={(e) => setYtTitle(e.target.value)}
                placeholder={ytWithTags ? "Название + хештеги" : "Название видео"}
              />
              <p className="text-xs text-muted-foreground">
                Итого: {ytTitle.trim() ? ytTitle.trim() : ""}{ytWithTags && pokerTags.youtube ? (ytTitle.trim() ? " " : "") + pokerTags.youtube : ""}
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="yt-description">Описание видео</Label>
              <Textarea
                id="yt-description"
                data-testid="input-youtube-description"
                value={ytDescription}
                onChange={(e) => setYtDescription(e.target.value)}
                placeholder="Описание (необязательно)"
                rows={3}
              />
              {ytWithTags && (
                <p className="text-xs text-muted-foreground">
                  К описанию будет добавлено: {pokerTags.youtube}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="yt-tags"
                data-testid="checkbox-youtube-tags"
                checked={ytWithTags}
                onCheckedChange={(checked) => setYtWithTags(!!checked)}
              />
              <Label htmlFor="yt-tags" className="text-sm cursor-pointer">{isPoker ? `Добавить хештеги (${pokerTags.youtube})` : "Добавить хештеги"}</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setYtDialogOpen(false)} data-testid="button-youtube-cancel">
              Отмена
            </Button>
            <Button
              disabled={youtubeUploading}
              data-testid="button-youtube-confirm"
              onClick={() => {
                const tags = pokerTags.youtube;
                let finalTitle = ytTitle.trim();
                let finalDescription = ytDescription.trim();
                if (ytWithTags && tags) {
                  finalTitle = finalTitle ? finalTitle + " " + tags : tags;
                  finalDescription = finalDescription ? finalDescription + "\n\n" + tags : tags;
                }
                onYoutubeUpload?.(ytExportId, finalTitle, finalDescription);
                setYtDialogOpen(false);
              }}
            >
              {youtubeUploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <SiYoutube className="w-4 h-4 mr-2 text-red-500" />}
              Загрузить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={socialDialogOpen} onOpenChange={setSocialDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Загрузка в {socialPlatform === "vk" ? "VK" : socialPlatform === "tiktok" ? "TikTok" : socialPlatform === "facebook" ? "Facebook" : socialPlatform === "threads" ? "Threads" : "Instagram"}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            {socialPlatform === "vk" && socialStatuses?.vk?.connected && (
              <div className="text-xs text-muted-foreground" data-testid="text-vk-target">
                {socialStatuses.vk.groupId
                  ? `Публикация в группу: ${socialStatuses.vk.groupName || socialStatuses.vk.groupId}`
                  : "Публикация на личную страницу"}
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Label>Название (необязательно)</Label>
              <Input
                data-testid="input-social-title"
                value={socialTitle}
                onChange={(e) => setSocialTitle(e.target.value)}
                placeholder="Только хештеги, если оставить пустым"
              />
              {(socialPlatform === "instagram" || socialPlatform === "tiktok" || socialPlatform === "facebook" || socialPlatform === "threads" || socialPlatform === "vk") && socialWithTags && (
                <p className="text-xs text-muted-foreground" data-testid="text-social-title-preview">
                  Итого: {socialTitle.trim() ? socialTitle.trim() + " " : ""}
                  {pokerTags[socialPlatform] || ""}
                </p>
              )}
            </div>
            {(socialPlatform === "tiktok" || socialPlatform === "instagram" || socialPlatform === "facebook" || socialPlatform === "threads" || socialPlatform === "vk") && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="social-tags"
                  checked={socialWithTags}
                  onCheckedChange={(v) => setSocialWithTags(v === true)}
                  data-testid="checkbox-social-tags"
                />
                <Label htmlFor="social-tags" className="text-sm cursor-pointer">
                  {isPoker ? `Добавить хештеги (${pokerTags[socialPlatform] || ""})` : "Добавить хештеги"}
                </Label>
              </div>
            )}
            {socialPlatform === "tiktok" && (
              <div className="flex flex-col gap-2">
                <Label>Свои хештеги для TikTok</Label>
                <Input
                  data-testid="input-social-tiktok-custom-tags"
                  value={socialTiktokCustomTags}
                  onChange={(e) => setSocialTiktokCustomTags(e.target.value)}
                  placeholder="#хештег1 #хештег2"
                />
                <p className="text-xs text-muted-foreground">
                  Будут добавлены к названию{socialWithTags ? " после стандартных хештегов" : ""}
                </p>
              </div>
            )}
            {socialPlatform !== "tiktok" && (
              <div className="flex flex-col gap-2">
                <Label>Описание</Label>
                <Textarea
                  data-testid="input-social-description"
                  value={socialDescription}
                  onChange={(e) => setSocialDescription(e.target.value)}
                  placeholder="Описание (необязательно)"
                  rows={3}
                />
                {(socialPlatform === "instagram" || socialPlatform === "vk" || socialPlatform === "facebook" || socialPlatform === "threads") && socialWithTags && (
                  <p className="text-xs text-muted-foreground" data-testid="text-social-tags-hint">
                    К описанию будет добавлено: {pokerTags[socialPlatform] || ""}
                  </p>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSocialDialogOpen(false)} data-testid="button-social-cancel">
              Отмена
            </Button>
            <Button
              disabled={!!socialUploading}
              data-testid="button-social-confirm"
              onClick={() => {
                let finalTitle = socialTitle.trim();
                let finalDescription = socialDescription.trim();
                if (socialWithTags) {
                  const tags = pokerTags[socialPlatform] || "";
                  if (tags) {
                    finalTitle = finalTitle ? finalTitle + " " + tags : tags;
                    if (socialPlatform !== "tiktok") {
                      finalDescription = finalDescription ? finalDescription + "\n\n" + tags : tags;
                    }
                  }
                }
                if (socialPlatform === "tiktok" && socialTiktokCustomTags.trim()) {
                  finalTitle = finalTitle + " " + socialTiktokCustomTags.trim();
                }
                onSocialUpload?.(socialPlatform, socialExportId, finalTitle, finalDescription);
                setSocialDialogOpen(false);
              }}
            >
              {socialUploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : (
                socialPlatform === "youtube" ? <SiYoutube className="w-4 h-4 mr-2 text-red-500" /> :
                socialPlatform === "vk" ? <SiVk className="w-4 h-4 mr-2 text-blue-500" /> :
                socialPlatform === "tiktok" ? <SiTiktok className="w-4 h-4 mr-2" /> :
                socialPlatform === "facebook" ? <SiFacebook className="w-4 h-4 mr-2 text-blue-600" /> :
                socialPlatform === "threads" ? <SiThreads className="w-4 h-4 mr-2" /> :
                <SiInstagram className="w-4 h-4 mr-2 text-pink-500" />
              )}
              Загрузить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkDialogOpen} onOpenChange={setBulkDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Загрузка во все соцсети
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            {clipExport?.thumbnailPath && (
              <div className="flex flex-col gap-1">
                <Label className="text-xs text-muted-foreground">Превью (thumbnail):</Label>
                <div className="relative rounded-lg overflow-hidden border max-w-[200px]">
                  <img
                    src={`/api/files/export-thumbnail/${clipExport.id}`}
                    alt="Превью клипа"
                    className="w-full"
                    data-testid={`img-bulk-thumbnail-${clip.id}`}
                  />
                </div>
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Label className="text-xs text-muted-foreground">Подключённые платформы:</Label>
              <div className="flex items-center gap-1 flex-wrap">
                {youtubeConnected && <Badge variant="secondary" className="text-xs gap-1"><SiYoutube className="w-3 h-3 text-red-500" />YouTube</Badge>}
                {socialStatuses?.vk?.connected && <Badge variant="secondary" className="text-xs gap-1"><SiVk className="w-3 h-3 text-blue-500" />VK</Badge>}
                {socialStatuses?.tiktok?.connected && <Badge variant="secondary" className="text-xs gap-1"><SiTiktok className="w-3 h-3" />TikTok</Badge>}
                {socialStatuses?.instagram?.connected && <Badge variant="secondary" className="text-xs gap-1"><SiInstagram className="w-3 h-3 text-pink-500" />Instagram</Badge>}
                {socialStatuses?.facebook?.connected && <Badge variant="secondary" className="text-xs gap-1"><SiFacebook className="w-3 h-3 text-blue-600" />Facebook</Badge>}
                {socialStatuses?.threads?.connected && <Badge variant="secondary" className="text-xs gap-1"><SiThreads className="w-3 h-3" />Threads</Badge>}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label>Название</Label>
              <Input
                data-testid="input-bulk-title"
                value={bulkTitle}
                onChange={(e) => setBulkTitle(e.target.value)}
                placeholder="Название для всех платформ"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label className="text-sm">Хештеги для каждой платформы</Label>
              <div className="flex flex-col gap-1.5">
                {[
                  { key: "youtube", label: "YouTube", tags: pokerTags.youtube, icon: <SiYoutube className="w-3 h-3 text-red-500" />, connected: youtubeConnected },
                  { key: "tiktok", label: "TikTok", tags: pokerTags.tiktok, icon: <SiTiktok className="w-3 h-3" />, connected: socialStatuses?.tiktok?.connected },
                  { key: "instagram", label: "Instagram", tags: pokerTags.instagram, icon: <SiInstagram className="w-3 h-3 text-pink-500" />, connected: socialStatuses?.instagram?.connected },
                  { key: "facebook", label: "Facebook", tags: pokerTags.facebook, icon: <SiFacebook className="w-3 h-3 text-blue-600" />, connected: socialStatuses?.facebook?.connected },
                  { key: "threads", label: "Threads", tags: pokerTags.threads, icon: <SiThreads className="w-3 h-3" />, connected: socialStatuses?.threads?.connected },
                  { key: "vk", label: "VK", tags: pokerTags.vk, icon: <SiVk className="w-3 h-3 text-blue-500" />, connected: socialStatuses?.vk?.connected },
                ].filter(p => p.connected).map(p => (
                  <div key={p.key} className="flex items-center gap-2">
                    <Checkbox
                      id={`bulk-tags-${p.key}`}
                      checked={bulkHashtagPlatforms[p.key] ?? true}
                      onCheckedChange={(v) => {
                        const next = { ...bulkHashtagPlatforms, [p.key]: v === true };
                        setBulkHashtagPlatforms(next);
                        try { localStorage.setItem("bulkHashtagPlatforms", JSON.stringify(next)); } catch {}
                      }}
                      data-testid={`checkbox-bulk-tags-${p.key}`}
                    />
                    <Label htmlFor={`bulk-tags-${p.key}`} className="text-xs cursor-pointer flex items-center gap-1.5 flex-wrap">
                      {p.icon} {p.label}
                      <span className="text-muted-foreground">{p.tags}</span>
                    </Label>
                  </div>
                ))}
              </div>
            </div>
            {socialStatuses?.tiktok?.connected && (
              <div className="flex flex-col gap-2">
                <Label className="text-sm flex items-center gap-1.5">
                  <SiTiktok className="w-3 h-3" /> Свои хештеги для TikTok
                </Label>
                <Input
                  data-testid="input-bulk-tiktok-custom-tags"
                  value={bulkTiktokCustomTags}
                  onChange={(e) => setBulkTiktokCustomTags(e.target.value)}
                  placeholder="#хештег1 #хештег2"
                />
                <p className="text-xs text-muted-foreground">
                  Будут добавлены к названию только для TikTok
                </p>
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Label>Описание</Label>
              <Textarea
                data-testid="input-bulk-description"
                value={bulkDescription}
                onChange={(e) => setBulkDescription(e.target.value)}
                placeholder="Описание (необязательно)"
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDialogOpen(false)} data-testid="button-bulk-cancel">
              Отмена
            </Button>
            <Button
              disabled={!!bulkUploading}
              data-testid="button-bulk-confirm"
              onClick={() => {
                const finalTitle = bulkTitle.trim();
                const finalDescription = bulkDescription.trim();
                onBulkUpload?.(bulkExportId, finalTitle, finalDescription, bulkHashtagPlatforms, bulkTiktokCustomTags.trim());
                setBulkDialogOpen(false);
              }}
            >
              {bulkUploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Share2 className="w-4 h-4 mr-2" />}
              Загрузить во все
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={thumbDialogOpen} onOpenChange={(open) => { setThumbDialogOpen(open); if (!open) { if (thumbUrl) { URL.revokeObjectURL(thumbUrl); setThumbUrl(null); } } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Обложка клипа</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-sm">Текст на обложке</Label>
              <Textarea
                value={thumbText}
                onChange={(e) => setThumbText(e.target.value)}
                placeholder="Крупный кликбейтный текст..."
                rows={2}
                className="mt-1"
                data-testid="input-thumb-text"
              />
              <p className="text-xs text-muted-foreground mt-1">Оставьте пустым для обложки без текста</p>
            </div>

            {thumbUrl && (
              <div className="relative rounded-lg overflow-hidden border">
                <img src={thumbUrl} alt="Превью обложки" className="w-full" data-testid="img-thumb-preview" />
              </div>
            )}

            <div className="flex gap-2">
              <Button
                className="flex-1"
                disabled={thumbLoading}
                onClick={async () => {
                  setThumbLoading(true);
                  try {
                    const start = clip.adjustedStartTime ?? clip.startTime;
                    const end = clip.adjustedEndTime ?? clip.endTime;
                    const res = await fetch(`/api/videos/${video.id}/clip-thumbnail`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        startTime: start,
                        endTime: end,
                        calibration: selectedProfile?.calibration,
                        contentType: video.contentType,
                        text: thumbText.trim() || undefined,
                      }),
                    });
                    if (!res.ok) throw new Error(await res.text());
                    const blob = await res.blob();
                    if (thumbUrl) URL.revokeObjectURL(thumbUrl);
                    setThumbUrl(URL.createObjectURL(blob));
                  } catch (err: any) {
                    toast({ title: "Ошибка генерации", description: err.message, variant: "destructive" });
                  } finally {
                    setThumbLoading(false);
                  }
                }}
                data-testid="button-generate-thumb"
              >
                {thumbLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ImageIcon className="w-4 h-4 mr-2" />}
                Сгенерировать
              </Button>
              {thumbUrl && (
                <Button
                  variant="outline"
                  onClick={() => {
                    const a = document.createElement("a");
                    a.href = thumbUrl;
                    a.download = `thumbnail_${clip.id}.jpg`;
                    a.click();
                  }}
                  data-testid="button-download-thumb"
                >
                  <Download className="w-4 h-4 mr-2" />Скачать
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function DeletedClipsList({ videoId, onRestored }: { videoId: string; onRestored: () => void }) {
  const { data: deletedClips = [], isLoading } = useQuery<SuggestedClip[]>({
    queryKey: ["/api/clips/deleted", { videoId }],
    queryFn: async () => {
      const res = await fetch(`/api/clips/deleted?videoId=${videoId}`);
      return res.json();
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async (clipId: string) => {
      await apiRequest("POST", `/api/clips/${clipId}/restore`);
    },
    onSuccess: () => {
      onRestored();
    },
  });

  if (isLoading) return <div className="text-center py-4 text-muted-foreground text-sm">Загрузка...</div>;
  if (deletedClips.length === 0) return <div className="text-center py-4 text-muted-foreground text-sm">Корзина пуста</div>;

  return (
    <div className="space-y-2">
      {deletedClips.map((clip) => (
        <div key={clip.id} className="flex items-center justify-between gap-2 p-2 rounded-md border" data-testid={`deleted-clip-${clip.id}`}>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{clip.title || `${formatTime(clip.startTime)} – ${formatTime(clip.endTime)}`}</div>
            <div className="text-xs text-muted-foreground">
              {formatTime(clip.startTime)} – {formatTime(clip.endTime)} · {Math.round(clip.endTime - clip.startTime)}с
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => restoreMutation.mutate(clip.id)}
            disabled={restoreMutation.isPending}
            data-testid={`button-restore-clip-${clip.id}`}
          >
            <RotateCcw className="w-3 h-3 mr-1" />
            Вернуть
          </Button>
        </div>
      ))}
    </div>
  );
}

export default function VideoDetail({ videoId }: VideoDetailProps) {
  const [,] = useLocation();
  const { toast } = useToast();
  const [showTranscript, setShowTranscript] = useState(false);
  const [calibrationOpen, setCalibrationOpen] = useState(false);
  const [calibrationFrameTime, setCalibrationFrameTime] = useState<number | undefined>(undefined);
  const [calibrationClipId, setCalibrationClipId] = useState<string | undefined>(undefined);
  const [selectedProfileId, setSelectedProfileId] = useState<string>(() => {
    try { return localStorage.getItem(`profileId_${videoId}`) || ""; } catch { return ""; }
  });
  
  const [previewClip, setPreviewClip] = useState<SuggestedClip | null>(null);
  const [viewedClipIds, setViewedClipIds] = useState<Set<string>>(new Set());
  const [clipInTime, setClipInTime] = useState<number | null>(null);
  const [clipOutTime, setClipOutTime] = useState<number | null>(null);
  const [playerCurrentTime, setPlayerCurrentTime] = useState(0);
  const mainVideoElRef = useRef<HTMLVideoElement | null>(null);
  const [manualTitle, setManualTitle] = useState("");
  const [rightPanelExport, setRightPanelExport] = useState<{ exportJob: ExportJob; label: string; clipTitle?: string } | null>(null);
  const rightPanelStreamTs = useRef<number>(0);
  const [calibPreview, setCalibPreview] = useState<{
    frameUrl: string;
    table: { x: number; y: number; width: number; height: number };
    webcam: { x: number; y: number; width: number; height: number };
    sourceWidth: number;
    sourceHeight: number;
  } | null>(null);
  const [calibPreviewLoading, setCalibPreviewLoading] = useState(false);
  const [calibPreviewTime, setCalibPreviewTime] = useState("10");
  const [useAiCalibration, setUseAiCalibration] = useState(false);
  const [aspectRatio, setAspectRatio] = useState<"9:16" | "1:1">("9:16");
  const [muteAudio, setMuteAudio] = useState(false);
  const [bleepProfanity, setBleepProfanity] = useState(false);
  const [enableDynamicCamera, setEnableDynamicCamera] = useState(() => {
    try {
      const stored = localStorage.getItem("enableDynamicCamera");
      return stored !== null ? stored === "true" : true; // default ON for streamer
    } catch { return true; }
  });
  const [cameraMode, setCameraMode] = useState<"auto" | "smooth" | "cuts">(() => {
    try { const v = localStorage.getItem("cameraMode"); return (v === "auto" || v === "smooth" || v === "cuts") ? v : "auto"; } catch { return "auto"; }
  });
  const [uniqualize, setUniqualize] = useState(() => {
    try { const v = localStorage.getItem("uniqualize"); return v === null ? true : v === "true"; } catch { return true; }
  });
  const [filterPreset, setFilterPreset] = useState<"subtle" | "medium" | "strong">(() => {
    try { const v = localStorage.getItem("filterPreset"); return (v === "subtle" || v === "medium" || v === "strong") ? v : "medium"; } catch { return "medium"; }
  });
  const [videoFilter, setVideoFilter] = useState<string>(() => {
    try { return localStorage.getItem("videoFilter") || "none"; } catch { return "none"; }
  });
  const [resolution, setResolution] = useState<"1080p" | "4k">(() => {
    try { return localStorage.getItem("exportResolution") === "4k" ? "4k" : "1080p"; } catch { return "1080p"; }
  });
  const [useCrawlCaption, setUseCrawlCaption] = useState(() => {
    try { return localStorage.getItem("useCrawlCaption") === "true"; } catch { return false; }
  });
  const [bgAudioFilename, setBgAudioFilename] = useState<string>(() => {
    try { return localStorage.getItem("bgAudioFilename") || ""; } catch { return ""; }
  });
  const [bgAudioVolume, setBgAudioVolume] = useState<number>(() => {
    try { const v = localStorage.getItem("bgAudioVolume"); return v ? parseFloat(v) : 0.3; } catch { return 0.3; }
  });
  const [musicDropEnabled, setMusicDropEnabled] = useState(() => {
    try { return localStorage.getItem("musicDropEnabled") === "true"; } catch { return false; }
  });
  const [musicDropVolumeBefore, setMusicDropVolumeBefore] = useState<number>(() => {
    try { const v = localStorage.getItem("musicDropVolumeBefore"); return v ? parseFloat(v) : 0.15; } catch { return 0.15; }
  });
  const [musicStartOffset, setMusicStartOffset] = useState<number>(() => {
    try { const v = localStorage.getItem("musicStartOffset"); return v ? parseFloat(v) : 0; } catch { return 0; }
  });
  const [voiceVolume, setVoiceVolume] = useState<number>(() => {
    try { const v = localStorage.getItem("voiceVolume"); return v ? parseFloat(v) : 1.4; } catch { return 1.4; }
  });
  const [captionPositionY, setCaptionPositionY] = useState<number>(() => {
    try { const v = localStorage.getItem("captionPositionY"); return v ? parseFloat(v) : 82; } catch { return 82; }
  });
  const [subtitleOffsetMs, setSubtitleOffsetMs] = useState<number>(() => {
    try { const v = localStorage.getItem("subtitleOffsetMs"); return v ? parseInt(v) : 0; } catch { return 0; }
  });
  const [captionStyle, setCaptionStyle] = useState<"classic" | "mrbeast" | "glow">(() => {
    try { return (localStorage.getItem("captionStyle") as "classic" | "mrbeast" | "glow") || "classic"; } catch { return "classic"; }
  });
  const [renderEngine, setRenderEngine] = useState<"vps" | "runpod">(() => {
    try { return (localStorage.getItem("renderEngine") as "vps" | "runpod") || "vps"; } catch { return "vps"; }
  });
  const [autoCutMaxClips, setAutoCutMaxClips] = useState<number>(() => {
    try { return parseInt(localStorage.getItem("autoCutMaxClips") || "1", 10) || 1; } catch { return 1; }
  });
  const podStatusQuery = useQuery<{ id: string; name: string; status: string; uptimeSeconds: number; gpu: string }>({
    queryKey: ["/api/pod/status"],
    refetchInterval: renderEngine === "runpod" ? 10000 : false,
    enabled: renderEngine === "runpod",
  });
  const [showSoundsManager, setShowSoundsManager] = useState(false);
  const [favoriteSounds, setFavoriteSounds] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem("favoriteSounds");
      const parsed = stored ? JSON.parse(stored) : [];
      if (parsed.length === 0) {
        const defaults = ["Mellstroy BGM.mp3", "MATADORA Extended.mp3"];
        localStorage.setItem("favoriteSounds", JSON.stringify(defaults));
        return defaults;
      }
      return parsed;
    } catch { return ["Mellstroy BGM.mp3", "MATADORA Extended.mp3"]; }
  });
  const toggleFavorite = (filename: string) => {
    setFavoriteSounds(prev => {
      const next = prev.includes(filename) ? prev.filter(f => f !== filename) : [...prev, filename];
      try { localStorage.setItem("favoriteSounds", JSON.stringify(next)); } catch {}
      return next;
    });
  };
  const [autoPublish, setAutoPublish] = useState(() => {
    try { return localStorage.getItem("autoPublish") === "true"; } catch { return false; }
  });
  const [autoPublishPlatforms, setAutoPublishPlatforms] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem("autoPublishPlatforms");
      if (saved) return JSON.parse(saved);
    } catch {}
    return { youtube: true, vk: true, tiktok: true, instagram: true, facebook: true, threads: true };
  });
  const autoPublishQueueRef = useRef<Set<string>>(new Set(
    (() => { try { const s = localStorage.getItem("autoPublishQueue"); if (s) return JSON.parse(s); } catch {} return []; })()
  ));
  const syncAutoPublishQueue = useCallback(() => {
    try { localStorage.setItem("autoPublishQueue", JSON.stringify([...autoPublishQueueRef.current])); } catch {}
  }, []);
  useEffect(() => { try { localStorage.setItem("autoPublish", String(autoPublish)); } catch {} }, [autoPublish]);
  useEffect(() => { try { localStorage.setItem("autoPublishPlatforms", JSON.stringify(autoPublishPlatforms)); } catch {} }, [autoPublishPlatforms]);
  const autoSaveDirRef = useRef<any>(null);
  const [autoSaveDirName, setAutoSaveDirName] = useState<string | null>(null);
  const knownExportsRef = useRef<Set<string>>(new Set());
  const autoSaveReadyRef = useRef(false);
  const [autoSaveInitDone, setAutoSaveInitDone] = useState(false);

  const saveAutoSaveHandle = useCallback(async (handle: any | null) => {
    try {
      const dbReq = indexedDB.open("autosave_db", 1);
      dbReq.onupgradeneeded = () => { dbReq.result.createObjectStore("handles"); };
      dbReq.onsuccess = () => {
        const tx = dbReq.result.transaction("handles", "readwrite");
        const store = tx.objectStore("handles");
        if (handle) {
          store.put(handle, "dirHandle");
        } else {
          store.delete("dirHandle");
        }
      };
    } catch {}
  }, []);

  useEffect(() => {
    if (!("showDirectoryPicker" in window)) {
      setAutoSaveInitDone(true);
      return;
    }
    (async () => {
      try {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open("autosave_db", 1);
          req.onupgradeneeded = () => { req.result.createObjectStore("handles"); };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        const tx = db.transaction("handles", "readonly");
        const store = tx.objectStore("handles");
        const handle = await new Promise<any>((resolve) => {
          const req = store.get("dirHandle");
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        });
        db.close();
        if (handle) {
          const perm = await handle.queryPermission({ mode: "readwrite" });
          if (perm === "granted") {
            autoSaveDirRef.current = handle;
            setAutoSaveDirName(handle.name);
          } else {
            const requested = await handle.requestPermission({ mode: "readwrite" });
            if (requested === "granted") {
              autoSaveDirRef.current = handle;
              setAutoSaveDirName(handle.name);
            }
          }
        }
      } catch {}
      setAutoSaveInitDone(true);
    })();
  }, []);

  const { data: video, isLoading: videoLoading } = useQuery<Video>({
    queryKey: ["/api/videos", videoId],
    queryFn: async () => {
      const res = await fetch(`/api/videos/${videoId}`);
      if (!res.ok) throw new Error("Failed to fetch video");
      return res.json();
    },
    refetchInterval: (query) => {
      const v = query.state.data;
      return v && v.status === "processing" ? 2000 : false;
    },
  });

  const { data: streamInfo } = useQuery<{ type: string; url: string; token?: string }>({
    queryKey: ["/api/videos", videoId, "stream-url"],
    queryFn: async () => {
      const res = await fetch(`/api/videos/${videoId}/stream-url`);
      if (!res.ok) throw new Error("Failed to get stream url");
      return res.json();
    },
    enabled: !!video,
    staleTime: 1000 * 60 * 30,
  });

  const videoSrc = useMemo(() => {
    if (streamInfo?.type === "vps" && streamInfo.url && streamInfo.token) {
      return `${streamInfo.url}?token=${encodeURIComponent(streamInfo.token)}`;
    }
    return `/api/videos/${videoId}/stream`;
  }, [streamInfo, videoId]);

  const prevVideoStatus = useRef<string | undefined>(undefined);
  
  useEffect(() => {
    if (prevVideoStatus.current === "processing" && video?.status === "analyzed") {
      queryClient.invalidateQueries({ queryKey: ["/api/clips", { videoId }] });
    }
    prevVideoStatus.current = video?.status;
  }, [video?.status, videoId]);

  const isPoker = video?.contentType !== "streamer";
  const pokerTags: Record<string, string> = isPoker ? {
    youtube: "#покер #покерок #покерок_shorts @POKEROK_Life",
    instagram: "#покер #покерок #покерок_shorts @pokerok_official",
    vk: "#покер #покерок #покерок_shorts",
    tiktok: "#покерок #покерок_shorts",
    facebook: "#покер #покерок #покерок_shorts",
    threads: "#покер #покерок #покерок_shorts",
  } : {
    youtube: "",
    instagram: "",
    vk: "",
    tiktok: "",
    facebook: "",
    threads: "",
  };

  const { data: clips = [] } = useQuery<SuggestedClip[]>({
    queryKey: ["/api/clips", { videoId }],
    queryFn: async () => {
      const res = await fetch(`/api/clips?videoId=${videoId}`);
      if (!res.ok) throw new Error("Failed to fetch clips");
      return res.json();
    },
    enabled: !!video && video.status === "analyzed",
  });

  const { data: exports = [] } = useQuery<ExportJob[]>({
    queryKey: ["/api/exports", { videoId }],
    queryFn: async () => {
      const res = await fetch(`/api/exports?videoId=${videoId}`);
      if (!res.ok) throw new Error("Failed to fetch exports");
      return res.json();
    },
    enabled: !!video,
    refetchInterval: (query) => {
      const exps = query.state.data;
      return exps && exps.some((e: any) => e.status === "processing" || e.status === "queued") ? 2000 : false;
    },
  });

  const { data: autoCuts = [] } = useQuery<any[]>({
    queryKey: ["/api/auto-cuts/video", videoId],
    queryFn: async () => {
      const res = await fetch(`/api/auto-cuts/video/${videoId}`);
      if (!res.ok) throw new Error("Failed to fetch auto-cuts");
      return res.json();
    },
    enabled: !!video,
    refetchInterval: (query) => {
      const cuts = query.state.data;
      return cuts && cuts.some((c: any) => c.status === "processing" || c.status === "queued") ? 3000 : false;
    },
  });

  useEffect(() => {
    if (rightPanelExport) {
      const updated = exports.find((e) => e.id === rightPanelExport.exportJob.id);
      if (updated && (updated.outputPath !== rightPanelExport.exportJob.outputPath || updated.status !== rightPanelExport.exportJob.status)) {
        rightPanelStreamTs.current = Date.now();
        setRightPanelExport({ ...rightPanelExport, exportJob: updated });
      }
    }
  }, [exports]);

  useEffect(() => {
    if (!autoSaveInitDone) return;
    const completedFinal = exports.filter((e) => e.status === "completed" && !e.isPreview);
    if (!autoSaveReadyRef.current) {
      for (const exp of completedFinal) {
        knownExportsRef.current.add(exp.id);
      }
      if (autoSaveDirRef.current) {
        autoSaveReadyRef.current = true;
      }
      return;
    }
    const dirHandle = autoSaveDirRef.current;
    if (!dirHandle) return;
    for (const exp of completedFinal) {
      if (knownExportsRef.current.has(exp.id)) continue;
      knownExportsRef.current.add(exp.id);
      const clip = clips.find((c) => c.id === exp.clipId);
      const fileName = (clip?.title || `poker_short_${exp.clipId}`).replace(/[^a-zA-Zа-яА-ЯёЁ0-9_-]/g, "_") + ".mp4";
      (async () => {
        try {
          const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
          const writable = await fileHandle.createWritable();
          const res = await fetch(`/api/exports/${exp.id}/download`);
          const blob = await res.blob();
          await writable.write(blob);
          await writable.close();
          toast({ title: "Автосохранение", description: `${fileName} сохранён в папку` });
        } catch (err: any) {
          if (err?.name !== "AbortError") {
            toast({ title: "Ошибка сохранения", description: err.message, variant: "destructive" });
          }
        }
      })();
    }
  }, [exports, clips, toast, autoSaveDirName, autoSaveInitDone]);

  const { data: profiles = [] } = useQuery<StreamerProfile[]>({
    queryKey: ["/api/profiles"],
    queryFn: async () => {
      const res = await fetch("/api/profiles");
      if (!res.ok) throw new Error("Failed to fetch profiles");
      return res.json();
    },
  });

  useEffect(() => {
    if (selectedProfileId) return;
    const saved = (() => { try { return localStorage.getItem(`profileId_${videoId}`); } catch { return null; } })();
    if (saved && profiles.some(p => p.id === saved)) {
      setSelectedProfileId(saved);
      return;
    }
    if (video?.profileId) {
      setSelectedProfileId(video.profileId);
      try { localStorage.setItem(`profileId_${videoId}`, video.profileId); } catch {}
    } else if (profiles.length > 0) {
      setSelectedProfileId(profiles[0].id);
      try { localStorage.setItem(`profileId_${videoId}`, profiles[0].id); } catch {}
    }
  }, [video?.profileId, selectedProfileId, profiles, videoId]);

  const processMutation = useMutation({
    mutationFn: async (opts?: { transcribeOnly?: boolean }) => {
      await apiRequest("POST", `/api/videos/${videoId}/process`, { transcribeOnly: opts?.transcribeOnly });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/videos", videoId] });
      queryClient.invalidateQueries({ queryKey: ["/api/clips"] });
      toast({ title: "Обработка запущена" });
    },
    onError: (err: Error) => {
      toast({ title: "Ошибка запуска", description: err.message, variant: "destructive" });
    },
  });

  const reanalyzeMutation = useMutation({
    mutationFn: async (mode: "highlights" | "all" = "highlights") => {
      await apiRequest("POST", `/api/videos/${videoId}/reanalyze`, { mode });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/videos", videoId] });
      queryClient.invalidateQueries({ queryKey: ["/api/clips"] });
      toast({ title: "Переанализ запущен" });
    },
    onError: (err: Error) => {
      toast({ title: "Ошибка переанализа", description: err.message, variant: "destructive" });
    },
  });

  const rewhisperMutation = useMutation({
    mutationFn: async (opts: { mode: "highlights" | "all"; transcribeOnly?: boolean }) => {
      await apiRequest("POST", `/api/videos/${videoId}/rewhisper`, { mode: opts.mode, transcribeOnly: opts.transcribeOnly });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/videos", videoId] });
      queryClient.invalidateQueries({ queryKey: ["/api/clips"] });
      toast({ title: "Перетранскрибация запущена" });
    },
    onError: (err: Error) => {
      toast({ title: "Ошибка перетранскрибации", description: err.message, variant: "destructive" });
    },
  });


  const updateProfileMutation = useMutation({
    mutationFn: async (profileId: string) => {
      await apiRequest("PATCH", `/api/videos/${videoId}`, { profileId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/videos", videoId] });
    },
    onError: (err: any) => {
      if (video?.profileId) setSelectedProfileId(video.profileId);
      toast({ title: "Ошибка сохранения профиля", description: err.message, variant: "destructive" });
    },
  });

  const cancelPipelineMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/videos/${videoId}/cancel`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/videos", videoId] });
    },
  });

  const approveMutation = useMutation({
    mutationFn: async ({ clipId, startTime, endTime }: { clipId: string; startTime: number; endTime: number }) => {
      await apiRequest("PATCH", `/api/clips/${clipId}`, {
        status: "approved",
        adjustedStartTime: startTime,
        adjustedEndTime: endTime,
      });
      if (autoPublish && selectedProfileId) {
        const clipForDrop = clips?.find((c: any) => c.id === clipId);
        const autoDropTime = musicDropEnabled && clipForDrop?.dropTime != null ? clipForDrop.dropTime : undefined;
        const exportRes = await apiRequest("POST", `/api/clips/${clipId}/export`, {
          profileId: selectedProfileId,
          subtitlesEnabled: false,
          useAiCalibration,
          aspectRatio,
          muteAudio,
          bleepProfanity,
          uniqualize,
          filterPreset,
          videoFilter: videoFilter !== "none" ? videoFilter : undefined,
          resolution,
          bgAudioFilename: bgAudioFilename || undefined,
          bgAudioVolume: bgAudioFilename ? bgAudioVolume : undefined,
          musicStartOffset: bgAudioFilename && musicStartOffset > 0 ? musicStartOffset : undefined,
          voiceVolume: bgAudioFilename ? voiceVolume : undefined,
          musicDropTime: autoDropTime,
          musicDropVolumeBefore: autoDropTime != null ? musicDropVolumeBefore : undefined,
          captionPositionY,
          subtitleOffsetMs: subtitleOffsetMs || undefined,
          captionStyle: captionStyle !== "classic" ? captionStyle : undefined,
          renderEngine: renderEngine !== "vps" ? renderEngine : undefined,
          enableDynamicCamera: enableDynamicCamera && video?.contentType === "streamer",
          cameraMode: enableDynamicCamera && video?.contentType === "streamer" ? cameraMode : undefined,
          isPreview: false,
        });
        const exportData = await exportRes.json();
        if (exportData?.id) {
          autoPublishQueueRef.current.add(exportData.id);
          syncAutoPublishQueue();
        }
      }
      return { clipId };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clips", { videoId }] });
      queryClient.invalidateQueries({ queryKey: ["/api/exports", { videoId }] });
    },
  });

  const saveTimeMutation = useMutation({
    mutationFn: async ({ clipId, startTime, endTime }: { clipId: string; startTime: number; endTime: number }) => {
      await apiRequest("PATCH", `/api/clips/${clipId}`, {
        adjustedStartTime: startTime,
        adjustedEndTime: endTime,
      });
      return clipId;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clips", { videoId }] });
      toast({ title: "Время клипа обновлено" });
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clips", { videoId }] });
      toast({ title: "Ошибка сохранения времени", variant: "destructive" });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async (clipId: string) => {
      await apiRequest("PATCH", `/api/clips/${clipId}`, { status: "rejected" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clips", { videoId }] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (clipId: string) => {
      await apiRequest("DELETE", `/api/clips/${clipId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clips", { videoId }] });
    },
  });

  const exportMutation = useMutation({
    mutationFn: async ({ clipId, isPreview, overrideStartTime, overrideEndTime }: { clipId: string; isPreview?: boolean; overrideStartTime?: number; overrideEndTime?: number }) => {
      const clipData = clips?.find((c: any) => c.id === clipId);
      const dropTimeVal = musicDropEnabled && clipData?.dropTime != null ? clipData.dropTime : undefined;
      await apiRequest("POST", `/api/clips/${clipId}/export`, {
        profileId: selectedProfileId,
        subtitlesEnabled: false,
        captionEnabled: useCrawlCaption,
        useAiCalibration,
        aspectRatio,
        muteAudio,
        bleepProfanity,
        uniqualize,
        filterPreset,
        videoFilter: videoFilter !== "none" ? videoFilter : undefined,
        resolution,
        bgAudioFilename: bgAudioFilename || undefined,
        bgAudioVolume: bgAudioFilename ? bgAudioVolume : undefined,
        musicStartOffset: bgAudioFilename && musicStartOffset > 0 ? musicStartOffset : undefined,
        voiceVolume: bgAudioFilename ? voiceVolume : undefined,
        musicDropTime: dropTimeVal,
        musicDropVolumeBefore: dropTimeVal != null ? musicDropVolumeBefore : undefined,
        captionPositionY,
        subtitleOffsetMs: subtitleOffsetMs || undefined,
        captionStyle: captionStyle !== "classic" ? captionStyle : undefined,
        renderEngine: renderEngine !== "vps" ? renderEngine : undefined,
        enableDynamicCamera: enableDynamicCamera && video?.contentType === "streamer",
        cameraMode: enableDynamicCamera && video?.contentType === "streamer" ? cameraMode : undefined,
        isPreview,
        overrideStartTime,
        overrideEndTime,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/exports", { videoId }] });
    },
    onError: (err: any) => {
      toast({ title: "Ошибка экспорта", description: err.message || "Неизвестная ошибка", variant: "destructive" });
    },
  });

  const exportAllMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/clips/export-all", {
        videoId,
        profileId: selectedProfileId,
        subtitlesEnabled: false,
        captionEnabled: useCrawlCaption,
        useAiCalibration,
        aspectRatio,
        muteAudio,
        bleepProfanity,
        uniqualize,
        filterPreset,
        videoFilter: videoFilter !== "none" ? videoFilter : undefined,
        resolution,
        bgAudioFilename: bgAudioFilename || undefined,
        bgAudioVolume: bgAudioFilename ? bgAudioVolume : undefined,
        musicStartOffset: bgAudioFilename && musicStartOffset > 0 ? musicStartOffset : undefined,
        voiceVolume: bgAudioFilename ? voiceVolume : undefined,
        musicDropVolumeBefore: musicDropEnabled ? musicDropVolumeBefore : undefined,
        captionPositionY,
        subtitleOffsetMs: subtitleOffsetMs || undefined,
        captionStyle: captionStyle !== "classic" ? captionStyle : undefined,
        renderEngine: renderEngine !== "vps" ? renderEngine : undefined,
        enableDynamicCamera: enableDynamicCamera && video?.contentType === "streamer",
        cameraMode: enableDynamicCamera && video?.contentType === "streamer" ? cameraMode : undefined,
      });
      const data = await res.json();
      return data;
    },
    onSuccess: (data: { jobs: { id: number }[]; count: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/exports", { videoId }] });
      if (autoPublish && data?.jobs) {
        for (const job of data.jobs) {
          autoPublishQueueRef.current.add(job.id);
        }
        syncAutoPublishQueue();
      }
    },
  });

  const autoCutMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/videos/${videoId}/auto-cut`, {
        profileId: selectedProfileId,
        captionStyle: captionStyle !== "classic" ? captionStyle : "mrbeast",
        captionPositionY,
        voiceVolume,
        bleepProfanity,
        bgAudioFilename,
        bgAudioVolume,
        enableDynamicCamera: enableDynamicCamera && video?.contentType === "streamer",
        cameraMode,
        maxClips: autoCutMaxClips,
        minExcitement: 6,
      });
      return await res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/auto-cuts/video", videoId] });
      toast({ title: "AI Авто-нарезка", description: `Запущено рендеров: ${data.total}` });
    },
    onError: (err: any) => {
      toast({ title: "Ошибка авто-нарезки", description: err.message, variant: "destructive" });
    },
  });

  const stopAutoCutMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/videos/${videoId}/auto-cut/stop`);
      return await res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/auto-cuts/video", videoId] });
      toast({ title: "AI нарезка остановлена", description: `Отменено: ${data.cancelled ?? 0}` });
    },
    onError: (err: any) => {
      toast({ title: "Ошибка", description: err.message, variant: "destructive" });
    },
  });

  const deleteAllAutoCutsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", `/api/auto-cuts/video/${videoId}`);
      return await res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/auto-cuts/video", videoId] });
      toast({ title: "AI клипы удалены", description: `Удалено: ${data.deleted}` });
    },
    onError: (err: any) => {
      toast({ title: "Ошибка удаления", description: err.message, variant: "destructive" });
    },
  });

  const [reRenderingCutId, setReRenderingCutId] = useState<string | null>(null);
  const reRenderAutoCutMutation = useMutation({
    mutationFn: async (cutId: string) => {
      setReRenderingCutId(cutId);
      const resetRes = await apiRequest("POST", `/api/auto-cuts/${cutId}/rerender`);
      const resetData = await resetRes.json();
      if (!resetRes.ok) throw new Error(resetData.message || "Ошибка сброса клипа");
      const res = await apiRequest("POST", `/api/videos/${videoId}/auto-cut`, {
        profileId: selectedProfileId,
        captionStyle: captionStyle !== "classic" ? captionStyle : "mrbeast",
        captionPositionY,
        voiceVolume,
        bleepProfanity,
        bgAudioFilename,
        bgAudioVolume,
        enableDynamicCamera: enableDynamicCamera && video?.contentType === "streamer",
        cameraMode,
        maxClips: 1,
        minExcitement: 0,
      });
      return await res.json();
    },
    onSuccess: () => {
      setReRenderingCutId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/auto-cuts/video", videoId] });
      toast({ title: "Перерендер запущен" });
    },
    onError: (err: any) => {
      setReRenderingCutId(null);
      toast({ title: "Ошибка перерендера", description: err.message, variant: "destructive" });
    },
  });

  const retryExportMutation = useMutation({
    mutationFn: async (exportId: string) => {
      await apiRequest("POST", `/api/exports/${exportId}/retry`, {
        aspectRatio,
        muteAudio,
        bleepProfanity,
        subtitlesEnabled: useCrawlCaption,
        bgAudioFilename: bgAudioFilename || undefined,
        bgAudioVolume: bgAudioFilename ? bgAudioVolume : undefined,
        musicStartOffset: bgAudioFilename && musicStartOffset > 0 ? musicStartOffset : undefined,
        voiceVolume: bgAudioFilename ? voiceVolume : undefined,
        musicDropVolumeBefore: musicDropEnabled ? musicDropVolumeBefore : undefined,
        captionPositionY,
        subtitleOffsetMs: subtitleOffsetMs || undefined,
        captionStyle: captionStyle !== "classic" ? captionStyle : undefined,
        renderEngine: renderEngine !== "vps" ? renderEngine : undefined,
        uniqualize,
        filterPreset,
        videoFilter: videoFilter !== "none" ? videoFilter : undefined,
        resolution,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/exports", { videoId }] });
      toast({ title: "Экспорт перезапущен" });
    },
    onError: (err: Error) => {
      toast({ title: "Ошибка перезапуска", description: err.message, variant: "destructive" });
    },
  });

  const { data: soundsData, refetch: refetchSounds } = useQuery<{ sounds: Array<{ id: string; filename: string; sizeBytes: number; createdAt: number }> }>({
    queryKey: ["/api/sounds"],
    staleTime: 30000,
  });


  const uploadSoundMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/sounds/upload", { method: "POST", body: formData });
      if (!res.ok) throw new Error((await res.json()).message || "Upload failed");
      return res.json();
    },
    onSuccess: () => {
      refetchSounds();
      toast({ title: "Звук загружен" });
    },
    onError: (err: Error) => {
      toast({ title: "Ошибка загрузки звука", description: err.message, variant: "destructive" });
    },
  });

  const deleteSoundMutation = useMutation({
    mutationFn: async (soundId: string) => {
      const res = await fetch(`/api/sounds/${soundId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
    },
    onSuccess: (_data, soundId) => {
      refetchSounds();
      if (bgAudioFilename && soundsData?.sounds.find(s => s.id === soundId)?.filename === bgAudioFilename) {
        setBgAudioFilename("");
        try { localStorage.setItem("bgAudioFilename", ""); } catch {}
      }
      toast({ title: "Звук удалён" });
    },
  });

  const [downloadSoundUrl, setDownloadSoundUrl] = useState("");
  const [playingSound, setPlayingSound] = useState<string | null>(null);
  const soundAudioRef = useRef<HTMLAudioElement | null>(null);

  const toggleSoundPreview = useCallback((filename: string, forcePlay?: boolean) => {
    if (playingSound === filename && !forcePlay) {
      soundAudioRef.current?.pause();
      setPlayingSound(null);
      return;
    }
    if (soundAudioRef.current) {
      soundAudioRef.current.pause();
    }
    const audio = new Audio(`/api/sounds/file/${encodeURIComponent(filename)}`);
    audio.volume = bgAudioVolume;
    audio.onended = () => setPlayingSound(null);
    audio.onerror = () => setPlayingSound(null);
    audio.play();
    soundAudioRef.current = audio;
    setPlayingSound(filename);
  }, [playingSound, bgAudioVolume]);

  useEffect(() => {
    if (soundAudioRef.current) {
      soundAudioRef.current.volume = bgAudioVolume;
    }
  }, [bgAudioVolume]);

  const downloadSoundMutation = useMutation({
    mutationFn: async (url: string) => {
      const res = await fetch("/api/sounds/download-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) throw new Error((await res.json()).message || "Download failed");
      return res.json();
    },
    onSuccess: (data) => {
      refetchSounds();
      setDownloadSoundUrl("");
      toast({ title: "Аудио скачано", description: data.filename });
    },
    onError: (err: Error) => {
      toast({ title: "Ошибка скачивания", description: err.message, variant: "destructive" });
    },
  });

  const { data: publishedToday } = useQuery<{ total: number; byPlatform: Record<string, number> }>({
    queryKey: ["/api/exports/published-today"],
  });

  const findClipIdByExportId = useCallback((exportId: string) => {
    const exp = exports.find(e => e.id === exportId);
    return exp?.clipId || null;
  }, [exports]);

  const youtubeUploadMutation = useMutation({
    mutationFn: async ({ exportId, title, description }: { exportId: string; title: string; description: string }) => {
      setUploadingClipId(findClipIdByExportId(exportId));
      const res = await apiRequest("POST", `/api/youtube/upload/${exportId}`, { title, description });
      return res.json();
    },
    onSuccess: (data: { videoId: string; url: string }) => {
      setUploadingClipId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/exports", { videoId }] });
      queryClient.invalidateQueries({ queryKey: ["/api/exports/published-today"] });
      toast({
        title: "Загружено на YouTube",
        description: `Видео загружено. ${data.url}`,
      });
    },
    onError: (err: Error) => {
      setUploadingClipId(null);
      toast({
        title: "Ошибка загрузки",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const { data: profileSocialStatus } = useQuery<{
    configured: boolean;
    platforms: Record<string, { connected: boolean; accountName?: string | null; method?: string }>;
  }>({
    queryKey: ["/api/profiles", selectedProfileId, "social-status"],
    enabled: !!selectedProfileId,
  });

  const socialStatuses: Record<string, { connected: boolean; accountName?: string | null; [key: string]: any }> = profileSocialStatus?.configured
    ? {
        youtube: profileSocialStatus.platforms.youtube || { connected: false },
        vk: profileSocialStatus.platforms.vk || { connected: false },
        tiktok: profileSocialStatus.platforms.tiktok || { connected: false },
        instagram: profileSocialStatus.platforms.instagram || { connected: false },
        facebook: profileSocialStatus.platforms.facebook || { connected: false },
        threads: profileSocialStatus.platforms.threads || { connected: false },
      }
    : {
        youtube: { connected: false },
        vk: { connected: false },
        tiktok: { connected: false },
        instagram: { connected: false },
        facebook: { connected: false },
        threads: { connected: false },
      };

  const youtubeStatus = socialStatuses.youtube;

  const publishExportToSocials = useCallback(async (exportId: string | number, clipTitle: string, clipId?: string) => {
    const names: Record<string, string> = { youtube: "YouTube", vk: "VK", tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook", threads: "Threads" };
    const platforms: string[] = [];
    if (autoPublishPlatforms.youtube && socialStatuses.youtube?.connected) platforms.push("youtube");
    if (autoPublishPlatforms.vk && socialStatuses.vk?.connected) platforms.push("vk");
    if (autoPublishPlatforms.tiktok && socialStatuses.tiktok?.connected) platforms.push("tiktok");
    if (autoPublishPlatforms.instagram && socialStatuses.instagram?.connected) platforms.push("instagram");
    if (autoPublishPlatforms.facebook && socialStatuses.facebook?.connected) platforms.push("facebook");
    if (autoPublishPlatforms.threads && socialStatuses.threads?.connected) platforms.push("threads");
    if (platforms.length === 0) return;
    if (clipId) {
      setAutoPublishingClipIds(prev => { const s = new Set(prev); s.add(clipId); return s; });
    }
    try {
      const results: { platform: string; ok: boolean }[] = [];
      for (const platform of platforms) {
        try {
          const tags = pokerTags[platform] || "";
          const platformTitle = tags ? clipTitle + " " + tags : clipTitle;
          if (platform === "youtube") {
            await apiRequest("POST", `/api/youtube/upload/${exportId}`, { title: platformTitle, description: "" });
          } else {
            await apiRequest("POST", `/api/social/${platform}/upload/${exportId}`, { title: platformTitle, description: "" });
          }
          results.push({ platform, ok: true });
        } catch {
          results.push({ platform, ok: false });
        }
      }
      queryClient.invalidateQueries({ queryKey: ["/api/exports", { videoId }] });
      queryClient.invalidateQueries({ queryKey: ["/api/exports/published-today"] });
      const succeeded = results.filter(r => r.ok).map(r => names[r.platform]).join(", ");
      const failed = results.filter(r => !r.ok).map(r => names[r.platform]).join(", ");
      if (succeeded) toast({ title: "Автопубликация", description: `${clipTitle}: ${succeeded}` });
      if (failed) toast({ title: "Ошибка автопубликации", description: `Не удалось: ${failed}`, variant: "destructive" });
    } finally {
      if (clipId) {
        setAutoPublishingClipIds(prev => { const s = new Set(prev); s.delete(clipId); return s; });
      }
    }
  }, [autoPublishPlatforms, youtubeStatus, socialStatuses, videoId, toast]);

  const autoPublishDoneRef = useRef<Set<string | number>>(new Set());
  const autoPublishingNowRef = useRef<Set<string | number>>(new Set());

  useEffect(() => {
    if (!autoPublish) return;
    const queue = autoPublishQueueRef.current;
    for (const exportId of Array.from(queue)) {
      const exp = exports.find((e) => e.id === exportId);
      if (!exp) continue;
      if (exp.status === "completed" || exp.status === "error") {
        queue.delete(exportId);
        syncAutoPublishQueue();
        if (exp.status === "error") {
          toast({ title: "Ошибка экспорта", description: `Экспорт для автопубликации не удался`, variant: "destructive" });
        }
      }
    }

    const approvedClipIds = new Set(clips.filter(c => c.status === "approved").map(c => c.id));
    for (const exp of exports) {
      if (
        exp.status === "completed" &&
        !exp.isPreview &&
        approvedClipIds.has(exp.clipId) &&
        !(exp.publishedTo && exp.publishedTo.length > 0) &&
        !autoPublishingNowRef.current.has(exp.id) &&
        !autoPublishDoneRef.current.has(exp.id)
      ) {
        autoPublishingNowRef.current.add(exp.id);
        autoPublishDoneRef.current.add(exp.id);
        const clip = clips.find(c => c.id === exp.clipId);
        publishExportToSocials(exp.id, clip?.title || "Poker Short", exp.clipId).finally(() => {
          autoPublishingNowRef.current.delete(exp.id);
        });
      }
    }
  }, [exports, clips, autoPublish, autoPublishPlatforms, youtubeStatus, socialStatuses, videoId, toast, syncAutoPublishQueue, publishExportToSocials]);

  const [autoPublishingClipIds, setAutoPublishingClipIds] = useState<Set<string>>(new Set());
  const [socialUploadingPlatform, setSocialUploadingPlatform] = useState<string | null>(null);
  const [uploadingClipId, setUploadingClipId] = useState<string | null>(null);
  const [showDeletedClips, setShowDeletedClips] = useState(false);
  const [acUploadingCutId, setAcUploadingCutId] = useState<string | null>(null);
  const [acUploadingPlatform, setAcUploadingPlatform] = useState<string | null>(null);
  const [acBulkUploadingCutId, setAcBulkUploadingCutId] = useState<string | null>(null);
  const [acSocialDialogOpen, setAcSocialDialogOpen] = useState(false);
  const [acSocialPlatform, setAcSocialPlatform] = useState("");
  const [acSocialTitle, setAcSocialTitle] = useState("");
  const [acSocialDescription, setAcSocialDescription] = useState("");
  const [acSocialCutId, setAcSocialCutId] = useState("");
  const [acSocialWithTags, setAcSocialWithTags] = useState(true);
  const [acSocialTiktokCustomTags, setAcSocialTiktokCustomTags] = useState("");
  const [acBulkDialogOpen, setAcBulkDialogOpen] = useState(false);
  const [acBulkTitle, setAcBulkTitle] = useState("");
  const [acBulkDescription, setAcBulkDescription] = useState("");
  const [acBulkCutId, setAcBulkCutId] = useState("");
  const [acBulkHashtagPlatforms, setAcBulkHashtagPlatforms] = useState<Record<string, boolean>>({ youtube: true, tiktok: true, instagram: true, facebook: true, threads: true, vk: true });
  const [acBulkTiktokCustomTags, setAcBulkTiktokCustomTags] = useState("");
  const [showCookiePasteDialog, setShowCookiePasteDialog] = useState(false);
  const [cookiePasteText, setCookiePasteText] = useState("");
  const [cookiePasting, setCookiePasting] = useState(false);
  const [showVkTokenDialog, setShowVkTokenDialog] = useState(false);
  const [vkTokenUrl, setVkTokenUrl] = useState("");
  const [pmpPubTracking, setPmpPubTracking] = useState<Record<string, { publicationId: number; platform: string; status: string; polling: boolean }>>({});

  useEffect(() => {
    const pollingEntries = Object.entries(pmpPubTracking).filter(([, v]) => v.polling);
    if (pollingEntries.length === 0) return;
    let cancelled = false;
    const poll = async () => {
      for (const [trackKey, entry] of pollingEntries) {
        try {
          const res = await fetch(`/api/social/postmypost/publication-status/${entry.publicationId}`);
          if (!res.ok || cancelled) continue;
          const data = await res.json();
          if (cancelled) return;
          const platformNames: Record<string, string> = { youtube: "YouTube", vk: "VK Clips", tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook" };
          const pName = platformNames[entry.platform] || entry.platform;
          setPmpPubTracking(prev => ({
            ...prev,
            [trackKey]: {
              ...prev[trackKey],
              status: data.statusLabel,
              polling: !data.published && !data.error,
            },
          }));
          if (data.published) {
            toast({ title: pName, description: `Видео опубликовано в ${pName}!` });
          } else if (data.error) {
            toast({ title: pName, description: `Ошибка: ${data.statusLabel}`, variant: "destructive" });
          }
        } catch {}
      }
    };
    poll();
    const interval = setInterval(poll, 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [JSON.stringify(Object.entries(pmpPubTracking).filter(([, v]) => v.polling).map(([k]) => k))]);

  const socialUploadMutation = useMutation({
    mutationFn: async ({ platform, exportId, title, description }: { platform: string; exportId: string; title: string; description: string }) => {
      setSocialUploadingPlatform(platform);
      setUploadingClipId(findClipIdByExportId(exportId));
      const url = platform === "youtube"
        ? `/api/youtube/upload/${exportId}`
        : `/api/social/${platform}/upload/${exportId}`;
      const res = await apiRequest("POST", url, { title, description });
      return { platform, exportId, data: await res.json() };
    },
    onSuccess: ({ platform, exportId, data }) => {
      setSocialUploadingPlatform(null);
      setUploadingClipId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/exports", { videoId }] });
      queryClient.invalidateQueries({ queryKey: ["/api/exports/published-today"] });
      const names: Record<string, string> = { youtube: "YouTube", vk: "VK", tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook", threads: "Threads" };
      const pubId = data.publicationId || (platform === "vk" && data.videoId ? parseInt(data.videoId, 10) : null);
      if (data.method === "postmypost" && pubId) {
        const trackKey = `${exportId}_${platform}`;
        setPmpPubTracking(prev => ({
          ...prev,
          [trackKey]: { publicationId: pubId, platform, status: "Ожидает публикации", polling: true },
        }));
        toast({
          title: names[platform] || platform,
          description: data.message || "Видео отправлено, отслеживаем статус...",
        });
      } else {
        toast({
          title: `Загружено в ${names[platform] || platform}`,
          description: data.url || data.message || "Загрузка завершена",
        });
      }
    },
    onError: (err: Error) => {
      setSocialUploadingPlatform(null);
      setUploadingClipId(null);
      toast({
        title: "Ошибка загрузки",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const [clipListTab, setClipListTab] = useState<"clips" | "autocuts">("clips");

  const autoCutSocialUploadMutation = useMutation({
    mutationFn: async ({ platform, cutId, title, description }: { platform: string; cutId: string; title: string; description: string }) => {
      setAcUploadingCutId(cutId);
      setAcUploadingPlatform(platform);
      const res = await apiRequest("POST", `/api/auto-cuts/${cutId}/publish/${platform}`, { title, description });
      return { platform, cutId, data: await res.json() };
    },
    onSuccess: ({ platform, cutId, data }) => {
      setAcUploadingCutId(null);
      setAcUploadingPlatform(null);
      queryClient.invalidateQueries({ queryKey: ["/api/auto-cuts/video", videoId] });
      queryClient.invalidateQueries({ queryKey: ["/api/exports/published-today"] });
      const names: Record<string, string> = { youtube: "YouTube", vk: "VK", tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook", threads: "Threads" };
      const pubId = data.publicationId || (platform === "vk" && data.videoId ? parseInt(data.videoId, 10) : null);
      if (data.method === "postmypost" && pubId) {
        const trackKey = `ac_${cutId}_${platform}`;
        setPmpPubTracking(prev => ({
          ...prev,
          [trackKey]: { publicationId: pubId, platform, status: "Ожидает публикации", polling: true },
        }));
        toast({
          title: names[platform] || platform,
          description: data.message || "Видео отправлено, отслеживаем статус...",
        });
      } else {
        toast({
          title: `Загружено в ${names[platform] || platform}`,
          description: data.url || data.message || "Загрузка завершена",
        });
      }
    },
    onError: (err: Error) => {
      setAcUploadingCutId(null);
      setAcUploadingPlatform(null);
      toast({
        title: "Ошибка загрузки",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const handleAutoCutBulkUpload = useCallback(async (cutId: string, title: string, description: string, hashtagPlatforms?: Record<string, boolean>, tiktokCustomTags?: string) => {
    setAcBulkUploadingCutId(cutId);
    try {
      const platforms: string[] = [];
      if (socialStatuses.youtube?.connected) platforms.push("youtube");
      if (socialStatuses.vk?.connected) platforms.push("vk");
      if (socialStatuses.tiktok?.connected) platforms.push("tiktok");
      if (socialStatuses.instagram?.connected) platforms.push("instagram");
      if (socialStatuses.facebook?.connected) platforms.push("facebook");
      if (socialStatuses.threads?.connected) platforms.push("threads");

      const names: Record<string, string> = { youtube: "YouTube", vk: "VK", tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook", threads: "Threads" };

      const uploadOne = async (platform: string): Promise<{ platform: string; ok: boolean; error?: string }> => {
        try {
          const addTags = hashtagPlatforms?.[platform] ?? false;
          let platformTitle = title;
          let platformDescription = description;
          const tags = pokerTags[platform] || "";
          if (addTags && tags) {
            platformTitle = platformTitle ? platformTitle + " " + tags : tags;
            if (platform !== "tiktok") {
              platformDescription = platformDescription ? platformDescription + "\n\n" + tags : tags;
            }
          }
          if (platform === "tiktok" && tiktokCustomTags) {
            platformTitle = platformTitle + " " + tiktokCustomTags;
          }
          const uploadRes = await apiRequest("POST", `/api/auto-cuts/${cutId}/publish/${platform}`, { title: platformTitle, description: platformDescription });
          try {
            const uploadData = await uploadRes.json();
            const pubId = uploadData.publicationId || (platform === "vk" && uploadData.videoId ? parseInt(uploadData.videoId, 10) : null);
            if (uploadData.method === "postmypost" && pubId) {
              const trackKey = `ac_${cutId}_${platform}`;
              setPmpPubTracking(prev => ({
                ...prev,
                [trackKey]: { publicationId: pubId, platform, status: "Ожидает публикации", polling: true },
              }));
            }
          } catch {}
          return { platform, ok: true };
        } catch (err: any) {
          return { platform, ok: false, error: err.message };
        }
      };

      const settled = await Promise.allSettled(platforms.map(p => uploadOne(p)));
      const results = settled.map(s => s.status === "fulfilled" ? s.value : { platform: "unknown", ok: false, error: "unexpected" });
      const ok = results.filter(r => r.ok);
      const fail = results.filter(r => !r.ok);
      queryClient.invalidateQueries({ queryKey: ["/api/auto-cuts/video", videoId] });
      queryClient.invalidateQueries({ queryKey: ["/api/exports/published-today"] });
      if (ok.length > 0) toast({ title: `Загружено в ${ok.map(r => names[r.platform] || r.platform).join(", ")}` });
      if (fail.length > 0) toast({ title: "Ошибки", description: fail.map(r => `${names[r.platform] || r.platform}: ${r.error}`).join("\n"), variant: "destructive" });
    } finally {
      setAcBulkUploadingCutId(null);
    }
  }, [socialStatuses, videoId]);

  const [bulkUploadingState, setBulkUploadingState] = useState(false);
  const handleBulkUpload = useCallback(async (exportId: string, title: string, description: string, hashtagPlatforms?: Record<string, boolean>, tiktokCustomTags?: string) => {
    setBulkUploadingState(true);
    setUploadingClipId(findClipIdByExportId(exportId));
    try {
      const platforms: string[] = [];
      if (socialStatuses.youtube?.connected) platforms.push("youtube");
      if (socialStatuses.vk?.connected) platforms.push("vk");
      if (socialStatuses.tiktok?.connected) platforms.push("tiktok");
      if (socialStatuses.instagram?.connected) platforms.push("instagram");
      if (socialStatuses.facebook?.connected) platforms.push("facebook");
      if (socialStatuses.threads?.connected) platforms.push("threads");

      const names: Record<string, string> = { youtube: "YouTube", vk: "VK", tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook", threads: "Threads" };

      const uploadOne = async (platform: string): Promise<{ platform: string; ok: boolean; error?: string }> => {
        try {
          const addTags = hashtagPlatforms?.[platform] ?? false;
          let platformTitle = title;
          let platformDescription = description;
          const tags = pokerTags[platform] || "";
          if (addTags && tags) {
            platformTitle = platformTitle ? platformTitle + " " + tags : tags;
            if (platform !== "tiktok") {
              platformDescription = platformDescription ? platformDescription + "\n\n" + tags : tags;
            }
          }
          if (platform === "tiktok" && tiktokCustomTags) {
            platformTitle = platformTitle + " " + tiktokCustomTags;
          }
          if (platform === "youtube") {
            await apiRequest("POST", `/api/youtube/upload/${exportId}`, { title: platformTitle, description: platformDescription });
          } else {
            const uploadRes = await apiRequest("POST", `/api/social/${platform}/upload/${exportId}`, { title: platformTitle, description: platformDescription });
            try {
              const uploadData = await uploadRes.json();
              const pubId = uploadData.publicationId || (platform === "vk" && uploadData.videoId ? parseInt(uploadData.videoId, 10) : null);
              if (uploadData.method === "postmypost" && pubId) {
                const trackKey = `${exportId}_${platform}`;
                setPmpPubTracking(prev => ({
                  ...prev,
                  [trackKey]: { publicationId: pubId, platform, status: "Ожидает публикации", polling: true },
                }));
              }
            } catch {}
          }
          return { platform, ok: true };
        } catch (err: any) {
          return { platform, ok: false, error: err.message };
        }
      };

      const settled = await Promise.allSettled(platforms.map(p => uploadOne(p)));
      const results = settled.map(s => s.status === "fulfilled" ? s.value : { platform: "unknown", ok: false, error: "unexpected" });

      queryClient.invalidateQueries({ queryKey: ["/api/exports", { videoId }] });
      queryClient.invalidateQueries({ queryKey: ["/api/exports/published-today"] });

      const succeeded = results.filter(r => r.ok).map(r => names[r.platform]).join(", ");
      const failed = results.filter(r => !r.ok).map(r => names[r.platform]).join(", ");

      if (succeeded) {
        toast({ title: "Загружено", description: `Успешно: ${succeeded}` });
      }
      if (failed) {
        toast({ title: "Ошибки загрузки", description: `Не удалось: ${failed}`, variant: "destructive" });
      }
    } finally {
      setBulkUploadingState(false);
      setUploadingClipId(null);
    }
  }, [youtubeStatus, socialStatuses, videoId, toast, findClipIdByExportId]);

  const handleUnpublish = useCallback(async (exportId: string, platform: string) => {
    try {
      await apiRequest("POST", `/api/exports/${exportId}/unpublish/${platform}`);
      queryClient.invalidateQueries({ queryKey: ["/api/exports", { videoId }] });
      queryClient.invalidateQueries({ queryKey: ["/api/exports/published-today"] });
      toast({ title: "Сброшено", description: `Статус ${platform} сброшен` });
    } catch (err: any) {
      toast({ title: "Ошибка", description: err.message, variant: "destructive" });
    }
  }, [videoId, toast]);

  const createClipMutation = useMutation({
    mutationFn: async ({ startTime, endTime, title }: { startTime: number; endTime: number; title?: string }) => {
      const res = await apiRequest("POST", "/api/clips", {
        videoId,
        startTime,
        endTime,
        title: title || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clips", { videoId }] });
      setClipInTime(null);
      setClipOutTime(null);
      setManualTitle("");
      toast({ title: "Клип создан" });
    },
    onError: (error: Error) => {
      toast({ title: "Ошибка", description: error.message, variant: "destructive" });
    },
  });

  const runCalibPreview = async (timeStr: string) => {
    setCalibPreviewLoading(true);
    try {
      const t = parseFloat(timeStr) || clipInTime || 10;
      const ct = video?.contentType || "poker";
      const res = await apiRequest("POST", `/api/videos/${videoId}/auto-calibrate?t=${t}&profileId=${selectedProfileId}&contentType=${ct}`);
      const data = await res.json();
      setCalibPreview({
        frameUrl: `/api/videos/${videoId}/frame?t=${t}&_=${Date.now()}`,
        table: data.table,
        webcam: data.webcam,
        sourceWidth: data.sourceWidth,
        sourceHeight: data.sourceHeight,
      });
    } catch (err: any) {
      console.error("Calibration preview error:", err);
    } finally {
      setCalibPreviewLoading(false);
    }
  };

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId);
  const isVideoProcessing = video?.status === "processing";
  const transcriptSegments = (isVideoProcessing ? [] : (video?.transcriptionSegments || [])) as TranscriptSegment[];
  const hasSegments = transcriptSegments.length > 0;
  const totalWords = transcriptSegments.reduce((n, s) => n + (s.words?.length || 0), 0);
  const alignedWords = transcriptSegments.reduce((n, s) => n + (s.words?.filter((w: any) => w.start != null).length || 0), 0);

  if (videoLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!video) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-muted-foreground">Видео не найдено</p>
      </div>
    );
  }

  const isProcessing = video.status === "processing";
  const isReady = video.status === "analyzed";
  const needsProcessing = video.status === "uploaded" || video.status === "queued";
  const approvedClips = clips.filter((c) => c.status === "approved");
  const approvedWithoutExport = approvedClips.filter(
    (c) => !exports.some((e) => e.clipId === c.id && (e.status === "processing" || e.status === "queued"))
  );

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-auto p-2 space-y-2 min-w-[200px] border-r" data-testid="col-video">

          {videoSrc && video.filepath !== "pending" && (
            <ClipTimelinePlayer
              videoSrc={videoSrc}
              duration={video.duration || 0}
              inTime={clipInTime}
              outTime={clipOutTime}
              sourceWidth={video.width}
              sourceHeight={video.height}
              onInChange={setClipInTime}
              onOutChange={setClipOutTime}
              onCreateClip={isReady ? () => {
                if (clipInTime !== null && clipOutTime !== null) {
                  createClipMutation.mutate({ startTime: clipInTime, endTime: clipOutTime, title: manualTitle || undefined });
                }
              } : undefined}
              isCreating={createClipMutation.isPending}
              clipTitle={manualTitle}
              onClipTitleChange={setManualTitle}
              onTimeUpdate={setPlayerCurrentTime}
              videoElRef={mainVideoElRef}
            />
          )}

          {isProcessing && (
            <div className="flex items-center gap-3 p-3">
              <Loader2 className="w-4 h-4 animate-spin text-primary" />
              <div className="flex-1">
                <span className="text-xs font-medium">
                  {video.pipelineStep === "downloading" ? "Скачивание видео..." :
                   video.pipelineStep === "downloading_from_vps" ? "Скачивание с VPS..." :
                   video.pipelineStep === "probing" ? "Анализ видеофайла..." :
                   video.pipelineStep === "skipped_download" ? "Видео уже на VPS, пропуск скачивания..." :
                   video.pipelineStep === "extracting_audio" ? "Извлечение аудио..." :
                   video.pipelineStep === "vad_chunking" ? "VAD: разбивка по паузам..." :
                   video.pipelineStep === "chunking_audio" ? "Нарезка аудио на фрагменты..." :
                   video.pipelineStep === "downloading_audio" ? "Скачивание аудио..." :
                   video.pipelineStep === "transcribing" ? (video.pipelineError?.startsWith("runpod_job:") || video.pipelineError?.startsWith("runpod_whisperx_job:") || video.pipelineError?.includes("RunPod") ? "Распознавание речи (RunPod GPU)..." : "Распознавание речи (Whisper)...") :
                   video.pipelineStep === "aligning" ? "Выравнивание таймстемпов (WhisperX)..." :
                   video.pipelineStep === "analyzing" ? "GPT анализ (хайлайты)..." :
                   video.pipelineStep === "analyzing_all" ? "GPT анализ (все моменты)..." :
                   video.pipelineStep === "splitting" ? "Нарезка клипов..." :
                   video.pipelineStep === "starting" ? "Запуск обработки..." :
                   video.pipelineStep === "completed" ? "Готово!" :
                   "Обработка..."}
                </span>
                <Progress value={video.pipelineProgress ?? 0} className="h-1 mt-1" />
              </div>
              <span className="text-xs text-muted-foreground font-mono">{video.pipelineProgress ?? 0}%</span>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => cancelPipelineMutation.mutate()}
                disabled={cancelPipelineMutation.isPending}
                data-testid="button-cancel-pipeline"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          )}

          {video.status === "error" && (
            <div className="flex flex-col gap-2 p-3">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-destructive shrink-0" />
                <span className="text-xs text-destructive">{video.pipelineError || "Ошибка"}</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {video.transcription ? (
                  <>
                    <Button variant="outline" size="sm" onClick={() => reanalyzeMutation.mutate("highlights")} disabled={reanalyzeMutation.isPending} data-testid="button-retry-highlights">
                      <Zap className="w-3 h-3 mr-1" />
                      AI хайлайты
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => reanalyzeMutation.mutate("all")} disabled={reanalyzeMutation.isPending} data-testid="button-retry-all">
                      <Scissors className="w-3 h-3 mr-1" />
                      Все моменты
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => processMutation.mutate()} disabled={processMutation.isPending} data-testid="button-retry-full">
                      <RefreshCw className="w-3 h-3 mr-1" />
                      Полная переобработка
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => processMutation.mutate({ transcribeOnly: true })} disabled={processMutation.isPending} data-testid="button-retry-fast">
                      <Zap className="w-3 h-3 mr-1" />
                      Быстрый Whisper
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="outline" size="sm" onClick={() => processMutation.mutate()} disabled={processMutation.isPending} data-testid="button-retry">
                      <Zap className="w-3 h-3 mr-1" />
                      Повтор
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => processMutation.mutate({ transcribeOnly: true })} disabled={processMutation.isPending} data-testid="button-retry-fast">
                      <Zap className="w-3 h-3 mr-1" />
                      Быстрый Whisper
                    </Button>
                  </>
                )}
                {video.pipelineError && (video.pipelineError.includes("cookie") || video.pipelineError.includes("Sign in") || video.pipelineError.includes("bot")) && (
                  <Button variant="outline" size="sm" onClick={() => setShowCookiePasteDialog(true)} data-testid="button-paste-cookies">
                    <Cookie className="w-3 h-3 mr-1" />
                    Cookies
                  </Button>
                )}
              </div>
            </div>
          )}

          {needsProcessing && (
            <div className="flex items-center gap-3 p-4">
              <Button onClick={() => processMutation.mutate()} disabled={processMutation.isPending} data-testid="button-start-processing">
                <Zap className="w-4 h-4 mr-2" />
                AI обработка
              </Button>
              <Button variant="outline" onClick={() => processMutation.mutate({ transcribeOnly: true })} disabled={processMutation.isPending} data-testid="button-start-processing-fast">
                <Zap className="w-4 h-4 mr-2" />
                Быстрый Whisper
              </Button>
            </div>
          )}

          {hasSegments && (() => {
            const segs = video.transcriptionSegments as any[] || [];
            const hasNoWords = segs.length > 5 && segs.slice(0, 5).every((s: any) => !s.words || s.words.length === 0);
            const has60sChunks = segs.length > 3 && segs.slice(0, 3).every((s: any) => Math.abs((s.end - s.start) - 60) < 1);
            return (hasNoWords || has60sChunks) ? (
              <div className="mx-3 mb-2 p-2 bg-yellow-500/10 border border-yellow-500/30 rounded text-xs text-yellow-400 text-center" data-testid="warning-bad-transcription">
                <span>⚠️ Субтитры без пословных таймингов — тайминги будут неточные. Используйте «Быстрый Whisper» в меню транскрипции.</span>
              </div>
            ) : null;
          })()}

          {(hasSegments || video.transcription) && (
            <div className="border rounded-md">
              <button
                className="flex items-center justify-between w-full text-left px-3 py-2"
                onClick={() => setShowTranscript(!showTranscript)}
                data-testid="button-toggle-transcript"
              >
                <div className="flex items-center gap-2">
                  <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium">Транскрипция</span>
                  <Badge variant="secondary" className="text-[10px]">
                    {hasSegments ? `${transcriptSegments.length} сег.` : `${(video.transcription || "").length} сим.`}
                  </Badge>
                  {hasSegments && (
                    <Badge variant={totalWords > 0 ? "secondary" : "destructive"} className="text-[10px]">
                      {totalWords > 0 ? `${alignedWords}/${totalWords} слов` : "0 слов ⚠"}
                    </Badge>
                  )}
                </div>
                {showTranscript ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
              </button>
              {showTranscript && (
                <div className="px-3 pb-3">
                  {hasSegments && totalWords === 0 && (
                    <div className="flex items-center gap-2 p-2 mb-2 bg-destructive/10 border border-destructive/20 rounded-md">
                      <span className="text-[10px] text-destructive">WhisperX не вернул таймстемпы слов. Подсветка слов не работает.</span>
                      <button
                        className="text-[10px] px-2 py-0.5 bg-primary text-primary-foreground rounded hover:bg-primary/90 whitespace-nowrap"
                        data-testid="button-realign-words"
                        onClick={() => {
                          apiRequest("POST", `/api/videos/${video.id}/realign`).then(() => {
                            toast({ title: "Re-align запущен" });
                            queryClient.invalidateQueries({ queryKey: ["/api/videos", video.id] });
                          }).catch((e: any) => toast({ title: "Ошибка", description: e.message, variant: "destructive" }));
                        }}
                      >Re-align</button>
                    </div>
                  )}
                  {hasSegments ? (
                    <TranscriptViewer
                      segments={transcriptSegments}
                      currentTime={playerCurrentTime}
                      videoRef={mainVideoElRef}
                      onSeekTo={(time) => {
                        setClipInTime(time);
                        setClipOutTime(Math.min(time + 30, video.duration || time + 30));
                      }}
                    />
                  ) : (
                    <div className="p-2 bg-muted rounded-md max-h-[150px] overflow-auto">
                      <p className="text-[10px] text-foreground leading-relaxed whitespace-pre-wrap font-mono">{video.transcription}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex-[1.5] overflow-auto p-3 space-y-2 min-w-[240px] border-r" data-testid="col-clips">
          {isReady && (
            <>
              <div className="space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Select value={selectedProfileId} onValueChange={(val) => {
                    setSelectedProfileId(val);
                    try { localStorage.setItem(`profileId_${videoId}`, val); } catch {}
                    updateProfileMutation.mutate(val);
                  }}>
                    <SelectTrigger className="w-full" data-testid="select-export-profile">
                      <SelectValue placeholder="Профиль" />
                    </SelectTrigger>
                    <SelectContent>
                      {profiles.map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedProfile?.calibration && (() => {
                    const ct = video.contentType || "poker";
                    const cal = selectedProfile.calibration;
                    return (
                      <div className="flex items-center gap-1.5 px-1 flex-wrap">
                        {ct !== "streamer" && cal.table && (
                          <Badge variant="secondary" className="text-[10px] bg-green-500/20 text-green-400 border-green-500/30" data-testid="badge-region-table">
                            TABLE {cal.table.width}×{cal.table.height}
                          </Badge>
                        )}
                        {cal.webcam && (
                          <Badge variant="secondary" className="text-[10px] bg-blue-500/20 text-blue-400 border-blue-500/30" data-testid="badge-region-webcam">
                            {ct === "streamer" ? "ОБЛАСТЬ" : "WEBCAM"} {cal.webcam.width}×{cal.webcam.height}
                          </Badge>
                        )}
                        {ct !== "streamer" && cal.chat && (
                          <Badge variant="secondary" className="text-[10px] bg-orange-500/20 text-orange-400 border-orange-500/30" data-testid="badge-region-chat">
                            CHAT {cal.chat.width}×{cal.chat.height}
                          </Badge>
                        )}
                        {!cal.table && !cal.webcam && (
                          <Badge variant="secondary" className="text-[10px]" data-testid="badge-calibration-empty">
                            <Settings className="w-2.5 h-2.5 mr-1" />
                            Нет регионов
                          </Badge>
                        )}
                      </div>
                    );
                  })()}
                  <div className="flex items-center gap-1 w-full">
                    {selectedProfile && (
                      <Button variant="outline" size="sm" className="flex-1" onClick={() => { setCalibrationFrameTime(undefined); setCalibrationClipId(undefined); setCalibrationOpen(true); }} data-testid="button-calibrate">
                        <Settings className="w-3 h-3 mr-1" />
                        {selectedProfile.calibration ? "Рекалиб." : "Калибр."}
                      </Button>
                    )}
                    <Button variant="outline" size="sm" className="flex-1" disabled={calibPreviewLoading} onClick={() => runCalibPreview(clipInTime !== null ? String(clipInTime) : calibPreviewTime)} data-testid="button-calib-preview">
                      {calibPreviewLoading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Search className="w-3 h-3 mr-1" />}
                      AI
                    </Button>
                  </div>
                </div>

                {selectedProfile?.calibration && (
                  <div className="flex items-center gap-3 flex-wrap">
                    <label className="flex items-center gap-1 cursor-pointer">
                      <Checkbox checked={aspectRatio === "1:1"} onCheckedChange={(v) => setAspectRatio(v === true ? "1:1" : "9:16")} data-testid="checkbox-aspect-ratio" />
                      <span className="text-[10px] text-muted-foreground">+1:1 (9:16 + квадрат)</span>
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                      <Checkbox checked={useAiCalibration} onCheckedChange={(v) => setUseAiCalibration(v === true)} data-testid="checkbox-ai-calibration" />
                      <span className="text-[10px] text-muted-foreground">AI калибровка</span>
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                      <Checkbox checked={muteAudio} onCheckedChange={(v) => setMuteAudio(v === true)} data-testid="checkbox-mute-audio" />
                      <span className="text-[10px] text-muted-foreground">Без звука</span>
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                      <Checkbox checked={bleepProfanity} onCheckedChange={(v) => { setBleepProfanity(v === true); }} data-testid="checkbox-bleep-profanity" />
                      <span className="text-[10px] text-muted-foreground">Запикать мат</span>
                    </label>
                    {video?.contentType === "streamer" && (
                      <div className="flex items-center gap-1">
                        <label className="flex items-center gap-1 cursor-pointer">
                          <Checkbox checked={enableDynamicCamera} onCheckedChange={(v) => { const val = v === true; setEnableDynamicCamera(val); try { localStorage.setItem("enableDynamicCamera", String(val)); } catch {} }} data-testid="checkbox-dynamic-camera" />
                          <span className="text-[10px] text-muted-foreground">Динам. камера</span>
                        </label>
                        {enableDynamicCamera && (
                          <select
                            value={cameraMode}
                            onChange={(e) => { const v = e.target.value as "auto" | "smooth" | "cuts"; setCameraMode(v); try { localStorage.setItem("cameraMode", v); } catch {} }}
                            className="h-5 text-[10px] bg-background border border-border rounded px-1 text-muted-foreground"
                            data-testid="select-camera-mode"
                          >
                            <option value="auto">Авто</option>
                            <option value="smooth">Плавно</option>
                            <option value="cuts">Резко</option>
                          </select>
                        )}
                      </div>
                    )}
                    <select
                      value={videoFilter}
                      onChange={(e) => { setVideoFilter(e.target.value); try { localStorage.setItem("videoFilter", e.target.value); } catch {} }}
                      className="h-5 text-[10px] bg-background border border-border rounded px-1 text-muted-foreground"
                      data-testid="select-video-filter"
                    >
                      <option value="none">Без фильтра</option>
                      <option value="sharpen">🔍 Резкость</option>
                      <option value="warm">🌅 Тёплый</option>
                      <option value="cool">❄️ Холодный</option>
                      <option value="vibrant">🎨 Насыщенный</option>
                      <option value="cinematic">🎬 Кинематограф</option>
                      <option value="vintage">📷 Винтаж</option>
                      <option value="hdr">✨ HDR</option>
                      <option value="bw">⬛ Ч/Б</option>
                      <option value="soft">☁️ Мягкий</option>
                      <option value="dramatic">🔥 Драматичный</option>
                    </select>
                    <label className="flex items-center gap-1 cursor-pointer">
                      <Checkbox checked={resolution === "4k"} onCheckedChange={(v) => { const val = v === true ? "4k" : "1080p"; setResolution(val); try { localStorage.setItem("exportResolution", val); } catch {} }} data-testid="checkbox-4k" />
                      <span className="text-[10px] text-muted-foreground">4K</span>
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                      <Checkbox checked={autoPublish} onCheckedChange={(v) => setAutoPublish(v === true)} data-testid="checkbox-auto-publish" />
                      <span className="text-[10px] text-muted-foreground">Автопубликация</span>
                    </label>
                    <div className="flex items-center gap-0.5 ml-1 border border-border rounded overflow-hidden" data-testid="toggle-render-engine-global">
                      <button
                        onClick={() => { setRenderEngine("vps"); try { localStorage.setItem("renderEngine", "vps"); } catch {} }}
                        className={`px-1.5 py-0.5 text-[9px] font-bold transition-colors ${renderEngine === "vps" ? "bg-blue-500/20 text-blue-400" : "bg-muted/50 text-muted-foreground hover:text-foreground"}`}
                        data-testid="btn-render-vps-global"
                      >
                        VPS
                      </button>
                      <button
                        onClick={() => { setRenderEngine("runpod"); try { localStorage.setItem("renderEngine", "runpod"); } catch {} }}
                        className={`px-1.5 py-0.5 text-[9px] font-bold transition-colors ${renderEngine === "runpod" ? "bg-green-500/20 text-green-400" : "bg-muted/50 text-muted-foreground hover:text-foreground"}`}
                        data-testid="btn-render-runpod-global"
                      >
                        GPU
                      </button>
                    </div>
                    {renderEngine === "runpod" && (
                      <div className="flex items-center gap-1 ml-1" data-testid="pod-status-indicator">
                        <div className={`w-1.5 h-1.5 rounded-full ${
                          podStatusQuery.data?.status === "running" ? "bg-green-500" :
                          podStatusQuery.data?.status === "starting" ? "bg-yellow-500 animate-pulse" :
                          "bg-red-500"
                        }`} />
                        <span className="text-[9px] text-muted-foreground">
                          {podStatusQuery.data?.status === "running" ? "Pod ON" :
                           podStatusQuery.data?.status === "starting" ? "Starting..." :
                           "Pod OFF (auto)"}
                        </span>
                        {podStatusQuery.data?.status === "running" && (
                          <button
                            onClick={async () => {
                              try {
                                await apiRequest("POST", "/api/pod/stop");
                                queryClient.invalidateQueries({ queryKey: ["/api/pod/status"] });
                              } catch {}
                            }}
                            className="text-[8px] text-red-400 hover:text-red-300 underline"
                            data-testid="btn-pod-stop"
                          >
                            Stop
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {selectedProfile?.calibration && (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <label className="flex items-center gap-1 cursor-pointer" data-testid="label-crawl-caption">
                      <input
                        type="checkbox"
                        checked={useCrawlCaption}
                        onChange={(e) => { setUseCrawlCaption(e.target.checked); try { localStorage.setItem("useCrawlCaption", String(e.target.checked)); } catch {} }}
                        className="w-3 h-3"
                        data-testid="checkbox-crawl-caption"
                      />
                      <span className="text-[10px] text-muted-foreground">Caption (Whisper)</span>
                    </label>
                    <div className="flex items-center gap-1 ml-2">
                      <span className="text-[10px] text-muted-foreground">Y:</span>
                      <input
                        type="range"
                        min={30}
                        max={95}
                        step={1}
                        value={captionPositionY}
                        onChange={(e) => { const v = Number(e.target.value); setCaptionPositionY(v); try { localStorage.setItem("captionPositionY", String(v)); } catch {} }}
                        className="w-16 h-3 accent-blue-500"
                        data-testid="slider-main-caption-position-y"
                      />
                      <span className="text-[10px] text-muted-foreground">{captionPositionY}%</span>
                    </div>
                  </div>
                )}

                {selectedProfile?.calibration && (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[10px] text-muted-foreground whitespace-nowrap">Фон.звук:</span>
                    <select
                      value={bgAudioFilename}
                      onChange={(e) => { setBgAudioFilename(e.target.value); try { localStorage.setItem("bgAudioFilename", e.target.value); } catch {} }}
                      className="h-6 text-[11px] px-1 py-0 border rounded bg-background text-foreground min-w-[100px] max-w-[200px]"
                      data-testid="select-bg-audio"
                    >
                      <option value="">Нет</option>
                      {(() => {
                        const favs = soundsData?.sounds?.filter(s => favoriteSounds.includes(s.filename)) || [];
                        const rest = soundsData?.sounds?.filter(s => !favoriteSounds.includes(s.filename)) || [];
                        return (<>
                          {favs.length > 0 && <optgroup label="⭐ Мои треки">{favs.map(s => <option key={s.id} value={s.filename}>{s.filename.replace(/\.mp3$/i, "")}</option>)}</optgroup>}
                          {rest.length > 0 && <optgroup label="Библиотека">{rest.map(s => <option key={s.id} value={s.filename}>{s.filename.replace(/\.mp3$/i, "")}</option>)}</optgroup>}
                        </>);
                      })()}
                    </select>
                    {bgAudioFilename && (
                      <>
                        <span className="text-[10px] text-muted-foreground">Громк:</span>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.05"
                          value={bgAudioVolume}
                          onChange={(e) => { const v = parseFloat(e.target.value); setBgAudioVolume(v); try { localStorage.setItem("bgAudioVolume", String(v)); } catch {} }}
                          className="w-16 h-4"
                          data-testid="range-bg-audio-volume"
                        />
                        <span className="text-[10px] text-muted-foreground w-6">{Math.round(bgAudioVolume * 100)}%</span>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => setShowSoundsManager(!showSoundsManager)}
                      className="text-[10px] text-blue-500 hover:text-blue-400 underline"
                      data-testid="button-manage-sounds"
                    >
                      {showSoundsManager ? "Скрыть" : "Управление"}
                    </button>
                  </div>
                )}

                {showSoundsManager && selectedProfile?.calibration && (
                  <div className="border rounded p-2 space-y-2 bg-muted/30">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-medium">Библиотека звуков</span>
                      <label className="text-[10px] text-blue-500 hover:text-blue-400 cursor-pointer underline" data-testid="button-upload-sound">
                        + Загрузить
                        <input
                          type="file"
                          accept=".mp3,.wav,.aac,.m4a,.ogg"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) uploadSoundMutation.mutate(file);
                            e.target.value = "";
                          }}
                        />
                      </label>
                      {uploadSoundMutation.isPending && <span className="text-[10px] text-muted-foreground">Загрузка...</span>}
                    </div>
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        placeholder="Ссылка TikTok / Instagram / YouTube"
                        value={downloadSoundUrl}
                        onChange={(e) => setDownloadSoundUrl(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && downloadSoundUrl.trim()) downloadSoundMutation.mutate(downloadSoundUrl.trim()); }}
                        className="flex-1 text-[10px] px-2 py-1 bg-background border rounded"
                        data-testid="input-download-sound-url"
                      />
                      <button
                        type="button"
                        onClick={() => { if (downloadSoundUrl.trim()) downloadSoundMutation.mutate(downloadSoundUrl.trim()); }}
                        disabled={downloadSoundMutation.isPending || !downloadSoundUrl.trim()}
                        className="text-[10px] px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50"
                        data-testid="button-download-sound"
                      >
                        {downloadSoundMutation.isPending ? "Скачиваю..." : "Скачать"}
                      </button>
                    </div>
                    {soundsData?.sounds && soundsData.sounds.length > 0 ? (
                      <div className="space-y-1">
                        {soundsData.sounds.map((s) => (
                          <div key={s.id} className="flex items-center gap-1.5 text-[10px]">
                            <button
                              type="button"
                              onClick={() => toggleFavorite(s.filename)}
                              className={`w-5 h-5 flex items-center justify-center rounded ${favoriteSounds.includes(s.filename) ? "text-yellow-400" : "text-muted-foreground hover:text-yellow-400"}`}
                              data-testid={`button-favorite-sound-${s.id}`}
                              title={favoriteSounds.includes(s.filename) ? "Убрать из избранного" : "В избранное"}
                            >
                              {favoriteSounds.includes(s.filename) ? "★" : "☆"}
                            </button>
                            <button
                              type="button"
                              onClick={() => toggleSoundPreview(s.filename)}
                              className={`w-5 h-5 flex items-center justify-center rounded ${playingSound === s.filename ? "bg-green-600 text-white" : "bg-muted hover:bg-muted/80 text-foreground"}`}
                              data-testid={`button-preview-sound-${s.id}`}
                              title="Прослушать"
                            >
                              {playingSound === s.filename ? "⏸" : "▶"}
                            </button>
                            <span className={`flex-1 truncate ${bgAudioFilename === s.filename ? "text-blue-500 font-medium" : "text-foreground"}`}>{s.filename}</span>
                            <span className="text-muted-foreground">{(s.sizeBytes / 1024 / 1024).toFixed(1)}MB</span>
                            <button
                              type="button"
                              onClick={() => { setBgAudioFilename(s.filename); try { localStorage.setItem("bgAudioFilename", s.filename); } catch {} }}
                              className="text-blue-500 hover:text-blue-400"
                              data-testid={`button-select-sound-${s.id}`}
                            >
                              Выбрать
                            </button>
                            <button
                              type="button"
                              onClick={() => { if (confirm(`Удалить ${s.filename}?`)) deleteSoundMutation.mutate(s.id); }}
                              className="text-red-500 hover:text-red-400"
                              data-testid={`button-delete-sound-${s.id}`}
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[10px] text-muted-foreground">Нет загруженных звуков. Загрузите MP3 файл.</div>
                    )}
                  </div>
                )}

                {autoPublish && selectedProfile?.calibration && (
                  <div className="flex items-center gap-2 flex-wrap">
                    {(["youtube", "vk", "tiktok", "instagram", "facebook", "threads"] as const).map((p) => {
                      const icons: Record<string, string> = { youtube: "YT", vk: "VK", tiktok: "TT", instagram: "IG", facebook: "FB", threads: "TH" };
                      const connected = socialStatuses[p]?.connected;
                      return (
                        <label key={p} className={`flex items-center gap-0.5 cursor-pointer ${!connected ? "opacity-40" : ""}`}>
                          <Checkbox
                            checked={autoPublishPlatforms[p] ?? true}
                            onCheckedChange={(v) => setAutoPublishPlatforms(prev => ({ ...prev, [p]: v === true }))}
                            disabled={!connected}
                            data-testid={`checkbox-autopub-${p}`}
                          />
                          <span className="text-[9px] text-muted-foreground">{icons[p]}</span>
                        </label>
                      );
                    })}
                  </div>
                )}

                {approvedWithoutExport.length > 0 && selectedProfile?.calibration && (
                  <div className="space-y-1">
                    <Button variant="default" size="sm" className="w-full" onClick={() => exportAllMutation.mutate()} disabled={exportAllMutation.isPending} data-testid="button-export-all">
                      <Package className="w-3 h-3 mr-1" />
                      {autoPublish ? "Рендер + публикация" : "Рендер всех"} ({approvedWithoutExport.length})
                      {exportAllMutation.isPending && <Loader2 className="w-3 h-3 ml-1 animate-spin" />}
                    </Button>
                  </div>
                )}

                {video?.highlights && (video.highlights as any[]).length > 0 && selectedProfileId && (
                  <div className="space-y-1">
                    <div className="flex gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 border-violet-500/50 text-violet-400 hover:bg-violet-500/10"
                        onClick={() => autoCutMutation.mutate()}
                        disabled={autoCutMutation.isPending}
                        data-testid="button-auto-cut"
                      >
                        <Sparkles className="w-3 h-3 mr-1" />
                        AI Авто-нарезка
                        {autoCutMutation.isPending && <Loader2 className="w-3 h-3 ml-1 animate-spin" />}
                      </Button>
                      <input
                        type="number"
                        min={1}
                        max={20}
                        value={autoCutMaxClips}
                        onChange={e => {
                          const v = Math.max(1, Math.min(20, parseInt(e.target.value) || 1));
                          setAutoCutMaxClips(v);
                          try { localStorage.setItem("autoCutMaxClips", String(v)); } catch {}
                        }}
                        className="w-10 text-center text-xs bg-background border border-border rounded px-1 py-1"
                        title="Количество клипов"
                        data-testid="input-auto-cut-max-clips"
                      />
                    </div>
                    <p className="text-[9px] text-muted-foreground text-center">GPU рендер + субтитры, top хайлайты</p>
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h3 className="text-xs font-medium text-muted-foreground">Соцсети</h3>
                  {publishedToday !== undefined && (
                    <Badge variant="outline" className="text-[10px] gap-1" data-testid="badge-published-today">
                      Сегодня: {publishedToday.total}
                    </Badge>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {(() => {
                    const platforms = [
                      { key: "youtube", label: "YouTube", icon: SiYoutube, iconClass: "w-3 h-3 text-red-500" },
                      { key: "vk", label: "VK", icon: SiVk, iconClass: "w-3 h-3 text-blue-500" },
                      { key: "tiktok", label: "TikTok", icon: SiTiktok, iconClass: "w-3 h-3" },
                      { key: "instagram", label: "Instagram", icon: SiInstagram, iconClass: "w-3 h-3 text-pink-500" },
                      { key: "facebook", label: "Facebook", icon: SiFacebook, iconClass: "w-3 h-3 text-blue-600" },
                      { key: "threads", label: "Threads", icon: SiThreads, iconClass: "w-3 h-3" },
                    ];
                    return platforms.map(({ key, label, icon: Icon, iconClass }) => {
                      const st = (socialStatuses as any)[key];
                      if (st?.connected) {
                        return (
                          <Badge key={key} variant="secondary" className="text-xs gap-1" data-testid={`social-badge-${key}`}>
                            <Icon className={iconClass} />
                            {st.accountName || label}
                            {st.method === "postmypost" && <span className="text-muted-foreground ml-0.5">(Postmypost)</span>}
                          </Badge>
                        );
                      }
                      return (
                        <Badge key={key} variant="outline" className="text-xs gap-1 opacity-40" data-testid={`social-badge-${key}`}>
                          <Icon className={iconClass} />
                          {label}
                        </Badge>
                      );
                    });
                  })()}
                </div>
              </div>

              {(video.status === "analyzed" || video.status === "error" || video.transcription) && !isProcessing && (
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => rewhisperMutation.mutate({ mode: "highlights" })}
                    disabled={rewhisperMutation.isPending || reanalyzeMutation.isPending}
                    data-testid="button-rerun-whisper"
                  >
                    <RefreshCw className={`w-3 h-3 mr-1 ${rewhisperMutation.isPending ? "animate-spin" : ""}`} />
                    Whisper + AI
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => rewhisperMutation.mutate({ mode: "highlights", transcribeOnly: true })}
                    disabled={rewhisperMutation.isPending || reanalyzeMutation.isPending}
                    data-testid="button-rerun-whisper-fast"
                  >
                    <Zap className={`w-3 h-3 mr-1 ${rewhisperMutation.isPending ? "animate-spin" : ""}`} />
                    Быстрый Whisper
                  </Button>
                  {video.transcription && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => reanalyzeMutation.mutate("highlights")}
                        disabled={reanalyzeMutation.isPending || rewhisperMutation.isPending}
                        data-testid="button-rerun-highlights"
                      >
                        <Zap className={`w-3 h-3 mr-1 ${reanalyzeMutation.isPending ? "animate-spin" : ""}`} />
                        AI хайлайты
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => reanalyzeMutation.mutate("all")}
                        disabled={reanalyzeMutation.isPending || rewhisperMutation.isPending}
                        data-testid="button-rerun-all-moments"
                      >
                        <Scissors className={`w-3 h-3 mr-1 ${reanalyzeMutation.isPending ? "animate-spin" : ""}`} />
                        Все моменты
                      </Button>
                    </>
                  )}
                </div>
              )}

              {autoCuts.length > 0 && clips.length > 0 && (
                <div className="flex items-center gap-1 border-b border-border/50 pb-1" data-testid="clip-tab-switcher">
                  <Button
                    variant={clipListTab === "clips" ? "default" : "ghost"}
                    size="sm"
                    className="h-6 text-[11px] px-2"
                    onClick={() => setClipListTab("clips")}
                    data-testid="tab-clips"
                  >
                    Клипы ({clips.length})
                  </Button>
                  <Button
                    variant={clipListTab === "autocuts" ? "default" : "ghost"}
                    size="sm"
                    className="h-6 text-[11px] px-2 gap-1"
                    onClick={() => setClipListTab("autocuts")}
                    data-testid="tab-autocuts"
                  >
                    <Sparkles className="w-3 h-3" />
                    AI Авто ({autoCuts.length})
                    {autoCuts.some((c: any) => c.status === "processing" || c.status === "queued") && (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    )}
                  </Button>
                </div>
              )}

              {(clipListTab === "autocuts" || !clips.length) && autoCuts.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    {!clips.length && (
                      <h3 className="text-xs font-medium text-violet-400 flex items-center gap-1">
                        <Sparkles className="w-3 h-3" />
                        AI Авто-нарезка ({autoCuts.length})
                      </h3>
                    )}
                    <div className="flex items-center gap-1">
                      {autoCuts.some((c: any) => c.status === "processing" || c.status === "queued") && (
                        <>
                          <Badge variant="outline" className="text-[10px] border-violet-500/50 text-violet-400">
                            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                            Рендер...
                          </Badge>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 text-[10px] text-orange-400 hover:text-orange-300 hover:bg-orange-500/10"
                            disabled={stopAutoCutMutation.isPending}
                            onClick={() => stopAutoCutMutation.mutate()}
                            data-testid="button-stop-autocut"
                          >
                            {stopAutoCutMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Square className="w-3 h-3 mr-1" />}
                            Стоп
                          </Button>
                        </>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-[10px] text-red-400 hover:text-red-300 hover:bg-red-500/10"
                        disabled={deleteAllAutoCutsMutation.isPending}
                        onClick={() => {
                          if (confirm(`Удалить все ${autoCuts.length} AI клипов?`)) {
                            deleteAllAutoCutsMutation.mutate();
                          }
                        }}
                        data-testid="button-delete-all-autocuts"
                      >
                        {deleteAllAutoCutsMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Trash2 className="w-3 h-3 mr-1" />}
                        Удалить все
                      </Button>
                    </div>
                  </div>
                  <div className="grid gap-2">
                    {autoCuts
                      .sort((a: any, b: any) => (b.excitement || 0) - (a.excitement || 0))
                      .map((cut: any) => (
                      <div key={cut.id} className="border border-violet-500/20 rounded-lg p-2 bg-violet-500/5 space-y-1.5" data-testid={`autocut-card-${cut.id}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium truncate">{cut.title}</p>
                            <p className="text-[10px] text-muted-foreground">
                              {Math.floor(cut.startTime / 60)}:{String(Math.floor(cut.startTime % 60)).padStart(2, "0")} — {Math.floor(cut.endTime / 60)}:{String(Math.floor(cut.endTime % 60)).padStart(2, "0")}
                              {" "}({Math.round(cut.endTime - cut.startTime)}с)
                              {cut.excitement > 0 && <span className="ml-1 text-orange-400">🔥{cut.excitement}</span>}
                            </p>
                          </div>
                          <div className="flex items-center gap-1">
                            {cut.status === "completed" && (
                              <Badge variant="outline" className="text-[9px] border-green-500/50 text-green-400">Готово</Badge>
                            )}
                            {cut.status === "processing" && (
                              <Badge variant="outline" className="text-[9px] border-blue-500/50 text-blue-400">
                                <Loader2 className="w-2.5 h-2.5 mr-0.5 animate-spin" />{cut.progress || 0}%
                              </Badge>
                            )}
                            {cut.status === "queued" && (
                              <Badge variant="outline" className="text-[9px] border-yellow-500/50 text-yellow-400">Очередь</Badge>
                            )}
                            {cut.status === "error" && (
                              <Badge variant="outline" className="text-[9px] border-red-500/50 text-red-400" title={cut.error}>Ошибка</Badge>
                            )}
                            {(cut.status === "completed" || cut.status === "error") && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-5 w-5 text-blue-400 hover:text-blue-300"
                                disabled={reRenderingCutId === cut.id}
                                onClick={() => reRenderAutoCutMutation.mutate(cut.id)}
                                title="Перерендер (повторить с AI коррекцией)"
                                data-testid={`button-rerender-autocut-${cut.id}`}
                              >
                                <RotateCcw className={`w-3 h-3 ${reRenderingCutId === cut.id ? "animate-spin" : ""}`} />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-5 w-5 text-red-400 hover:text-red-300"
                              onClick={async () => {
                                await apiRequest("DELETE", `/api/auto-cuts/${cut.id}`);
                                queryClient.invalidateQueries({ queryKey: ["/api/auto-cuts/video", videoId] });
                              }}
                              data-testid={`button-delete-autocut-${cut.id}`}
                            >
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </div>
                        </div>
                        {cut.hookLine && (
                          <p className="text-[10px] text-violet-300/70 italic truncate">«{cut.hookLine}»</p>
                        )}
                        {cut.status === "completed" && cut.outputPath && (
                          <video
                            src={`/api/auto-cuts/${cut.id}/video`}
                            controls
                            className="w-full rounded max-h-[300px] bg-black"
                            preload="metadata"
                            data-testid={`video-autocut-${cut.id}`}
                          />
                        )}
                        {cut.status === "completed" && cut.outputPath && (() => {
                          const isCutUploading = acUploadingCutId === cut.id;
                          const isCutBulkUploading = acBulkUploadingCutId === cut.id;
                          const isAnyCutBusy = isCutUploading || isCutBulkUploading;
                          const allPlatforms: { key: string; label: string; icon: any; iconClass: string }[] = [
                            { key: "youtube", label: "YT", icon: SiYoutube, iconClass: "w-2.5 h-2.5 text-red-500" },
                            { key: "vk", label: "VK", icon: SiVk, iconClass: "w-2.5 h-2.5 text-blue-500" },
                            { key: "tiktok", label: "TT", icon: SiTiktok, iconClass: "w-2.5 h-2.5" },
                            { key: "instagram", label: "IG", icon: SiInstagram, iconClass: "w-2.5 h-2.5 text-pink-500" },
                            { key: "facebook", label: "FB", icon: SiFacebook, iconClass: "w-2.5 h-2.5 text-blue-600" },
                            { key: "threads", label: "TH", icon: SiThreads, iconClass: "w-2.5 h-2.5" },
                          ];
                          const published = cut.publishedTo || [];
                          const cutPmpEntries = Object.entries(pmpPubTracking).filter(([key]) => key.startsWith(`ac_${cut.id}_`));
                          return (
                          <div className="space-y-1">
                            <div className="flex items-center gap-1 flex-wrap">
                              {(() => {
                                const connectedCount = [
                                  socialStatuses.youtube?.connected,
                                  socialStatuses.vk?.connected,
                                  socialStatuses.tiktok?.connected,
                                  socialStatuses.instagram?.connected,
                                  socialStatuses.facebook?.connected,
                                  socialStatuses.threads?.connected,
                                ].filter(Boolean).length;
                                return connectedCount >= 2 ? (
                                  <Button
                                    variant="default"
                                    size="sm"
                                    className="h-5 text-[10px] px-1.5"
                                    disabled={isAnyCutBusy}
                                    onClick={() => {
                                      setAcBulkTitle(cut.title || "Short");
                                      setAcBulkDescription("");
                                      setAcBulkHashtagPlatforms({ youtube: true, tiktok: true, instagram: true, facebook: true, threads: true, vk: true });
                                      setAcBulkTiktokCustomTags("");
                                      setAcBulkCutId(cut.id);
                                      setAcBulkDialogOpen(true);
                                    }}
                                    data-testid={`button-bulk-autocut-${cut.id}`}
                                  >
                                    {isCutBulkUploading ? <Loader2 className="w-3 h-3 mr-0.5 animate-spin" /> : <Share2 className="w-3 h-3 mr-0.5" />}
                                    Во все ({connectedCount})
                                  </Button>
                                ) : null;
                              })()}
                              {allPlatforms.map(p => {
                                if (!socialStatuses[p.key as keyof typeof socialStatuses]?.connected) return null;
                                const Icon = p.icon;
                                const isPlatformUploading = isCutUploading && acUploadingPlatform === p.key;
                                return (
                                  <Button
                                    key={p.key}
                                    variant="outline"
                                    size="sm"
                                    className="h-5 text-[10px] px-1.5"
                                    disabled={isAnyCutBusy}
                                    onClick={() => {
                                      setAcSocialPlatform(p.key);
                                      setAcSocialTitle(cut.title || "Short");
                                      setAcSocialDescription("");
                                      if (p.key === "tiktok") setAcSocialTiktokCustomTags("");
                                      setAcSocialCutId(cut.id);
                                      setAcSocialDialogOpen(true);
                                    }}
                                    data-testid={`button-${p.key}-autocut-${cut.id}`}
                                  >
                                    {isPlatformUploading ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Icon className={p.iconClass} />}
                                  </Button>
                                );
                              })}
                            </div>
                            {(published.length > 0 || cutPmpEntries.length > 0) && (
                              <div className="flex items-center gap-1 flex-wrap">
                                {allPlatforms.map(p => {
                                  const isPublished = published.includes(p.key);
                                  const Icon = p.icon;
                                  const urls = (cut.publishedUrls as Record<string, string>) || {};
                                  const url = urls[p.key];
                                  if (!isPublished) return null;
                                  if (url) {
                                    return (
                                      <a key={p.key} href={url} target="_blank" rel="noopener noreferrer">
                                        <Badge variant="secondary" className="text-[9px] gap-0.5 h-4 cursor-pointer" data-testid={`autocut-published-${cut.id}-${p.key}`}>
                                          <Icon className={p.iconClass} />{p.label}
                                          <ExternalLink className="w-2 h-2 ml-0.5 opacity-60" />
                                        </Badge>
                                      </a>
                                    );
                                  }
                                  return (
                                    <Badge
                                      key={p.key}
                                      variant="secondary"
                                      className="text-[9px] gap-0.5 h-4 cursor-pointer"
                                      data-testid={`autocut-published-${cut.id}-${p.key}`}
                                      onClick={() => {
                                        if (confirm(`Сбросить статус публикации ${p.label}?`)) {
                                          apiRequest("POST", `/api/auto-cuts/${cut.id}/unpublish`, { platform: p.key })
                                            .then(() => {
                                              queryClient.invalidateQueries({ queryKey: ["/api/auto-cuts/video", videoId] });
                                              toast({ title: `${p.label} — статус сброшен` });
                                            })
                                            .catch((err: Error) => toast({ title: "Ошибка", description: err.message, variant: "destructive" }));
                                        }
                                      }}
                                      title="Клик — сбросить статус"
                                    >
                                      <Icon className={p.iconClass} />{p.label}
                                      <Check className="w-2 h-2 ml-0.5 opacity-60" />
                                    </Badge>
                                  );
                                })}
                                {cutPmpEntries
                                  .filter(([, v]) => v.polling)
                                  .map(([key, v]) => {
                                    const pi = allPlatforms.find(p => p.key === v.platform);
                                    const PIcon = pi?.icon || SiVk;
                                    const cls = pi?.iconClass || "w-2.5 h-2.5";
                                    return (
                                      <Badge key={key} variant="outline" className="text-[9px] gap-0.5 h-4 animate-pulse" data-testid={`autocut-pmp-status-${v.platform}-${cut.id}`}>
                                        <PIcon className={cls} />{v.status}
                                      </Badge>
                                    );
                                  })}
                              </div>
                            )}
                          </div>
                          );
                        })()}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {clips.length > 0 && (clipListTab === "clips" || !autoCuts.length) && (
                <>
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    {!autoCuts.length && (
                      <h3 className="text-xs font-medium text-muted-foreground">
                        Клипы ({clips.length})
                        {video.analysisMode && (
                          <span className="ml-1.5 text-muted-foreground/60">
                            — {video.analysisMode === "all" ? "все моменты" : "хайлайты"}
                          </span>
                        )}
                      </h3>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setShowDeletedClips(true)}
                      title="Корзина удалённых клипов"
                      data-testid="button-show-deleted-clips"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                    {"showDirectoryPicker" in window && (
                      <Button
                        variant="outline"
                        size="sm"
                        className={autoSaveDirName
                          ? "border-green-600/50 dark:border-green-500/50 bg-green-600/10 dark:bg-green-500/10 text-green-700 dark:text-green-400"
                          : "text-muted-foreground"
                        }
                        onClick={async () => {
                          if (autoSaveDirName) {
                            autoSaveDirRef.current = null;
                            autoSaveReadyRef.current = false;
                            setAutoSaveDirName(null);
                            saveAutoSaveHandle(null);
                            toast({ title: "Автосохранение выключено" });
                            return;
                          }
                          try {
                            const handle = await (window as any).showDirectoryPicker({ mode: "readwrite" });
                            autoSaveDirRef.current = handle;
                            autoSaveReadyRef.current = true;
                            knownExportsRef.current = new Set(exports.filter(e => e.status === "completed" && !e.isPreview).map(e => e.id));
                            setAutoSaveDirName(handle.name);
                            saveAutoSaveHandle(handle);
                            toast({ title: "Автосохранение включено", description: `Готовые рендеры → "${handle.name}"` });
                          } catch (e: any) {
                            if (e?.name !== "AbortError") {
                              toast({ title: "Ошибка", description: e.message, variant: "destructive" });
                            }
                          }
                        }}
                        data-testid="button-auto-save-dir"
                      >
                        {autoSaveDirName ? (
                          <>
                            <Check className="w-3 h-3 mr-1" />
                            Автосохранение: {autoSaveDirName}
                          </>
                        ) : (
                          <>
                            <FolderOpen className="w-3 h-3 mr-1" />
                            Автосохранение: выкл
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    {[...clips].sort((a, b) => {
                      const aApproved = a.status === "approved" ? 1 : 0;
                      const bApproved = b.status === "approved" ? 1 : 0;
                      if (aApproved !== bApproved) return bApproved - aApproved;
                      return a.startTime - b.startTime;
                    }).map((clip) => (
                      <ClipRow
                        key={clip.id}
                        clip={clip}
                        video={video}
                        clipExport={exports.filter((e) => e.clipId === clip.id && !e.isPreview && e.aspectRatio !== "1:1").sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]}
                        clipExportSquare={exports.filter((e) => e.clipId === clip.id && !e.isPreview && e.aspectRatio === "1:1").sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]}
                        clipPreviewExport={exports.filter((e) => e.clipId === clip.id && e.isPreview).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]}
                        onAiCalibrate={(time) => runCalibPreview(String(time))}
                        onManualCalibrate={selectedProfileId ? (time) => {
                          setCalibrationFrameTime(time);
                          setCalibrationClipId(clip.id);
                          setCalibrationOpen(true);
                        } : undefined}
                        selectedProfile={selectedProfile}
                        onApprove={(clipId, startTime, endTime) => approveMutation.mutate({ clipId, startTime, endTime })}
                        onReject={(clipId) => rejectMutation.mutate(clipId)}
                        onDelete={(clipId) => deleteMutation.mutate(clipId)}
                        onSaveTime={(clipId, startTime, endTime) => saveTimeMutation.mutate({ clipId, startTime, endTime })}
                        onExport={(clipId) => exportMutation.mutate({ clipId })}
                        onPreviewExport={(clipId) => exportMutation.mutate({ clipId, isPreview: true })}
                        onPreview={(c) => { setPreviewClip(c); setViewedClipIds(prev => new Set(prev).add(c.id.toString())); }}
                        onShowInPanel={(exportJob, label, clipTitle) => { rightPanelStreamTs.current = Date.now(); setRightPanelExport({ exportJob, label, clipTitle }); }}
                        onYoutubeUpload={(exportId, title, description) => youtubeUploadMutation.mutate({ exportId, title, description })}
                        youtubeConnected={youtubeStatus?.connected}
                        youtubeUploading={youtubeUploadMutation.isPending}
                        onSocialUpload={(platform, exportId, title, description) => socialUploadMutation.mutate({ platform, exportId, title, description })}
                        onBulkUpload={handleBulkUpload}
                        socialStatuses={socialStatuses}
                        socialUploading={socialUploadingPlatform}
                        bulkUploading={bulkUploadingState}
                        activePanelExportId={rightPanelExport?.exportJob.id}
                        onRetryExport={(exportId) => retryExportMutation.mutate(exportId)}
                        pmpPubTracking={pmpPubTracking}
                        onUnpublish={handleUnpublish}
                        isUploading={uploadingClipId === clip.id || autoPublishingClipIds.has(clip.id)}
                        isViewed={viewedClipIds.has(clip.id.toString())}
                      />
                    ))}
                  </div>
                </>
              )}

              {clips.length === 0 && (
                <div className="py-4">
                  <p className="text-[10px] text-muted-foreground">
                    Нет клипов. Используйте IN/OUT на таймлайне.
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        <div className="w-[540px] flex-shrink-0 overflow-hidden p-2 flex flex-col gap-1" data-testid="col-result">
          <div className="flex items-center justify-between gap-1 flex-shrink-0">
            <h3 className="text-xs font-medium text-muted-foreground">Результат 9:16</h3>
            {rightPanelExport && (
              <div className="flex items-center gap-0.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    const url = `/api/exports/${rightPanelExport.exportJob.id}/download`;
                    const defaultName = (rightPanelExport.clipTitle || `poker_short`).replace(/[^a-zA-Zа-яА-ЯёЁ0-9_-]/g, "_") + ".mp4";
                    try {
                      if ("showSaveFilePicker" in window) {
                        const handle = await (window as any).showSaveFilePicker({
                          suggestedName: defaultName,
                          types: [{ description: "MP4 Video", accept: { "video/mp4": [".mp4"] } }],
                        });
                        const res = await fetch(url);
                        const blob = await res.blob();
                        const writable = await handle.createWritable();
                        await writable.write(blob);
                        await writable.close();
                      } else {
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = defaultName;
                        a.click();
                      }
                    } catch (e: any) {
                      if (e?.name !== "AbortError") {
                        window.open(url, "_blank");
                      }
                    }
                  }}
                  data-testid="button-panel-download"
                >
                  <Download className="w-3 h-3 mr-1" />
                  Скачать
                </Button>
                <Button size="icon" variant="ghost" onClick={() => setRightPanelExport(null)} data-testid="button-close-panel-video">
                  <X className="w-3.5 h-3.5" />
                </Button>
              </div>
            )}
          </div>
          {rightPanelExport ? (
            <div className="flex-1 flex flex-col gap-1 min-h-0">
              <span className="text-[10px] text-muted-foreground truncate flex-shrink-0">
                {rightPanelExport.label}: {rightPanelExport.clipTitle}
              </span>
              <div className="rounded-md overflow-hidden border flex-1 flex items-start justify-center min-h-0 bg-muted/30">
                <video
                  key={`${rightPanelExport.exportJob.id}-${rightPanelExport.exportJob.outputPath || ""}`}
                  src={`/api/exports/${rightPanelExport.exportJob.id}/stream?t=${rightPanelStreamTs.current}`}
                  controls
                  playsInline
                  className="max-h-[70vh] object-contain"
                  style={{ aspectRatio: "9/16" }}
                  data-testid="video-right-panel"
                />
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-[10px] text-muted-foreground text-center px-4">
                Нажмите «Превью» или «Показано» на клипе
              </p>
            </div>
          )}
        </div>
      </div>

      {calibPreview && (
        <Dialog open={!!calibPreview} onOpenChange={(open) => { if (!open) setCalibPreview(null); }}>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>AI калибровка — превью</DialogTitle>
            </DialogHeader>
            <div className="relative">
              <img
                src={calibPreview.frameUrl}
                alt="Video frame"
                className="w-full rounded-md"
                data-testid="img-calib-preview"
              />
              {(() => {
                const sw = calibPreview.sourceWidth;
                const sh = calibPreview.sourceHeight;
                const pctX = (v: number) => `${(v / sw) * 100}%`;
                const pctY = (v: number) => `${(v / sh) * 100}%`;
                const pctW = (v: number) => `${(v / sw) * 100}%`;
                const pctH = (v: number) => `${(v / sh) * 100}%`;
                return (
                  <>
                    <div
                      style={{
                        position: "absolute",
                        left: pctX(calibPreview.table.x),
                        top: pctY(calibPreview.table.y),
                        width: pctW(calibPreview.table.width),
                        height: pctH(calibPreview.table.height),
                        border: "2px solid #22c55e",
                        borderRadius: "4px",
                        pointerEvents: "none",
                      }}
                      data-testid="box-table"
                    >
                      <span className="absolute -top-5 left-0 text-xs font-medium bg-green-600 text-white px-1 rounded">
                        Стол
                      </span>
                    </div>
                    <div
                      style={{
                        position: "absolute",
                        left: pctX(calibPreview.webcam.x),
                        top: pctY(calibPreview.webcam.y),
                        width: pctW(calibPreview.webcam.width),
                        height: pctH(calibPreview.webcam.height),
                        border: "2px solid #3b82f6",
                        borderRadius: "4px",
                        pointerEvents: "none",
                      }}
                      data-testid="box-webcam"
                    >
                      <span className="absolute -top-5 left-0 text-xs font-medium bg-blue-600 text-white px-1 rounded">
                        Вебкамера
                      </span>
                    </div>
                  </>
                );
              })()}
            </div>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground">Время (сек):</label>
                <Input
                  className="w-20"
                  value={calibPreviewTime}
                  onChange={(e) => setCalibPreviewTime(e.target.value)}
                  data-testid="input-calib-time"
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={calibPreviewLoading}
                  onClick={() => runCalibPreview(calibPreviewTime)}
                  data-testid="button-calib-rerun"
                >
                  {calibPreviewLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3 mr-1" />}
                  Пересканировать
                </Button>
              </div>
              <div className="text-xs text-muted-foreground font-mono">
                Стол: {calibPreview.table.x},{calibPreview.table.y} {calibPreview.table.width}x{calibPreview.table.height} |
                Кам: {calibPreview.webcam.x},{calibPreview.webcam.y} {calibPreview.webcam.width}x{calibPreview.webcam.height}
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {previewClip && (
        <ClipEditorDialog
          key={previewClip.id}
          open={!!previewClip}
          onOpenChange={(open) => { if (!open) setPreviewClip(null); }}
          videoSrc={videoSrc}
          fallbackVideoSrc={videoSrc}
          videoDuration={video?.duration || 0}
          initialStart={previewClip.adjustedStartTime ?? previewClip.startTime}
          initialEnd={previewClip.adjustedEndTime ?? previewClip.endTime}
          title={previewClip.title || undefined}
          onSave={(startTime, endTime) => {
            saveTimeMutation.mutate({ clipId: previewClip.id, startTime, endTime });
          }}
          onApproveAndSave={(startTime, endTime) => {
            approveMutation.mutate({ clipId: previewClip.id, startTime, endTime });
          }}
          onPreviewExport={async (startTime, endTime) => {
            saveTimeMutation.mutate({ clipId: previewClip.id, startTime, endTime });
            exportMutation.mutate({ clipId: previewClip.id, isPreview: true, overrideStartTime: startTime, overrideEndTime: endTime });
          }}
          onFullExport={async (startTime, endTime) => {
            saveTimeMutation.mutate({ clipId: previewClip.id, startTime, endTime });
            exportMutation.mutate({ clipId: previewClip.id, overrideStartTime: startTime, overrideEndTime: endTime });
          }}
          onAiCalibrate={(time) => runCalibPreview(String(time))}
          onManualCalibrate={selectedProfileId ? (time) => {
            setCalibrationFrameTime(time);
            setCalibrationClipId(previewClip.id);
            setCalibrationOpen(true);
          } : undefined}
          isApproved={previewClip.status === "approved"}
          hasCalibration={!!selectedProfile?.calibration}
          isExporting={exportMutation.isPending}
          transcriptSegments={transcriptSegments}
          onRewhisper={() => rewhisperMutation.mutate({ mode: "highlights", transcribeOnly: true })}
          isRewhispering={rewhisperMutation.isPending}
          videoId={videoId}
          contentType={video?.contentType || "poker"}
          calibration={selectedProfile?.calibration as any}
          onTranscriptSave={(segments) => {
            apiRequest("PATCH", `/api/videos/${videoId}/transcript`, { segments })
              .then(() => {
                queryClient.invalidateQueries({ queryKey: ["/api/videos", videoId] });
                toast({ title: "Транскрипция сохранена" });
              })
              .catch((err: any) => toast({ title: "Ошибка", description: err.message, variant: "destructive" }));
          }}
          exportSettings={{
            uniqualize,
            setUniqualize,
            filterPreset,
            setFilterPreset,
            videoFilter,
            setVideoFilter: (v: string) => { setVideoFilter(v); try { localStorage.setItem("videoFilter", v); } catch {} },
            muteAudio,
            setMuteAudio,
            bleepProfanity,
            setBleepProfanity,
            bgAudioFilename,
            setBgAudioFilename,
            bgAudioVolume,
            setBgAudioVolume,
            sounds: soundsData?.sounds?.map(s => ({ id: s.id, filename: s.filename })) || [],
            resolution,
            setResolution,
            useCrawlCaption,
            setUseCrawlCaption,
            playingSound,
            toggleSoundPreview,
            favoriteSounds,
            musicDropEnabled,
            setMusicDropEnabled: (v: boolean) => { setMusicDropEnabled(v); try { localStorage.setItem("musicDropEnabled", String(v)); } catch {} },
            musicDropTime: musicDropEnabled && previewClip?.dropTime != null ? previewClip.dropTime : null,
            setMusicDropTime: () => {},
            musicDropVolumeBefore,
            setMusicDropVolumeBefore: (v: number) => { setMusicDropVolumeBefore(v); try { localStorage.setItem("musicDropVolumeBefore", String(v)); } catch {} },
            musicStartOffset,
            setMusicStartOffset: (v: number) => { setMusicStartOffset(v); try { localStorage.setItem("musicStartOffset", String(v)); } catch {} },
            voiceVolume,
            setVoiceVolume: (v: number) => { setVoiceVolume(v); try { localStorage.setItem("voiceVolume", String(v)); } catch {} },
            captionPositionY,
            setCaptionPositionY: (v: number) => { setCaptionPositionY(v); try { localStorage.setItem("captionPositionY", String(v)); } catch {} },
            subtitleOffsetMs,
            setSubtitleOffsetMs: (v: number) => { setSubtitleOffsetMs(v); try { localStorage.setItem("subtitleOffsetMs", String(v)); } catch {} },
            captionStyle,
            setCaptionStyle: (v: "classic" | "mrbeast" | "glow") => { setCaptionStyle(v); try { localStorage.setItem("captionStyle", v); } catch {} },
          }}
        />
      )}

      {calibrationOpen && selectedProfileId && video.filepath !== "pending" && (
        <CalibrationDialog
          open={calibrationOpen}
          onOpenChange={(open) => {
            setCalibrationOpen(open);
            if (!open) {
              setCalibrationFrameTime(undefined);
              setCalibrationClipId(undefined);
            }
          }}
          videoId={videoId}
          profileId={selectedProfileId}
          clipId={calibrationClipId}
          frameTime={calibrationFrameTime}
          videoDuration={video.duration ?? undefined}
          onSave={() => {}}
          contentType={video.contentType || "poker"}
        />
      )}

      

      <Dialog open={showDeletedClips} onOpenChange={setShowDeletedClips}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Корзина удалённых клипов</DialogTitle>
          </DialogHeader>
          <DeletedClipsList videoId={videoId!} onRestored={() => {
            queryClient.invalidateQueries({ queryKey: ["/api/clips", { videoId }] });
            queryClient.invalidateQueries({ queryKey: ["/api/clips/deleted", { videoId }] });
          }} />
        </DialogContent>
      </Dialog>

      <Dialog open={showCookiePasteDialog} onOpenChange={setShowCookiePasteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Вставить YouTube cookies</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              Скопируйте cookies из расширения (например, EditThisCookie или Get cookies.txt) и вставьте сюда. После сохранения нажмите «Повтор».
            </p>
            <Textarea
              data-testid="input-cookies-text-detail"
              value={cookiePasteText}
              onChange={(e) => setCookiePasteText(e.target.value)}
              placeholder={"# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t..."}
              rows={8}
              className="font-mono text-xs"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCookiePasteDialog(false)} data-testid="button-cookies-paste-cancel-detail">
              Отмена
            </Button>
            <Button
              disabled={cookiePasteText.trim().length < 50 || cookiePasting}
              data-testid="button-cookies-paste-confirm-detail"
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
                  toast({ title: "Cookies сохранены", description: data.entries ? `${data.entries} записей` : "Готово. Нажмите «Повтор» для перезагрузки видео" });
                  setShowCookiePasteDialog(false);
                  setCookiePasteText("");
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

      <Dialog open={showVkTokenDialog} onOpenChange={setShowVkTokenDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Подключение VK</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Окно авторизации VK должно было открыться. После входа вас перенаправит на пустую страницу. Скопируйте <strong>весь URL</strong> из адресной строки и вставьте ниже.
            </p>
            <label className="text-sm font-medium">URL после авторизации</label>
            <Input
              data-testid="input-vk-token-url"
              placeholder="https://oauth.vk.com/blank.html#access_token=..."
              value={vkTokenUrl}
              onChange={(e) => setVkTokenUrl(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              URL содержит access_token, user_id и expires_in. Мы извлечём их автоматически.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowVkTokenDialog(false)} data-testid="button-vk-token-cancel">
              Отмена
            </Button>
            <Button
              data-testid="button-vk-token-save"
              onClick={async () => {
                try {
                  const urlStr = vkTokenUrl.trim();
                  const hashPart = urlStr.includes("#") ? urlStr.split("#")[1] : urlStr;
                  const params = new URLSearchParams(hashPart);
                  const accessToken = params.get("access_token");
                  const userId = params.get("user_id") || "";
                  const expiresIn = params.get("expires_in") || null;
                  if (!accessToken) {
                    toast({ title: "Ошибка", description: "Не удалось извлечь access_token из URL", variant: "destructive" });
                    return;
                  }
                  const res = await fetch("/api/social/vk/save-token", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ accessToken, userId, expiresIn }),
                  });
                  const data = await res.json();
                  if (data.success) {
                    toast({ title: "VK подключён", description: data.accountName || "Успешно" });
                    setShowVkTokenDialog(false);
                    setVkTokenUrl("");
                    queryClient.invalidateQueries({ queryKey: ["/api/social/vk/status"] });
                  } else {
                    toast({ title: "Ошибка", description: data.message || "Не удалось подключить", variant: "destructive" });
                  }
                } catch (e: any) {
                  toast({ title: "Ошибка", description: e.message, variant: "destructive" });
                }
              }}
              disabled={!vkTokenUrl.trim()}
            >
              Подключить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={acSocialDialogOpen} onOpenChange={setAcSocialDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Загрузка в {acSocialPlatform === "vk" ? "VK" : acSocialPlatform === "tiktok" ? "TikTok" : acSocialPlatform === "facebook" ? "Facebook" : acSocialPlatform === "threads" ? "Threads" : acSocialPlatform === "youtube" ? "YouTube" : "Instagram"} (AI Авто-нарезка)
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label>Название</Label>
              <Input data-testid="input-ac-social-title" value={acSocialTitle} onChange={(e) => setAcSocialTitle(e.target.value)} placeholder="Название" />
              {(acSocialPlatform !== "youtube") && acSocialWithTags && (
                <p className="text-xs text-muted-foreground">
                  Итого: {acSocialTitle.trim() ? acSocialTitle.trim() + " " : ""}{pokerTags[acSocialPlatform] || ""}
                </p>
              )}
            </div>
            {acSocialPlatform !== "youtube" && (
              <div className="flex items-center gap-2">
                <Checkbox id="ac-social-tags" checked={acSocialWithTags} onCheckedChange={(v) => setAcSocialWithTags(v === true)} data-testid="checkbox-ac-social-tags" />
                <Label htmlFor="ac-social-tags" className="text-sm cursor-pointer">
                  {isPoker ? `Добавить хештеги (${pokerTags[acSocialPlatform] || ""})` : "Добавить хештеги"}
                </Label>
              </div>
            )}
            {acSocialPlatform === "tiktok" && (
              <div className="flex flex-col gap-2">
                <Label>Свои хештеги для TikTok</Label>
                <Input data-testid="input-ac-tiktok-custom-tags" value={acSocialTiktokCustomTags} onChange={(e) => setAcSocialTiktokCustomTags(e.target.value)} placeholder="#хештег1 #хештег2" />
              </div>
            )}
            {acSocialPlatform !== "tiktok" && (
              <div className="flex flex-col gap-2">
                <Label>Описание</Label>
                <Textarea data-testid="input-ac-social-description" value={acSocialDescription} onChange={(e) => setAcSocialDescription(e.target.value)} placeholder="Описание (необязательно)" rows={3} />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAcSocialDialogOpen(false)} data-testid="button-ac-social-cancel">Отмена</Button>
            <Button
              disabled={!!socialUploadingPlatform}
              data-testid="button-ac-social-confirm"
              onClick={() => {
                let finalTitle = acSocialTitle.trim();
                let finalDescription = acSocialDescription.trim();
                if (acSocialWithTags) {
                  const tags = pokerTags[acSocialPlatform] || "";
                  if (tags) {
                    finalTitle = finalTitle ? finalTitle + " " + tags : tags;
                    if (acSocialPlatform !== "tiktok") {
                      finalDescription = finalDescription ? finalDescription + "\n\n" + tags : tags;
                    }
                  }
                }
                if (acSocialPlatform === "tiktok" && acSocialTiktokCustomTags.trim()) {
                  finalTitle = finalTitle + " " + acSocialTiktokCustomTags.trim();
                }
                autoCutSocialUploadMutation.mutate({ platform: acSocialPlatform, cutId: acSocialCutId, title: finalTitle, description: finalDescription });
                setAcSocialDialogOpen(false);
              }}
            >
              {socialUploadingPlatform ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : (
                acSocialPlatform === "youtube" ? <SiYoutube className="w-4 h-4 mr-2 text-red-500" /> :
                acSocialPlatform === "vk" ? <SiVk className="w-4 h-4 mr-2 text-blue-500" /> :
                acSocialPlatform === "tiktok" ? <SiTiktok className="w-4 h-4 mr-2" /> :
                acSocialPlatform === "facebook" ? <SiFacebook className="w-4 h-4 mr-2 text-blue-600" /> :
                acSocialPlatform === "threads" ? <SiThreads className="w-4 h-4 mr-2" /> :
                <SiInstagram className="w-4 h-4 mr-2 text-pink-500" />
              )}
              Загрузить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={acBulkDialogOpen} onOpenChange={setAcBulkDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Загрузка во все соцсети (AI Авто-нарезка)</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label>Название</Label>
              <Input data-testid="input-ac-bulk-title" value={acBulkTitle} onChange={(e) => setAcBulkTitle(e.target.value)} placeholder="Название" />
            </div>
            <div className="flex flex-col gap-2">
              <Label>Описание</Label>
              <Textarea data-testid="input-ac-bulk-description" value={acBulkDescription} onChange={(e) => setAcBulkDescription(e.target.value)} placeholder="Описание (необязательно)" rows={3} />
            </div>
            <div className="flex flex-col gap-2">
              <Label className="text-sm">Хештеги по платформам</Label>
              <div className="flex flex-wrap gap-2">
                {["youtube", "tiktok", "instagram", "facebook", "threads", "vk"].map(p => (
                  <div key={p} className="flex items-center gap-1">
                    <Checkbox id={`ac-bulk-tag-${p}`} checked={acBulkHashtagPlatforms[p] ?? true} onCheckedChange={(v) => setAcBulkHashtagPlatforms(prev => ({ ...prev, [p]: v === true }))} data-testid={`checkbox-ac-bulk-tag-${p}`} />
                    <Label htmlFor={`ac-bulk-tag-${p}`} className="text-xs cursor-pointer">{p === "youtube" ? "YT" : p === "tiktok" ? "TT" : p === "instagram" ? "IG" : p === "facebook" ? "FB" : p.toUpperCase()}</Label>
                  </div>
                ))}
              </div>
            </div>
            {socialStatuses.tiktok?.connected && (
              <div className="flex flex-col gap-2">
                <Label>Свои хештеги для TikTok</Label>
                <Input data-testid="input-ac-bulk-tiktok-tags" value={acBulkTiktokCustomTags} onChange={(e) => setAcBulkTiktokCustomTags(e.target.value)} placeholder="#хештег1 #хештег2" />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAcBulkDialogOpen(false)} data-testid="button-ac-bulk-cancel">Отмена</Button>
            <Button
              disabled={!!acBulkUploadingCutId}
              data-testid="button-ac-bulk-confirm"
              onClick={() => {
                handleAutoCutBulkUpload(acBulkCutId, acBulkTitle.trim(), acBulkDescription.trim(), acBulkHashtagPlatforms, acBulkTiktokCustomTags.trim());
                setAcBulkDialogOpen(false);
              }}
            >
              {acBulkUploadingCutId ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Share2 className="w-4 h-4 mr-2" />}
              Загрузить во все
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
