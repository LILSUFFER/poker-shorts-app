import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
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
  ExternalLink,
} from "lucide-react";
import type { Video } from "@shared/schema";

function VideoThumbnail({ videoId, hasThumbnail }: { videoId: string; hasThumbnail: boolean }) {
  const [failed, setFailed] = useState(false);

  if (!hasThumbnail || failed) {
    return (
      <div className="w-16 h-10 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
        <Film className="w-4 h-4 text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="w-16 h-10 rounded-md bg-muted flex items-center justify-center flex-shrink-0 overflow-hidden">
      <img
        src={`/api/files/thumbnail/${videoId}`}
        alt=""
        className="w-full h-full object-cover"
        data-testid={`img-thumb-${videoId}`}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function Dashboard() {
  const [, setLocation] = useLocation();

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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/videos"] });
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

  const getStatusInfo = (video: Video) => {
    switch (video.status) {
      case "queued":
        return { label: "В очереди", variant: "secondary" as const, icon: Clock };
      case "uploaded":
        return { label: "Загружено", variant: "secondary" as const, icon: Clock };
      case "processing":
        return { label: video.pipelineStep === "downloading" ? "Скачивание" :
          video.pipelineStep === "extracting_audio" ? "Извлечение аудио" :
          video.pipelineStep === "vad_chunking" ? "VAD разбивка" :
          video.pipelineStep === "transcribing" ? "Транскрипция" :
          video.pipelineStep === "aligning" ? "Выравнивание" :
          video.pipelineStep === "analyzing" ? "AI анализ" :
          "Обработка", variant: "default" as const, icon: Loader2 };
      case "analyzed":
        return { label: "Готово", variant: "outline" as const, icon: CheckCircle2 };
      case "error":
        return { label: "Ошибка", variant: "destructive" as const, icon: AlertCircle };
      default:
        return { label: video.status, variant: "secondary" as const, icon: Clock };
    }
  };

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return "--:--";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  const sortedVideos = [...videos].sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-medium tracking-tight" data-testid="text-dashboard-title">
              Dashboard
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {videos.length} {videos.length === 1 ? "видео" : "видео"} в обработке
            </p>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : sortedVideos.length === 0 ? (
          <Card>
            <CardContent className="py-16 text-center">
              <Film className="w-8 h-8 mx-auto text-muted-foreground mb-3" />
              <p className="text-muted-foreground text-sm">Нет видео</p>
              <Button
                variant="outline"
                className="mt-4"
                onClick={() => setLocation("/new")}
                data-testid="button-first-job"
              >
                <Zap className="w-4 h-4 mr-2" />
                Создать первую задачу
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {sortedVideos.map((video) => {
              const statusInfo = getStatusInfo(video);
              const StatusIcon = statusInfo.icon;
              const isProcessing = video.status === "processing";
              const needsProcessing = video.status === "uploaded" || video.status === "queued";

              return (
                <Card
                  key={video.id}
                  className="hover-elevate cursor-pointer"
                  onClick={() => setLocation(`/video/${video.id}`)}
                  data-testid={`card-video-${video.id}`}
                >
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <VideoThumbnail videoId={video.id} hasThumbnail={!!video.thumbnailPath} />
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-sm truncate" data-testid={`text-video-name-${video.id}`}>
                            {video.youtubeUrl ? video.originalName.replace(/^https?:\/\/(www\.)?/, "") : video.originalName}
                          </p>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            <span className="text-xs text-muted-foreground font-mono">
                              {formatDuration(video.duration)}
                            </span>
                            {video.width && video.height && (
                              <span className="text-xs text-muted-foreground font-mono">
                                {video.width}x{video.height}
                              </span>
                            )}
                            {video.fileSize && (
                              <span className="text-xs text-muted-foreground font-mono">
                                {formatBytes(video.fileSize)}
                              </span>
                            )}
                            {video.youtubeUrl && (
                              <Badge variant="secondary" className="text-xs">YT</Badge>
                            )}
                            <Badge variant={statusInfo.variant}>
                              <StatusIcon className={`w-3 h-3 mr-1 ${isProcessing ? "animate-spin" : ""}`} />
                              {statusInfo.label}
                            </Badge>
                          </div>
                          {isProcessing && video.pipelineProgress !== null && (
                            <div className="mt-2 max-w-[200px]">
                              <Progress value={video.pipelineProgress ?? 0} className="h-1" />
                            </div>
                          )}
                          {video.pipelineError && (
                            <p className="text-xs text-destructive mt-1 truncate">{video.pipelineError}</p>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
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
                        {video.youtubeUrl && (
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => window.open(video.youtubeUrl!, "_blank")}
                            data-testid={`button-yt-link-${video.id}`}
                          >
                            <ExternalLink className="w-4 h-4" />
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => deleteMutation.mutate(video.id)}
                          data-testid={`button-delete-${video.id}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
