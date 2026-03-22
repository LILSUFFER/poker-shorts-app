import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ArrowLeft,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Scissors,
  Plus,
  CheckCircle2,
  ZoomIn,
  ZoomOut,
  Loader2,
  Volume2,
  VolumeX,
  Search,
  ChevronRight,
} from "lucide-react";
import type { Video, SuggestedClip, TranscriptSegment } from "@shared/schema";

interface VideoEditorProps {
  videoId: string;
}

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(2, "0")}`;
}

function fmtShort(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const CLIP_COLORS = [
  "rgba(234, 179, 8, 0.6)",
  "rgba(59, 130, 246, 0.6)",
  "rgba(168, 85, 247, 0.6)",
  "rgba(34, 197, 94, 0.6)",
  "rgba(239, 68, 68, 0.6)",
  "rgba(236, 72, 153, 0.6)",
  "rgba(14, 165, 233, 0.6)",
  "rgba(249, 115, 22, 0.6)",
];

export default function VideoEditor({ videoId }: VideoEditorProps) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<number>(0);
  const activeSegmentRef = useRef<HTMLDivElement>(null);
  const [tlContainerWidth, setTlContainerWidth] = useState(800);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [zoom, setZoom] = useState(1);

  const [selectionStart, setSelectionStart] = useState<number | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState<"start" | "end" | "playhead" | "selection" | null>(null);
  const dragStartRef = useRef<{ mouseX: number; time: number; selStart?: number; selEnd?: number }>({ mouseX: 0, time: 0 });

  const [clipTitle, setClipTitle] = useState("");
  const [activeSegmentIdx, setActiveSegmentIdx] = useState(-1);
  const [transcriptSearch, setTranscriptSearch] = useState("");

  const { data: video, isLoading } = useQuery<Video>({
    queryKey: ["/api/videos", videoId],
    queryFn: async () => {
      const res = await fetch(`/api/videos/${videoId}`);
      if (!res.ok) throw new Error("Failed to fetch video");
      return res.json();
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

  const { data: clips = [] } = useQuery<SuggestedClip[]>({
    queryKey: ["/api/clips", { videoId }],
    queryFn: async () => {
      const res = await fetch(`/api/clips?videoId=${videoId}`);
      if (!res.ok) throw new Error("Failed to fetch clips");
      return res.json();
    },
    enabled: !!video,
  });

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
      setSelectionStart(null);
      setSelectionEnd(null);
      setClipTitle("");
      toast({ title: "Клип создан" });
    },
    onError: (error: Error) => {
      toast({ title: "Ошибка", description: error.message, variant: "destructive" });
    },
  });

  const segments: TranscriptSegment[] = useMemo(
    () => (video?.transcriptionSegments as TranscriptSegment[]) || [],
    [video?.transcriptionSegments]
  );

  const filteredSegments = useMemo(() => {
    if (!transcriptSearch.trim()) return segments;
    const q = transcriptSearch.toLowerCase();
    return segments.filter((s) => s.text.toLowerCase().includes(q));
  }, [segments, transcriptSearch]);

  useEffect(() => {
    if (video?.duration) setDuration(video.duration);
  }, [video?.duration]);

  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setTlContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    setTlContainerWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const updateTime = useCallback(() => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
    animRef.current = requestAnimationFrame(updateTime);
  }, []);

  useEffect(() => {
    animRef.current = requestAnimationFrame(updateTime);
    return () => cancelAnimationFrame(animRef.current);
  }, [updateTime]);

  useEffect(() => {
    if (segments.length > 0) {
      const idx = segments.findIndex(
        (s) => currentTime >= s.start && currentTime < s.end
      );
      if (idx !== activeSegmentIdx) {
        setActiveSegmentIdx(idx);
      }
    }
  }, [currentTime, segments, activeSegmentIdx]);

  useEffect(() => {
    if (activeSegmentRef.current && !transcriptSearch.trim()) {
      activeSegmentRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeSegmentIdx, transcriptSearch]);

  const togglePlay = useCallback(() => {
    if (!videoRef.current) return;
    if (playing) {
      videoRef.current.pause();
    } else {
      videoRef.current.play().catch(() => {});
    }
    setPlaying(!playing);
  }, [playing]);

  const seekTo = useCallback((t: number) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = Math.max(0, Math.min(t, duration));
    setCurrentTime(videoRef.current.currentTime);
  }, [duration]);

  const skip = useCallback((delta: number) => {
    seekTo(currentTime + delta);
  }, [currentTime, seekTo]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement)?.isContentEditable) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          skip(e.shiftKey ? -5 : -1);
          break;
        case "ArrowRight":
          e.preventDefault();
          skip(e.shiftKey ? 5 : 1);
          break;
        case "i":
        case "I":
          setSelectionStart(currentTime);
          break;
        case "o":
        case "O":
          setSelectionEnd(currentTime);
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [togglePlay, skip, currentTime]);

  const timelineWidth = useMemo(() => {
    return Math.max(tlContainerWidth * zoom, tlContainerWidth);
  }, [zoom, tlContainerWidth]);

  const pxPerSec = useMemo(() => {
    return duration > 0 ? timelineWidth / duration : 1;
  }, [timelineWidth, duration]);

  const timeToPx = useCallback((t: number) => t * pxPerSec, [pxPerSec]);
  const pxToTime = useCallback((px: number) => px / pxPerSec, [pxPerSec]);

  const timelineMarkers = useMemo(() => {
    if (duration <= 0) return [];
    let interval = 5;
    if (pxPerSec > 20) interval = 1;
    else if (pxPerSec > 10) interval = 2;
    else if (pxPerSec > 4) interval = 5;
    else if (pxPerSec > 1.5) interval = 15;
    else if (pxPerSec > 0.5) interval = 30;
    else interval = 60;

    const marks: { time: number; major: boolean }[] = [];
    for (let t = 0; t <= duration; t += interval) {
      marks.push({ time: t, major: t % (interval * 5) === 0 || interval >= 30 });
    }
    return marks;
  }, [duration, pxPerSec]);

  const handleTimelineClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (isDragging) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const scrollEl = timelineRef.current;
      const x = e.clientX - rect.left + (scrollEl?.scrollLeft || 0);
      const t = pxToTime(x);
      seekTo(t);
    },
    [isDragging, pxToTime, seekTo]
  );

  const handleMouseDown = useCallback(
    (type: "start" | "end" | "playhead" | "selection", e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      setIsDragging(type);
      dragStartRef.current = {
        mouseX: e.clientX,
        time: currentTime,
        selStart: selectionStart ?? undefined,
        selEnd: selectionEnd ?? undefined,
      };
    },
    [currentTime, selectionStart, selectionEnd]
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMove = (e: MouseEvent) => {
      const scrollEl = timelineRef.current;
      if (!scrollEl) return;
      const rect = scrollEl.getBoundingClientRect();
      const x = e.clientX - rect.left + scrollEl.scrollLeft;
      const t = Math.max(0, Math.min(pxToTime(x), duration));

      if (isDragging === "playhead") {
        seekTo(t);
      } else if (isDragging === "start") {
        setSelectionStart(Math.min(t, selectionEnd ?? duration));
      } else if (isDragging === "end") {
        setSelectionEnd(Math.max(t, selectionStart ?? 0));
      } else if (isDragging === "selection") {
        const dx = e.clientX - dragStartRef.current.mouseX;
        const dt = pxToTime(dx) - pxToTime(0);
        const s = (dragStartRef.current.selStart ?? 0) + dt;
        const en = (dragStartRef.current.selEnd ?? 0) + dt;
        const dur = en - s;
        const clampedS = Math.max(0, Math.min(s, duration - dur));
        setSelectionStart(clampedS);
        setSelectionEnd(clampedS + dur);
      }
    };

    const handleUp = () => setIsDragging(null);

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [isDragging, pxToTime, seekTo, selectionStart, selectionEnd, duration]);

  useEffect(() => {
    const el = timelineRef.current;
    if (!el || !playing) return;
    const playheadPx = timeToPx(currentTime);
    const visibleLeft = el.scrollLeft;
    const visibleRight = visibleLeft + el.clientWidth;
    if (playheadPx > visibleRight - 50 || playheadPx < visibleLeft) {
      el.scrollLeft = playheadPx - 100;
    }
  }, [currentTime, playing, timeToPx]);

  const handleCreateClip = useCallback(() => {
    if (selectionStart === null || selectionEnd === null) return;
    const s = Math.min(selectionStart, selectionEnd);
    const e = Math.max(selectionStart, selectionEnd);
    if (e - s < 3) return;
    createClipMutation.mutate({ startTime: s, endTime: e, title: clipTitle || undefined });
  }, [selectionStart, selectionEnd, clipTitle, createClipMutation]);

  const selDuration =
    selectionStart !== null && selectionEnd !== null
      ? Math.abs(selectionEnd - selectionStart)
      : 0;

  if (isLoading) {
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

  return (
    <div className="flex flex-col h-[calc(100vh-45px)] overflow-hidden" data-testid="video-editor">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b bg-card/30 flex-shrink-0">
        <Button
          size="icon"
          variant="ghost"
          onClick={() => setLocation(`/video/${videoId}`)}
          data-testid="button-editor-back"
        >
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <span className="text-sm font-medium truncate flex-1" data-testid="text-editor-title">
          {video.originalName || video.filename}
        </span>
        <Badge variant="outline" className="text-xs font-mono">
          {fmt(currentTime)} / {fmtShort(duration)}
        </Badge>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-col flex-1 min-w-0">
          <div className="flex-1 flex items-center justify-center bg-black min-h-0 p-2">
            <video
              ref={videoRef}
              src={videoSrc}
              className="max-w-full max-h-full rounded"
              muted={muted}
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                if (v.duration && isFinite(v.duration)) setDuration(v.duration);
              }}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              data-testid="editor-video-player"
            />
          </div>

          <div className="flex items-center justify-center gap-1 py-1.5 border-t bg-card/20 flex-shrink-0">
            <Button size="icon" variant="ghost" onClick={() => skip(-5)} data-testid="button-skip-back-5">
              <SkipBack className="w-4 h-4" />
            </Button>
            <Button size="icon" variant="ghost" onClick={() => skip(-1)} data-testid="button-skip-back-1">
              <ArrowLeft className="w-3.5 h-3.5" />
            </Button>
            <Button size="icon" variant={playing ? "secondary" : "default"} onClick={togglePlay} data-testid="button-play-pause">
              {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            </Button>
            <Button size="icon" variant="ghost" onClick={() => skip(1)} data-testid="button-skip-fwd-1">
              <ChevronRight className="w-3.5 h-3.5" />
            </Button>
            <Button size="icon" variant="ghost" onClick={() => skip(5)} data-testid="button-skip-fwd-5">
              <SkipForward className="w-4 h-4" />
            </Button>
            <div className="w-px h-5 bg-border mx-1" />
            <Button size="icon" variant="ghost" onClick={() => setMuted(!muted)} data-testid="button-mute">
              {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </Button>
            <div className="w-px h-5 bg-border mx-1" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setSelectionStart(currentTime)}
                  data-testid="button-set-in"
                >
                  <span className="text-xs font-bold">I</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Начало выделения (I)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setSelectionEnd(currentTime)}
                  data-testid="button-set-out"
                >
                  <span className="text-xs font-bold">O</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Конец выделения (O)</TooltipContent>
            </Tooltip>
            {selectionStart !== null && selectionEnd !== null && selDuration >= 3 && (
              <>
                <div className="w-px h-5 bg-border mx-1" />
                <Badge variant="outline" className="text-xs font-mono">
                  {fmtShort(Math.min(selectionStart, selectionEnd))} - {fmtShort(Math.max(selectionStart, selectionEnd))}
                  ({Math.round(selDuration)}с)
                </Badge>
                <Input
                  placeholder="Название клипа..."
                  value={clipTitle}
                  onChange={(e) => setClipTitle(e.target.value)}
                  className="w-40 h-8 text-xs"
                  data-testid="input-clip-title"
                />
                <Button
                  size="sm"
                  onClick={handleCreateClip}
                  disabled={createClipMutation.isPending}
                  data-testid="button-create-clip"
                >
                  {createClipMutation.isPending ? (
                    <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  ) : (
                    <Scissors className="w-3 h-3 mr-1" />
                  )}
                  Вырезать
                </Button>
              </>
            )}
          </div>

          <div className="border-t flex-shrink-0 bg-card/10">
            <div className="flex items-center gap-1 px-2 py-1">
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setZoom(Math.max(1, zoom / 1.5))}
                data-testid="button-zoom-out"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </Button>
              <span className="text-xs text-muted-foreground font-mono w-10 text-center">{zoom.toFixed(1)}x</span>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setZoom(Math.min(50, zoom * 1.5))}
                data-testid="button-zoom-in"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </Button>
            </div>

            <div
              ref={timelineRef}
              className="overflow-x-auto overflow-y-hidden relative cursor-crosshair select-none"
              style={{ height: 120 }}
              onClick={handleTimelineClick}
              data-testid="timeline-container"
            >
              <div style={{ width: timelineWidth, height: "100%", position: "relative" }}>
                <div className="absolute top-0 left-0 right-0" style={{ height: 20 }}>
                  {timelineMarkers.map((m) => (
                    <div
                      key={m.time}
                      className="absolute top-0"
                      style={{ left: timeToPx(m.time) }}
                    >
                      <div
                        className={m.major ? "bg-muted-foreground/60" : "bg-muted-foreground/25"}
                        style={{ width: 1, height: m.major ? 14 : 8 }}
                      />
                      {m.major && (
                        <span
                          className="absolute text-[9px] text-muted-foreground font-mono whitespace-nowrap"
                          style={{ top: 14, left: 2 }}
                        >
                          {fmtShort(m.time)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>

                <div className="absolute left-0 right-0" style={{ top: 28, height: 20 }}>
                  {clips.map((clip, i) => {
                    const s = clip.adjustedStartTime ?? clip.startTime;
                    const e = clip.adjustedEndTime ?? clip.endTime;
                    return (
                      <Tooltip key={clip.id}>
                        <TooltipTrigger asChild>
                          <div
                            className="absolute rounded-sm cursor-pointer hover:brightness-125 transition-all"
                            style={{
                              left: timeToPx(s),
                              width: Math.max(timeToPx(e - s), 4),
                              top: 0,
                              height: 18,
                              backgroundColor: CLIP_COLORS[i % CLIP_COLORS.length],
                              border: `1px solid ${CLIP_COLORS[i % CLIP_COLORS.length].replace("0.6", "1")}`,
                            }}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              seekTo(s);
                            }}
                            data-testid={`timeline-clip-${clip.id}`}
                          >
                            <span className="text-[8px] text-white font-medium px-0.5 truncate block leading-[16px]">
                              {clip.title || fmtShort(s)}
                            </span>
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>
                          {clip.title || "Клип"} ({fmtShort(s)} - {fmtShort(e)}, {Math.round(e - s)}с)
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>

                {selectionStart !== null && selectionEnd !== null && (
                  <div
                    className="absolute cursor-move"
                    style={{
                      left: timeToPx(Math.min(selectionStart, selectionEnd)),
                      width: Math.max(timeToPx(Math.abs(selectionEnd - selectionStart)), 2),
                      top: 50,
                      height: 30,
                      backgroundColor: "rgba(234, 179, 8, 0.25)",
                      borderTop: "2px solid rgb(234, 179, 8)",
                      borderBottom: "2px solid rgb(234, 179, 8)",
                    }}
                    onMouseDown={(e) => handleMouseDown("selection", e)}
                    data-testid="selection-region"
                  >
                    <div
                      className="absolute -left-1 top-0 bottom-0 w-2 cursor-ew-resize"
                      style={{ backgroundColor: "rgb(234, 179, 8)", borderRadius: 2 }}
                      onMouseDown={(e) => handleMouseDown("start", e)}
                      data-testid="selection-handle-start"
                    />
                    <div
                      className="absolute -right-1 top-0 bottom-0 w-2 cursor-ew-resize"
                      style={{ backgroundColor: "rgb(234, 179, 8)", borderRadius: 2 }}
                      onMouseDown={(e) => handleMouseDown("end", e)}
                      data-testid="selection-handle-end"
                    />
                  </div>
                )}

                {segments.length > 0 && (
                  <div className="absolute left-0 right-0" style={{ top: 85, height: 30 }}>
                    {segments.map((seg, i) => (
                      <div
                        key={i}
                        className="absolute rounded-[2px] overflow-hidden"
                        style={{
                          left: timeToPx(seg.start),
                          width: Math.max(timeToPx(seg.end - seg.start), 1),
                          top: 0,
                          height: 28,
                          backgroundColor:
                            activeSegmentIdx === i
                              ? "rgba(59, 130, 246, 0.35)"
                              : "rgba(100, 116, 139, 0.15)",
                        }}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          seekTo(seg.start);
                        }}
                        data-testid={`timeline-segment-${i}`}
                      >
                        <span className="text-[7px] text-muted-foreground px-0.5 truncate block leading-[28px]">
                          {seg.text.slice(0, 30)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <div
                  className="absolute top-0 bottom-0 z-10 cursor-col-resize"
                  style={{
                    left: timeToPx(currentTime) - 1,
                    width: 2,
                    backgroundColor: "rgb(239, 68, 68)",
                  }}
                  onMouseDown={(e) => handleMouseDown("playhead", e)}
                  data-testid="playhead"
                >
                  <div
                    style={{
                      position: "absolute",
                      top: -2,
                      left: -5,
                      width: 12,
                      height: 12,
                      backgroundColor: "rgb(239, 68, 68)",
                      borderRadius: "50% 50% 50% 0",
                      transform: "rotate(-45deg)",
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="w-72 border-l flex flex-col bg-card/20 flex-shrink-0">
          <div className="px-3 py-2 border-b flex-shrink-0">
            <h3 className="text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wide">
              Клипы ({clips.length})
            </h3>
            <div className="space-y-1 max-h-40 overflow-auto">
              {clips.length === 0 && (
                <p className="text-xs text-muted-foreground">Нет клипов. Выделите область на таймлайне для создания.</p>
              )}
              {clips.map((clip, i) => {
                const s = clip.adjustedStartTime ?? clip.startTime;
                const e = clip.adjustedEndTime ?? clip.endTime;
                return (
                  <div
                    key={clip.id}
                    className="flex items-center gap-1.5 py-1 px-1.5 rounded-md hover-elevate cursor-pointer text-xs"
                    onClick={() => seekTo(s)}
                    data-testid={`sidebar-clip-${clip.id}`}
                  >
                    <div
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: CLIP_COLORS[i % CLIP_COLORS.length] }}
                    />
                    <span className="font-mono text-muted-foreground flex-shrink-0">{fmtShort(s)}</span>
                    <span className="truncate flex-1">{clip.title || `Клип ${i + 1}`}</span>
                    <Badge variant={clip.status === "approved" ? "default" : "secondary"} className="text-[9px] flex-shrink-0">
                      {Math.round(e - s)}с
                    </Badge>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="px-3 py-2 border-b flex-shrink-0">
            <h3 className="text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wide">
              Горячие клавиши
            </h3>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
              <span>Пробел</span><span>Играть/Пауза</span>
              <span>I</span><span>Начало выделения</span>
              <span>O</span><span>Конец выделения</span>
              <span>←/→</span><span>±1 сек</span>
              <span>Shift+←/→</span><span>±5 сек</span>
            </div>
          </div>

          <div className="flex-1 flex flex-col min-h-0 px-3 py-2">
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Транскрипт
              </h3>
              <Badge variant="outline" className="text-[9px]">{segments.length}</Badge>
            </div>
            {segments.length > 0 && (
              <div className="relative mb-1.5">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
                <Input
                  placeholder="Поиск..."
                  value={transcriptSearch}
                  onChange={(e) => setTranscriptSearch(e.target.value)}
                  className="pl-7 h-7 text-xs"
                  data-testid="input-editor-transcript-search"
                />
              </div>
            )}
            <ScrollArea className="flex-1">
              <div className="space-y-0.5 pr-2">
                {filteredSegments.map((seg, i) => {
                  const isActive = segments.indexOf(seg) === activeSegmentIdx;
                  return (
                    <div
                      key={i}
                      ref={isActive ? activeSegmentRef : undefined}
                      className={`flex gap-1.5 py-1 px-1.5 rounded-md cursor-pointer hover-elevate ${
                        isActive ? "bg-primary/10" : ""
                      }`}
                      onClick={() => seekTo(seg.start)}
                      data-testid={`editor-segment-${i}`}
                    >
                      <span className="text-[10px] text-muted-foreground font-mono whitespace-nowrap min-w-[36px]">
                        {fmtShort(seg.start)}
                      </span>
                      <span className="text-[11px] leading-relaxed">{seg.text}</span>
                    </div>
                  );
                })}
                {segments.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-4">
                    Транскрипт не доступен. Запустите анализ видео.
                  </p>
                )}
              </div>
            </ScrollArea>
          </div>
        </div>
      </div>
    </div>
  );
}
