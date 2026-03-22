import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Download, Film, FolderOpen, Loader2, Play } from "lucide-react";
import { SiYoutube, SiVk, SiTiktok, SiInstagram, SiFacebook } from "react-icons/si";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";

interface CleanExport {
  exportId: string;
  clipId: string;
  clipTitle: string;
  clipStartTime?: number;
  clipEndTime?: number;
  videoTitle: string;
  profileId: string;
  profileName: string;
  aspectRatio: string;
  publishedTo: string[];
  publishedAt: string | null;
  createdAt: string;
  fileSizeMb: number | null;
}

const platformIcons: Record<string, { icon: any; cls: string }> = {
  youtube: { icon: SiYoutube, cls: "w-3 h-3 text-red-500" },
  vk: { icon: SiVk, cls: "w-3 h-3 text-blue-500" },
  tiktok: { icon: SiTiktok, cls: "w-3 h-3" },
  instagram: { icon: SiInstagram, cls: "w-3 h-3 text-pink-500" },
  facebook: { icon: SiFacebook, cls: "w-3 h-3 text-blue-600" },
};

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function formatDate(d: string): string {
  const date = new Date(d);
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });
}

export default function FilesPage() {
  const [selectedProfile, setSelectedProfile] = useState<string | null>(null);
  const [previewExportId, setPreviewExportId] = useState<string | null>(null);

  const { data: cleanExports, isLoading } = useQuery<CleanExport[]>({
    queryKey: ["/api/exports/clean"],
  });

  const profiles = cleanExports
    ? Array.from(new Map(cleanExports.map(e => [e.profileId, e.profileName])).entries())
        .map(([id, name]) => ({
          id,
          name,
          count: cleanExports.filter(e => e.profileId === id).length,
        }))
        .sort((a, b) => b.count - a.count)
    : [];

  const filteredExports = cleanExports
    ? selectedProfile
      ? cleanExports.filter(e => e.profileId === selectedProfile)
      : cleanExports
    : [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex-1 p-4 max-w-6xl mx-auto w-full">
      <div className="flex items-center gap-3 mb-4">
        <FolderOpen className="w-5 h-5 text-primary" />
        <h1 className="text-lg font-semibold" data-testid="text-files-title">Чистые клипы</h1>
        <Badge variant="secondary" className="text-xs">
          {cleanExports?.length || 0} файлов
        </Badge>
      </div>

      <div className="flex items-center gap-2 mb-4 flex-wrap" data-testid="profile-filter">
        <Button
          size="sm"
          variant={selectedProfile === null ? "default" : "outline"}
          onClick={() => setSelectedProfile(null)}
          data-testid="btn-filter-all"
        >
          Все ({cleanExports?.length || 0})
        </Button>
        {profiles.map(p => (
          <Button
            key={p.id}
            size="sm"
            variant={selectedProfile === p.id ? "default" : "outline"}
            onClick={() => setSelectedProfile(p.id)}
            data-testid={`btn-filter-${p.id}`}
          >
            {p.name} ({p.count})
          </Button>
        ))}
      </div>

      {filteredExports.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-48 text-muted-foreground gap-2">
          <Film className="w-8 h-8 opacity-50" />
          <p className="text-sm">Нет чистых клипов</p>
          <p className="text-xs">Чистые версии создаются автоматически при публикации</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filteredExports.map(exp => (
            <Card key={exp.exportId} className="p-3 flex flex-col gap-2" data-testid={`clean-clip-${exp.exportId}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate" title={exp.clipTitle} data-testid={`text-clip-title-${exp.exportId}`}>
                    {exp.clipTitle}
                  </p>
                  <p className="text-xs text-muted-foreground truncate" title={exp.videoTitle}>
                    {exp.videoTitle}
                  </p>
                </div>
                <Badge variant="outline" className="text-[10px] shrink-0">{exp.aspectRatio}</Badge>
              </div>

              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary" className="text-[10px]">{exp.profileName}</Badge>
                {exp.clipStartTime != null && exp.clipEndTime != null && (
                  <span>{formatTime(exp.clipStartTime)} — {formatTime(exp.clipEndTime)}</span>
                )}
                {exp.fileSizeMb != null && (
                  <span>{exp.fileSizeMb} MB</span>
                )}
              </div>

              <div className="flex items-center gap-1 flex-wrap">
                {exp.publishedTo.map(p => {
                  const pi = platformIcons[p];
                  if (!pi) return null;
                  const Icon = pi.icon;
                  return <Icon key={p} className={pi.cls} title={p} />;
                })}
                {exp.publishedAt && (
                  <span className="text-[10px] text-muted-foreground ml-1">{formatDate(exp.publishedAt)}</span>
                )}
              </div>

              <div className="flex items-center gap-1.5 mt-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 text-xs"
                  onClick={() => setPreviewExportId(exp.exportId)}
                  data-testid={`btn-preview-clean-${exp.exportId}`}
                >
                  <Play className="w-3 h-3 mr-1" />
                  Смотреть
                </Button>
                <a href={`/api/files/clean-export/${exp.exportId}?download=1`} download>
                  <Button size="sm" variant="default" className="text-xs" data-testid={`btn-download-clean-${exp.exportId}`}>
                    <Download className="w-3 h-3 mr-1" />
                    Скачать
                  </Button>
                </a>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!previewExportId} onOpenChange={(open) => { if (!open) setPreviewExportId(null); }}>
        <DialogContent className="max-w-md p-0 overflow-hidden">
          {previewExportId && (
            <video
              src={`/api/files/clean-export/${previewExportId}`}
              controls
              autoPlay
              className="w-full max-h-[80vh]"
              data-testid="video-clean-preview"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
