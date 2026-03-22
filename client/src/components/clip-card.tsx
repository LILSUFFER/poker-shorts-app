import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Check, X, Download, ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import type { SuggestedClip, Video } from "@shared/schema";

interface ClipCardProps {
  clip: SuggestedClip;
  video?: Video;
  onExport: () => void;
}

export default function ClipCard({ clip, video, onExport }: ClipCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [trimRange, setTrimRange] = useState<[number, number]>([clip.startTime, clip.endTime]);

  const approveMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", `/api/clips/${clip.id}`, {
        status: "approved",
        adjustedStartTime: trimRange[0],
        adjustedEndTime: trimRange[1],
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clips"] });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", `/api/clips/${clip.id}`, {
        status: "rejected",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clips"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/clips/${clip.id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clips"] });
    },
  });

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  const duration = clip.endTime - clip.startTime;
  const confidenceColor =
    clip.confidence >= 0.7
      ? "text-green-500 dark:text-green-400"
      : clip.confidence >= 0.4
        ? "text-yellow-500 dark:text-yellow-400"
        : "text-red-500 dark:text-red-400";

  const reasons = clip.reasons as string[];
  const signals = clip.signals as Record<string, number>;

  return (
    <Card data-testid={`card-clip-${clip.id}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium" data-testid={`text-clip-time-${clip.id}`}>
                {formatTime(clip.startTime)} — {formatTime(clip.endTime)}
              </span>
              <Badge variant="outline">{Math.round(duration)}с</Badge>
              <span className={`text-sm font-medium ${confidenceColor}`}>
                {Math.round(clip.confidence * 100)}%
              </span>
              {clip.status === "approved" && (
                <Badge variant="default">Одобрен</Badge>
              )}
              {clip.status === "rejected" && (
                <Badge variant="secondary">Отклонён</Badge>
              )}
            </div>

            {video && (
              <p className="text-xs text-muted-foreground mt-1 truncate">
                {video.originalName}
              </p>
            )}

            <div className="flex flex-wrap gap-1 mt-2">
              {reasons.map((reason, i) => (
                <Badge key={i} variant="secondary" className="text-xs">
                  {reason}
                </Badge>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {clip.status === "pending" && (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => approveMutation.mutate()}
                  disabled={approveMutation.isPending}
                  data-testid={`button-approve-${clip.id}`}
                >
                  <Check className="w-4 h-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => rejectMutation.mutate()}
                  disabled={rejectMutation.isPending}
                  data-testid={`button-reject-${clip.id}`}
                >
                  <X className="w-4 h-4" />
                </Button>
              </>
            )}
            {clip.status === "approved" && (
              <Button
                variant="outline"
                onClick={onExport}
                data-testid={`button-export-clip-${clip.id}`}
              >
                <Download className="w-4 h-4 mr-2" />
                Экспорт
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              title="Удалить клип"
              data-testid={`button-delete-${clip.id}`}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setExpanded(!expanded)}
              data-testid={`button-expand-${clip.id}`}
            >
              {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </Button>
          </div>
        </div>

        {expanded && (
          <div className="mt-4 space-y-4">
            {clip.status === "pending" && (
              <div>
                <p className="text-sm text-muted-foreground mb-2">Подрезка (секунды)</p>
                <div className="px-2">
                  <Slider
                    min={Math.max(0, clip.startTime - 10)}
                    max={clip.endTime + 10}
                    step={0.5}
                    value={trimRange}
                    onValueChange={(val) => setTrimRange(val as [number, number])}
                    data-testid={`slider-trim-${clip.id}`}
                  />
                </div>
                <div className="flex justify-between mt-1">
                  <span className="text-xs text-muted-foreground">{formatTime(trimRange[0])}</span>
                  <span className="text-xs text-muted-foreground">{formatTime(trimRange[1])}</span>
                </div>
              </div>
            )}

            <div>
              <p className="text-sm text-muted-foreground mb-2">Сигналы</p>
              <div className="grid grid-cols-2 gap-2">
                {Object.entries(signals).map(([key, value]) => (
                  <div key={key} className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{key}</span>
                    <span className="font-mono">{typeof value === "number" ? value.toFixed(3) : value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
