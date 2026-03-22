import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Film,
  Trash2,
  Loader2,
  Clock,
  CheckCircle2,
  AlertCircle,
  Zap,
  ChevronDown,
  ChevronUp,
  Plus,
} from "lucide-react";
import type { Video, ContentType } from "@shared/schema";
import VideoDetail from "@/pages/video-detail";

interface MainPageProps {
  initialVideoId?: string;
  contentType: ContentType;
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(seconds: number | null) {
  if (!seconds) return "--:--";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function getStatusInfo(video: Video) {
  switch (video.status) {
    case "queued":
      return { label: "В очереди", variant: "secondary" as const, icon: Clock };
    case "uploaded":
      return { label: "Загружено", variant: "secondary" as const, icon: Clock };
    case "processing":
      return {
        label: video.pipelineStep === "downloading" ? "Скачивание" :
          video.pipelineStep === "extracting_audio" ? "Аудио" :
          video.pipelineStep === "vad_chunking" ? "VAD разбивка" :
          video.pipelineStep === "transcribing" ? "Транскрипция" :
          video.pipelineStep === "aligning" ? "Выравнивание" :
          video.pipelineStep === "analyzing" ? "AI анализ" :
          "Обработка",
        variant: "default" as const, icon: Loader2,
      };
    case "analyzed":
      return { label: "Готово", variant: "outline" as const, icon: CheckCircle2 };
    case "error":
      return { label: "Ошибка", variant: "destructive" as const, icon: AlertCircle };
    default:
      return { label: video.status, variant: "secondary" as const, icon: Clock };
  }
}

export default function MainPage({ initialVideoId, contentType }: MainPageProps) {
  const [, setLocation] = useLocation();
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(initialVideoId || null);
  const [dashboardOpen, setDashboardOpen] = useState(!initialVideoId);


  const { data: videos = [], isLoading } = useQuery<Video[]>({
    queryKey: ["/api/videos"],
    queryFn: async () => {
      const res = await fetch("/api/videos");
      if (!res.ok) throw new Error("Failed to fetch videos");
      return res.json();
    },
    refetchInterval: 3000,
  });

  const deleteMutation = useMutation({
    mutationFn: async (videoId: string) => {
      await apiRequest("DELETE", `/api/videos/${videoId}`);
    },
    onSuccess: (_data, videoId) => {
      queryClient.invalidateQueries({ queryKey: ["/api/videos"] });
      if (selectedVideoId === videoId) {
        setSelectedVideoId(null);
        setDashboardOpen(true);
      }
    },
  });

  const processMutation = useMutation({
    mutationFn: async (videoId: string) => {
      await apiRequest("POST", `/api/videos/${videoId}/process`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/videos"] });
    },
  });

  useEffect(() => {
    if (initialVideoId && initialVideoId !== selectedVideoId) {
      setSelectedVideoId(initialVideoId);
      setDashboardOpen(false);
    }
  }, [initialVideoId]);

  const filteredVideos = videos.filter((v) => (v.contentType || "poker") === contentType);

  const sortedVideos = [...filteredVideos].sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  useEffect(() => {
    if (!selectedVideoId && filteredVideos.length > 0 && !initialVideoId) {
      setSelectedVideoId(filteredVideos[0].id);
    }
  }, [filteredVideos, selectedVideoId, initialVideoId]);

  useEffect(() => {
    if (!initialVideoId) {
      setSelectedVideoId(null);
      setDashboardOpen(true);
    }
  }, [contentType]);

  const selectVideo = (videoId: string) => {
    setSelectedVideoId(videoId);
    setDashboardOpen(false);
    setLocation(`/video/${videoId}`, { replace: true });
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="border-b flex-shrink-0 relative">
        <button
          className="flex items-center justify-between w-full px-4 py-2 pr-16"
          onClick={() => setDashboardOpen(!dashboardOpen)}
          data-testid="button-toggle-dashboard"
        >
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <Film className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            <span className="text-xs font-medium flex-shrink-0">Видео</span>
            <Badge variant="secondary" className="text-[10px]">{filteredVideos.length}</Badge>
            {selectedVideoId && !dashboardOpen && (() => {
              const v = videos.find(v => v.id === selectedVideoId);
              if (!v) return null;
              const name = v.youtubeUrl
                ? v.originalName.replace(/^https?:\/\/(www\.)?/, "")
                : v.originalName;
              const dur = v.duration ? `${Math.floor(v.duration / 60)}:${String(Math.floor(v.duration % 60)).padStart(2, "0")}` : null;
              const res = v.width && v.height ? `${v.width}x${v.height}` : null;
              return (
                <>
                  <span className="text-xs text-muted-foreground truncate max-w-[400px]">
                    — {name}
                  </span>
                  {dur && <span className="text-[10px] text-muted-foreground font-mono flex-shrink-0">{dur}</span>}
                  {res && <span className="text-[10px] text-muted-foreground font-mono flex-shrink-0">{res}</span>}
                </>
              );
            })()}
          </div>
          {dashboardOpen ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
        </button>
        {dashboardOpen && (
          <div className="px-4 pb-3 space-y-1.5 max-h-[40vh] overflow-auto">
            {isLoading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              </div>
            ) : sortedVideos.length === 0 ? (
              <div className="text-center py-6">
                <Film className="w-6 h-6 mx-auto text-muted-foreground mb-2" />
                <p className="text-xs text-muted-foreground">Нет видео</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => setLocation("/new")}
                  data-testid="button-first-job"
                >
                  <Plus className="w-3 h-3 mr-1" />
                  Загрузить первое видео
                </Button>
              </div>
            ) : (
              sortedVideos.map((video) => {
                const statusInfo = getStatusInfo(video);
                const StatusIcon = statusInfo.icon;
                const isProcessing = video.status === "processing";
                const needsProcessing = video.status === "uploaded" || video.status === "queued";
                const isSelected = video.id === selectedVideoId;

                return (
                  <div
                    key={video.id}
                    className={`flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer transition-colors ${
                      isSelected ? "bg-accent" : "hover-elevate"
                    }`}
                    onClick={() => selectVideo(video.id)}
                    data-testid={`row-video-${video.id}`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium truncate" data-testid={`text-video-name-${video.id}`}>
                        {video.youtubeUrl ? video.originalName.replace(/^https?:\/\/(www\.)?/, "") : video.originalName}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {formatDuration(video.duration)}
                        </span>
                        {video.width && video.height && (
                          <span className="text-[10px] text-muted-foreground font-mono">
                            {video.width}x{video.height}
                          </span>
                        )}
                        {video.fileSize && (
                          <span className="text-[10px] text-muted-foreground font-mono">
                            {formatBytes(video.fileSize)}
                          </span>
                        )}
                        <Badge variant={statusInfo.variant} className="text-[10px]">
                          <StatusIcon className={`w-2.5 h-2.5 mr-0.5 ${isProcessing ? "animate-spin" : ""}`} />
                          {statusInfo.label}
                        </Badge>
                      </div>
                      {isProcessing && video.pipelineProgress !== null && (
                        <Progress value={video.pipelineProgress ?? 0} className="h-1 mt-1 max-w-[150px]" />
                      )}
                    </div>

                    <div className="flex items-center gap-0.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                      {needsProcessing && (
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => processMutation.mutate(video.id)}
                          disabled={processMutation.isPending}
                          data-testid={`button-process-${video.id}`}
                        >
                          <Zap className="w-3 h-3 mr-1" />
                          Запуск
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => {
                          if (confirm("Удалить видео?")) deleteMutation.mutate(video.id);
                        }}
                        data-testid={`button-delete-${video.id}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {selectedVideoId ? (
        <VideoDetail videoId={selectedVideoId} />
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <Film className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">Выберите видео или загрузите новое</p>
            <Button
              variant="outline"
              className="mt-3"
              onClick={() => setLocation("/new")}
              data-testid="button-upload-cta"
            >
              <Plus className="w-4 h-4 mr-2" />
              Загрузить видео
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
