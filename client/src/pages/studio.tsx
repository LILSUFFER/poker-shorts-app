import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Upload,
  Film,
  Settings,
  Zap,
  Download,
  Trash2,
  Play,
  CheckCircle2,
  XCircle,
  Clock,
  AlertCircle,
  FileVideo,
  Loader2,
} from "lucide-react";
import type { StreamerProfile, Video, SuggestedClip, ExportJob } from "@shared/schema";
import CalibrationDialog from "@/components/calibration-dialog";
import ClipCard from "@/components/clip-card";
import ProfileManager from "@/components/profile-manager";

export default function StudioPage() {
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [activeTab, setActiveTab] = useState("upload");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [calibrationOpen, setCalibrationOpen] = useState(false);
  const [calibrationVideoId, setCalibrationVideoId] = useState<string | null>(null);
  const [profileManagerOpen, setProfileManagerOpen] = useState(false);

  const { data: profiles = [], isLoading: profilesLoading } = useQuery<StreamerProfile[]>({
    queryKey: ["/api/profiles"],
    queryFn: async () => {
      const res = await fetch("/api/profiles");
      if (!res.ok) throw new Error("Failed"); return res.json();
    },
  });

  const { data: videosData = [], isLoading: videosLoading } = useQuery<Video[]>({
    queryKey: ["/api/videos"],
    queryFn: async () => {
      const res = await fetch("/api/videos");
      if (!res.ok) throw new Error("Failed"); return res.json();
    },
  });

  const { data: clipsData = [], isLoading: clipsLoading } = useQuery<SuggestedClip[]>({
    queryKey: ["/api/clips"],
    queryFn: async () => {
      const res = await fetch("/api/clips");
      if (!res.ok) throw new Error("Failed"); return res.json();
    },
  });

  const { data: exportsData = [] } = useQuery<ExportJob[]>({
    queryKey: ["/api/exports"],
    queryFn: async () => {
      const res = await fetch("/api/exports");
      if (!res.ok) throw new Error("Failed"); return res.json();
    },
  });

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId);

  const analyzeMutation = useMutation({
    mutationFn: async (videoId: string) => {
      const res = await apiRequest("POST", `/api/videos/${videoId}/analyze`, {
        profileId: selectedProfileId,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clips"] });
      queryClient.invalidateQueries({ queryKey: ["/api/videos"] });
      setActiveTab("review");
    },
  });

  const exportMutation = useMutation({
    mutationFn: async (clipId: string) => {
      const res = await apiRequest("POST", `/api/clips/${clipId}/export`, {
        profileId: selectedProfileId,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/exports"] });
      setActiveTab("export");
    },
  });

  const deleteVideoMutation = useMutation({
    mutationFn: async (videoId: string) => {
      await apiRequest("DELETE", `/api/videos/${videoId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/videos"] });
      queryClient.invalidateQueries({ queryKey: ["/api/clips"] });
    },
  });

  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setIsUploading(true);
    setUploadProgress(0);

    const file = files[0];

    try {
      const configRes = await fetch("/api/upload/config");
      const config = await configRes.json();

      if (config.direct && config.vpsUrl && config.vpsToken) {
        const vpsFormData = new FormData();
        vpsFormData.append("file", file);

        const xhr = new XMLHttpRequest();
        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable) {
            setUploadProgress(Math.round((e.loaded / e.total) * 100));
          }
        });

        const vpsData: any = await new Promise((resolve, reject) => {
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve(JSON.parse(xhr.responseText));
            } else {
              reject(new Error(`Upload failed: ${xhr.status}`));
            }
          };
          xhr.onerror = () => reject(new Error("Ошибка сети при загрузке"));
          xhr.open("POST", `${config.vpsUrl}/upload`);
          xhr.setRequestHeader("Authorization", `Bearer ${config.vpsToken}`);
          xhr.send(vpsFormData);
        });

        await apiRequest("POST", "/api/videos/register", {
          vpsVideoId: vpsData.videoId,
          vpsPath: vpsData.storedPath,
          originalName: file.name,
          fileSize: vpsData.sizeBytes,
          profileId: selectedProfileId || undefined,
        });
      } else {
        const formData = new FormData();
        formData.append("video", file);
        if (selectedProfileId) {
          formData.append("profileId", selectedProfileId);
        }

        const xhr = new XMLHttpRequest();
        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable) {
            setUploadProgress(Math.round((e.loaded / e.total) * 100));
          }
        });

        await new Promise<void>((resolve, reject) => {
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve();
            } else {
              reject(new Error(`Upload failed: ${xhr.status}`));
            }
          };
          xhr.onerror = () => reject(new Error("Upload failed"));
          xhr.open("POST", "/api/videos/upload");
          xhr.send(formData);
        });
      }

      queryClient.invalidateQueries({ queryKey: ["/api/videos"] });
    } catch (err) {
      console.error("Upload error:", err);
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    handleFileUpload(e.dataTransfer.files);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const openCalibration = (videoId: string) => {
    setCalibrationVideoId(videoId);
    setCalibrationOpen(true);
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "uploaded":
        return <Badge variant="secondary"><Clock className="w-3 h-3 mr-1" />Загружено</Badge>;
      case "analyzing":
        return <Badge variant="default"><Loader2 className="w-3 h-3 mr-1 animate-spin" />Анализ</Badge>;
      case "analyzed":
        return <Badge variant="outline"><CheckCircle2 className="w-3 h-3 mr-1" />Готово</Badge>;
      case "error":
        return <Badge variant="destructive"><AlertCircle className="w-3 h-3 mr-1" />Ошибка</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const videoClips = (videoId: string) => clipsData.filter((c) => c.videoId === videoId);
  const pendingClips = clipsData.filter((c) => c.status === "pending");
  const approvedClips = clipsData.filter((c) => c.status === "approved");

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="text-studio-title">Shorts Studio</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Загружай видео, настраивай профиль, анализируй и экспортируй шортсы
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <Select value={selectedProfileId} onValueChange={setSelectedProfileId}>
            <SelectTrigger className="w-[200px]" data-testid="select-profile">
              <SelectValue placeholder="Выбери профиль" />
            </SelectTrigger>
            <SelectContent>
              {profiles.map((p) => (
                <SelectItem key={p.id} value={p.id} data-testid={`select-profile-${p.id}`}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button variant="outline" onClick={() => setProfileManagerOpen(true)} data-testid="button-manage-profiles">
            <Settings className="w-4 h-4 mr-2" />
            Профили
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList data-testid="tabs-studio">
          <TabsTrigger value="upload" data-testid="tab-upload">
            <Upload className="w-4 h-4 mr-2" />
            Загрузка
          </TabsTrigger>
          <TabsTrigger value="review" data-testid="tab-review">
            <Film className="w-4 h-4 mr-2" />
            Обзор
            {pendingClips.length > 0 && (
              <Badge variant="secondary" className="ml-2">{pendingClips.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="export" data-testid="tab-export">
            <Download className="w-4 h-4 mr-2" />
            Экспорт
            {approvedClips.length > 0 && (
              <Badge variant="secondary" className="ml-2">{approvedClips.length}</Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="upload" className="mt-6 space-y-6">
          <Card>
            <CardContent className="p-6">
              <div
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                className="border-2 border-dashed border-border rounded-md p-12 text-center transition-colors hover-elevate cursor-pointer"
                onClick={() => document.getElementById("video-upload")?.click()}
                data-testid="dropzone-upload"
              >
                <input
                  id="video-upload"
                  type="file"
                  accept="video/*"
                  className="hidden"
                  onChange={(e) => handleFileUpload(e.target.files)}
                  data-testid="input-video-upload"
                />
                <FileVideo className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-foreground font-medium">
                  {isUploading ? "Загрузка..." : "Перетащи видео или нажми для выбора"}
                </p>
                <p className="text-muted-foreground text-sm mt-1">
                  MP4, MKV, AVI, MOV — до 4GB
                </p>
                {isUploading && (
                  <div className="mt-4 max-w-xs mx-auto">
                    <Progress value={uploadProgress} data-testid="progress-upload" />
                    <p className="text-sm text-muted-foreground mt-2">{uploadProgress}%</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {videosLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : videosData.length === 0 ? (
            <Card>
              <CardContent className="p-12 text-center">
                <Film className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                <p className="text-muted-foreground">Пока нет загруженных видео</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4">
              {videosData.map((video) => (
                <Card key={video.id}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between gap-4 flex-wrap">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-20 h-14 rounded-md bg-muted flex items-center justify-center flex-shrink-0 overflow-hidden">
                          {video.thumbnailPath ? (
                            <img
                              src={`/api/files/thumbnail/${video.id}`}
                              alt=""
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <Film className="w-5 h-5 text-muted-foreground" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium truncate" data-testid={`text-video-name-${video.id}`}>
                            {video.originalName}
                          </p>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            {video.duration && (
                              <span className="text-xs text-muted-foreground">
                                {Math.floor(video.duration / 60)}:{String(Math.floor(video.duration % 60)).padStart(2, "0")}
                              </span>
                            )}
                            {video.width && video.height && (
                              <span className="text-xs text-muted-foreground">
                                {video.width}x{video.height}
                              </span>
                            )}
                            {getStatusBadge(video.status)}
                            {videoClips(video.id).length > 0 && (
                              <Badge variant="outline">
                                {videoClips(video.id).length} клипов
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 flex-wrap">
                        {selectedProfile && !selectedProfile.calibration && (
                          <Button
                            variant="outline"
                            onClick={() => openCalibration(video.id)}
                            data-testid={`button-calibrate-${video.id}`}
                          >
                            <Settings className="w-4 h-4 mr-2" />
                            Калибровка
                          </Button>
                        )}
                        {selectedProfile && selectedProfile.calibration && (
                          <Button
                            variant="outline"
                            onClick={() => openCalibration(video.id)}
                            data-testid={`button-recalibrate-${video.id}`}
                          >
                            <Settings className="w-4 h-4 mr-2" />
                            Рекалибровка
                          </Button>
                        )}
                        <Button
                          onClick={() => analyzeMutation.mutate(video.id)}
                          disabled={!selectedProfileId || !selectedProfile?.calibration || analyzeMutation.isPending || video.status === "analyzing"}
                          data-testid={`button-analyze-${video.id}`}
                        >
                          {analyzeMutation.isPending ? (
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          ) : (
                            <Zap className="w-4 h-4 mr-2" />
                          )}
                          Анализ
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => deleteVideoMutation.mutate(video.id)}
                          data-testid={`button-delete-video-${video.id}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="review" className="mt-6 space-y-4">
          {clipsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : clipsData.length === 0 ? (
            <Card>
              <CardContent className="p-12 text-center">
                <Film className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                <p className="text-muted-foreground">Запусти анализ видео для получения предложений</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {pendingClips.length > 0 && (
                <div>
                  <h3 className="text-lg font-medium mb-3 flex items-center gap-2">
                    <Clock className="w-5 h-5 text-muted-foreground" />
                    Ожидают проверки ({pendingClips.length})
                  </h3>
                  <div className="grid gap-3">
                    {pendingClips.map((clip) => (
                      <ClipCard
                        key={clip.id}
                        clip={clip}
                        video={videosData.find((v) => v.id === clip.videoId)}
                        onExport={() => exportMutation.mutate(clip.id)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {approvedClips.length > 0 && (
                <div>
                  <h3 className="text-lg font-medium mb-3 flex items-center gap-2">
                    <CheckCircle2 className="w-5 h-5 text-primary" />
                    Одобрены ({approvedClips.length})
                  </h3>
                  <div className="grid gap-3">
                    {approvedClips.map((clip) => (
                      <ClipCard
                        key={clip.id}
                        clip={clip}
                        video={videosData.find((v) => v.id === clip.videoId)}
                        onExport={() => exportMutation.mutate(clip.id)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {clipsData.filter((c) => c.status === "rejected").length > 0 && (
                <div>
                  <h3 className="text-lg font-medium mb-3 flex items-center gap-2 text-muted-foreground">
                    <XCircle className="w-5 h-5" />
                    Отклонены ({clipsData.filter((c) => c.status === "rejected").length})
                  </h3>
                  <div className="grid gap-3">
                    {clipsData.filter((c) => c.status === "rejected").map((clip) => (
                      <ClipCard
                        key={clip.id}
                        clip={clip}
                        video={videosData.find((v) => v.id === clip.videoId)}
                        onExport={() => exportMutation.mutate(clip.id)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="export" className="mt-6 space-y-4">
          {exportsData.length === 0 ? (
            <Card>
              <CardContent className="p-12 text-center">
                <Download className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                <p className="text-muted-foreground">Одобри клипы и экспортируй их как вертикальные шортсы</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-3">
              {exportsData.map((job) => (
                <Card key={job.id}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between gap-4 flex-wrap">
                      <div>
                        <p className="font-medium" data-testid={`text-export-${job.id}`}>
                          Экспорт #{job.id.slice(0, 8)}
                        </p>
                        <div className="flex items-center gap-2 mt-1">
                          {job.status === "queued" && <Badge variant="secondary"><Clock className="w-3 h-3 mr-1" />В очереди</Badge>}
                          {job.status === "processing" && <Badge variant="default"><Loader2 className="w-3 h-3 mr-1 animate-spin" />Обработка</Badge>}
                          {job.status === "completed" && <Badge variant="outline"><CheckCircle2 className="w-3 h-3 mr-1" />Готово</Badge>}
                          {job.status === "error" && <Badge variant="destructive"><AlertCircle className="w-3 h-3 mr-1" />Ошибка</Badge>}
                        </div>
                        {job.error && (
                          <p className="text-sm text-destructive mt-1">{job.error}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {job.status === "processing" && job.progress !== null && (
                          <div className="w-32">
                            <Progress value={job.progress ?? 0} />
                          </div>
                        )}
                        {job.status === "completed" && (
                          <Button
                            variant="outline"
                            onClick={() => {
                              window.open(`/api/exports/${job.id}/download`, "_blank");
                            }}
                            data-testid={`button-download-${job.id}`}
                          >
                            <Download className="w-4 h-4 mr-2" />
                            Скачать
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {calibrationOpen && calibrationVideoId && selectedProfileId && (
        <CalibrationDialog
          open={calibrationOpen}
          onOpenChange={setCalibrationOpen}
          videoId={calibrationVideoId}
          profileId={selectedProfileId}
        />
      )}

      {profileManagerOpen && (
        <ProfileManager
          open={profileManagerOpen}
          onOpenChange={setProfileManagerOpen}
        />
      )}
    </div>
  );
}
