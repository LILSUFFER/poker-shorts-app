import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Sparkles, Plus, Trash2, Loader2, Film, Download, User,
  ArrowLeft, Merge, Wand2, Volume2, Clapperboard, Layers, ImageIcon
} from "lucide-react";
import { SiYoutube, SiTiktok, SiInstagram, SiFacebook, SiThreads, SiVk } from "react-icons/si";
import { Link } from "wouter";
import type { GeneratedVideo, GeneratedClip, SceneData } from "@shared/schema";

interface Profile {
  id: string;
  name: string;
  uploadPostApiKey: string | null;
  uploadPostUser: string | null;
}

export default function GeneratePage() {
  const { toast } = useToast();
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [language, setLanguage] = useState("en");
  const [voice, setVoice] = useState("nova");
  const [lightboxImg, setLightboxImg] = useState<string | null>(null);
  const [publishDialog, setPublishDialog] = useState<{ platform: string; label: string } | null>(null);
  const [publishTitle, setPublishTitle] = useState("");
  const [publishDesc, setPublishDesc] = useState("");
  

  const { data: videos = [], isLoading } = useQuery<GeneratedVideo[]>({
    queryKey: ["/api/generated-videos"],
    refetchInterval: 3000,
  });

  const { data: profiles = [] } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
  });

  const selectedVideo = videos.find(v => v.id === selectedVideoId);
  const scenarios = (selectedVideo?.scenario as SceneData[]) || [];
  const clips = (selectedVideo?.clips as GeneratedClip[]) || [];
  const completedClips = clips.filter(c => c.status === "completed");
  const hasGenerating = clips.some(c => c.status === "generating");

  const createMutation = useMutation({
    mutationFn: async (title: string) => {
      const res = await apiRequest("POST", "/api/generated-videos", { title });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/generated-videos"] });
      setSelectedVideoId(data.id);
      setNewTitle("");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/generated-videos/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/generated-videos"] });
      if (selectedVideoId) setSelectedVideoId(null);
    },
  });

  const generateClipMutation = useMutation({
    mutationFn: async ({ videoId, prompt }: { videoId: string; prompt: string }) => {
      const res = await apiRequest("POST", `/api/generated-videos/${videoId}/generate-clip`, { prompt });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/generated-videos"] });
      setPrompt("");
      toast({ title: "Генерация запущена", description: "Клип генерируется через Grok AI..." });
    },
    onError: (err: Error) => {
      toast({ title: "Ошибка", description: err.message, variant: "destructive" });
    },
  });

  const deleteClipMutation = useMutation({
    mutationFn: async ({ videoId, clipId }: { videoId: string; clipId: string }) => {
      await apiRequest("DELETE", `/api/generated-videos/${videoId}/clips/${clipId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/generated-videos"] });
    },
  });

  const scenarioMutation = useMutation({
    mutationFn: async ({ videoId, topic, language }: { videoId: string; topic: string; language: string }) => {
      const res = await apiRequest("POST", `/api/generated-videos/${videoId}/generate-scenario`, {
        topic,
        language,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/generated-videos"] });
      toast({ title: "Сценарий готов", description: "GPT сгенерировал сцены для видео" });
    },
    onError: (err: Error) => {
      toast({ title: "Ошибка сценария", description: err.message, variant: "destructive" });
    },
  });

  const ttsMutation = useMutation({
    mutationFn: async ({ videoId, voice }: { videoId: string; voice: string }) => {
      const res = await apiRequest("POST", `/api/generated-videos/${videoId}/generate-tts`, { voice });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/generated-videos"] });
      toast({ title: "Озвучка готова", description: "TTS аудио сгенерировано" });
    },
    onError: (err: Error) => {
      toast({ title: "Ошибка TTS", description: err.message, variant: "destructive" });
    },
  });

  const generateImagesMutation = useMutation({
    mutationFn: async (videoId: string) => {
      const res = await apiRequest("POST", `/api/generated-videos/${videoId}/generate-images`, {});
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/generated-videos"] });
      toast({ title: "Генерация запущена", description: `${data.total} картинок генерируются в фоне (${data.provider})` });
    },
    onError: (err: Error) => {
      toast({ title: "Ошибка", description: err.message, variant: "destructive" });
    },
  });

  const generateAllMutation = useMutation({
    mutationFn: async (videoId: string) => {
      const res = await apiRequest("POST", `/api/generated-videos/${videoId}/generate-all-clips`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/generated-videos"] });
      toast({ title: "Генерация запущена", description: "Клипы генерируются через Veo (image→video)..." });
    },
    onError: (err: Error) => {
      toast({ title: "Ошибка", description: err.message, variant: "destructive" });
    },
  });

  const assembleMutation = useMutation({
    mutationFn: async ({ videoId, voice }: { videoId: string; voice: string }) => {
      const res = await apiRequest("POST", `/api/generated-videos/${videoId}/assemble`, { voice });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/generated-videos"] });
      toast({ title: "Готово!", description: "Видео собрано с озвучкой" });
    },
    onError: (err: Error) => {
      toast({ title: "Ошибка сборки", description: err.message, variant: "destructive" });
    },
  });

  const concatenateMutation = useMutation({
    mutationFn: async (videoId: string) => {
      const res = await apiRequest("POST", `/api/generated-videos/${videoId}/concatenate`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/generated-videos"] });
      toast({ title: "Готово", description: "Клипы объединены!" });
    },
    onError: (err: Error) => {
      toast({ title: "Ошибка", description: err.message, variant: "destructive" });
    },
  });

  const setProfileMutation = useMutation({
    mutationFn: async ({ videoId, profileId }: { videoId: string; profileId: string | null }) => {
      const res = await apiRequest("PATCH", `/api/generated-videos/${videoId}`, { profileId });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/generated-videos"] });
      toast({ title: "Профиль обновлён" });
    },
    onError: (err: Error) => {
      toast({ title: "Ошибка", description: err.message, variant: "destructive" });
    },
  });

  const publishMutation = useMutation({
    mutationFn: async ({ videoId, platform, title, description }: { videoId: string; platform: string; title: string; description: string }) => {
      const res = await apiRequest("POST", `/api/generated-videos/${videoId}/publish/${platform}`, {
        title,
        description,
      });
      return res.json();
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/generated-videos"] });
      toast({ title: "Опубликовано", description: `Отправлено в ${vars.platform}` });
      setPublishDialog(null);
    },
    onError: (err: Error) => {
      toast({ title: "Ошибка публикации", description: err.message, variant: "destructive" });
    },
  });

  const scenarioImages = scenarios.filter(s => s.imagePath);
  const isPipelineBusy = scenarioMutation.isPending || ttsMutation.isPending || generateImagesMutation.isPending || generateAllMutation.isPending || assembleMutation.isPending;

  return (
    <div className="flex h-[calc(100vh-49px)]" data-testid="generate-page">
      <div className="w-72 border-r bg-card/30 flex flex-col">
        <div className="p-3 border-b">
          <div className="flex items-center gap-2 mb-2">
            <Link href="/">
              <Button variant="ghost" size="sm" data-testid="button-back-home">
                <ArrowLeft className="w-3.5 h-3.5" />
              </Button>
            </Link>
            <h2 className="text-sm font-semibold flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-purple-500" />
              AI Генерация
            </h2>
          </div>
          <div className="flex gap-1.5">
            <Input
              placeholder="Название проекта..."
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              className="text-xs h-8"
              onKeyDown={e => {
                if (e.key === "Enter" && newTitle.trim()) createMutation.mutate(newTitle.trim());
              }}
              data-testid="input-new-project-title"
            />
            <Button
              size="sm"
              className="h-8 px-2"
              disabled={!newTitle.trim() || createMutation.isPending}
              onClick={() => createMutation.mutate(newTitle.trim())}
              data-testid="button-create-project"
            >
              <Plus className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {isLoading && <div className="text-xs text-muted-foreground p-2">Загрузка...</div>}
          {videos.map(v => (
            <div
              key={v.id}
              className={`p-2 rounded-md cursor-pointer text-xs transition-colors ${
                selectedVideoId === v.id ? "bg-primary/10 border border-primary/30" : "hover:bg-muted"
              }`}
              onClick={() => setSelectedVideoId(v.id)}
              data-testid={`video-item-${v.id}`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium truncate">{v.title || "Без названия"}</span>
                <Badge variant="outline" className="text-[9px] ml-1 shrink-0">
                  {(v.clips as GeneratedClip[] || []).length}
                </Badge>
              </div>
              <div className="text-muted-foreground mt-0.5 flex items-center gap-1">
                {v.status === "completed" && <Film className="w-2.5 h-2.5 text-green-500" />}
                {v.status === "processing" && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                <span>{new Date(v.createdAt).toLocaleDateString("ru")}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {!selectedVideo ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <div className="text-center">
              <Sparkles className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Выберите или создайте проект</p>
              <p className="text-xs mt-1 opacity-60">Создавайте "survival quiz" видео с монстрами через Grok AI</p>
            </div>
          </div>
        ) : (
          <div className="p-4 max-w-3xl mx-auto space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-lg font-semibold" data-testid="text-project-title">{selectedVideo.title}</h1>
                <div className="flex items-center gap-2 mt-0.5">
                  <p className="text-xs text-muted-foreground">
                    {clips.length} клипов
                    {selectedVideo.finalDuration ? ` · ${selectedVideo.finalDuration.toFixed(1)}с` : ""}
                  </p>
                  <Select
                    value={selectedVideo.profileId || "none"}
                    onValueChange={(val) => setProfileMutation.mutate({ videoId: selectedVideo.id, profileId: val === "none" ? null : val })}
                  >
                    <SelectTrigger className="h-6 text-[10px] w-auto min-w-[120px] gap-1" data-testid="select-profile">
                      <User className="w-3 h-3" />
                      <SelectValue placeholder="Профиль" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Без профиля</SelectItem>
                      {profiles.filter(p => p.uploadPostUser).map(p => (
                        <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                onClick={() => { if (confirm("Удалить проект?")) deleteMutation.mutate(selectedVideo.id); }}
                data-testid="button-delete-project"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>

            {/* Step 1: Auto Pipeline - Topic */}
            <Card className="border-purple-500/30">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Wand2 className="w-4 h-4 text-purple-500" />
                  Авто-пайплайн
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Textarea
                  placeholder="Тема монстра/сценария... Например: 'Shadow creature in abandoned hospital' или 'Giant spider in dark forest'"
                  value={topic}
                  onChange={e => setTopic(e.target.value)}
                  className="min-h-[60px] text-sm"
                  data-testid="input-topic"
                />
                <div className="flex items-center gap-2 flex-wrap">
                  <Select value={language} onValueChange={setLanguage}>
                    <SelectTrigger className="w-[120px] h-8 text-xs" data-testid="select-language">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="en">English</SelectItem>
                      <SelectItem value="ru">Русский</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={voice} onValueChange={setVoice}>
                    <SelectTrigger className="w-[120px] h-8 text-xs" data-testid="select-voice">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="alloy">Alloy</SelectItem>
                      <SelectItem value="echo">Echo</SelectItem>
                      <SelectItem value="fable">Fable</SelectItem>
                      <SelectItem value="onyx">Onyx</SelectItem>
                      <SelectItem value="nova">Nova</SelectItem>
                      <SelectItem value="shimmer">Shimmer</SelectItem>
                    </SelectContent>
                  </Select>

                  <Button
                    size="sm"
                    disabled={!topic.trim() || isPipelineBusy}
                    onClick={() => scenarioMutation.mutate({ videoId: selectedVideo.id, topic: topic.trim(), language })}
                    data-testid="button-generate-scenario"
                  >
                    {scenarioMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Clapperboard className="w-3.5 h-3.5 mr-1.5" />}
                    1. Сценарий
                  </Button>

                  {scenarios.length > 0 && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isPipelineBusy}
                        onClick={() => ttsMutation.mutate({ videoId: selectedVideo.id, voice })}
                        data-testid="button-generate-tts"
                      >
                        {ttsMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Volume2 className="w-3.5 h-3.5 mr-1.5" />}
                        2. Озвучка
                      </Button>

                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isPipelineBusy}
                        onClick={() => generateImagesMutation.mutate(selectedVideo.id)}
                        data-testid="button-generate-images"
                      >
                        {generateImagesMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <ImageIcon className="w-3.5 h-3.5 mr-1.5" />}
                        3. Картинки ({scenarioImages.length}/{scenarios.length})
                      </Button>

                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isPipelineBusy || hasGenerating}
                        onClick={() => generateAllMutation.mutate(selectedVideo.id)}
                        data-testid="button-generate-all-clips"
                      >
                        {generateAllMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Layers className="w-3.5 h-3.5 mr-1.5" />}
                        4. Видео ({scenarios.length})
                      </Button>

                      {completedClips.length > 0 && (
                        <Button
                          size="sm"
                          disabled={isPipelineBusy || hasGenerating || assembleMutation.isPending}
                          onClick={() => assembleMutation.mutate({ videoId: selectedVideo.id, voice })}
                          data-testid="button-assemble"
                        >
                          {assembleMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Merge className="w-3.5 h-3.5 mr-1.5" />}
                          5. Собрать (TTS + субтитры)
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Scenario display */}
            {scenarios.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Clapperboard className="w-4 h-4" />
                    Сценарий ({scenarios.length} сцен)
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {scenarios.map((scene, idx) => {
                    const typeLabel = scene.sceneType === "intro" ? "🎬 Intro"
                      : scene.sceneType === "question" ? "❓ Вопрос"
                      : scene.sceneType === "outcome_wrong" ? `❌ ${scene.optionLabel || ""}`
                      : scene.sceneType === "outcome_correct" ? `✅ ${scene.optionLabel || ""}`
                      : scene.sceneType === "progression" ? `📈 #${idx + 1}`
                      : scene.sceneType === "climax" ? "🔥 Кульм."
                      : scene.sceneType === "conclusion" ? "🏁 Итог"
                      : `#${idx + 1}`;
                    const bgClass = scene.sceneType === "outcome_correct" ? "bg-green-500/10 border border-green-500/20"
                      : scene.sceneType === "outcome_wrong" ? "bg-red-500/5 border border-red-500/10"
                      : scene.sceneType === "question" ? "bg-yellow-500/10 border border-yellow-500/20"
                      : scene.sceneType === "climax" ? "bg-orange-500/10 border border-orange-500/20"
                      : scene.sceneType === "conclusion" ? "bg-blue-500/10 border border-blue-500/20"
                      : "bg-muted/50";
                    return (
                      <div key={idx} className={`flex gap-2 p-2 rounded text-xs ${bgClass}`}>
                        <div className="shrink-0 text-center" style={{ minWidth: scene.imagePath ? '80px' : '40px' }}>
                          <span className="text-[10px] font-bold">{typeLabel}</span>
                          {scene.imagePath && (
                            <img
                              src={`/uploads/generated/images/${scene.imagePath.split("/").pop()}`}
                              className="mt-1 w-20 h-32 object-cover rounded border cursor-pointer hover:opacity-80 transition-opacity"
                              alt={`Scene ${idx + 1}`}
                              data-testid={`img-scene-${idx}`}
                              onClick={() => setLightboxImg(`/uploads/generated/images/${scene.imagePath!.split("/").pop()}`)}
                            />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-foreground mb-0.5">{scene.narrationText}</p>
                          <p className="text-muted-foreground italic text-[10px]">{scene.visualPrompt}</p>
                        </div>
                      </div>
                    );
                  })}
                  {selectedVideo.narrationText && (
                    <div className="mt-2 p-2 rounded bg-blue-500/10 text-xs">
                      <span className="font-medium">Полный текст:</span> {selectedVideo.narrationText}
                    </div>
                  )}
                  {selectedVideo.ttsPath && (
                    <div className="mt-2">
                      <audio
                        src={`/uploads/generated/${selectedVideo.ttsPath.split("/").pop()}`}
                        controls
                        className="w-full h-8"
                        data-testid="audio-tts-preview"
                      />
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Manual clip generation */}
            <Card>
              <CardContent className="p-4">
                <div className="space-y-2">
                  <Textarea
                    placeholder="Или вручную: опишите видео для генерации через Grok AI..."
                    value={prompt}
                    onChange={e => setPrompt(e.target.value)}
                    className="min-h-[60px] text-sm"
                    data-testid="input-prompt"
                  />
                  <div className="flex justify-between items-center">
                    <p className="text-[10px] text-muted-foreground">Grok AI генерирует ~6 секундное видео</p>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!prompt.trim() || generateClipMutation.isPending}
                      onClick={() => generateClipMutation.mutate({ videoId: selectedVideo.id, prompt: prompt.trim() })}
                      data-testid="button-generate-clip"
                    >
                      {generateClipMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 mr-1.5" />}
                      + Клип вручную
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Clips list */}
            {clips.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">Клипы ({clips.length})</h3>
                  {completedClips.length > 1 && !scenarios.length && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={concatenateMutation.isPending || hasGenerating}
                      onClick={() => concatenateMutation.mutate(selectedVideo.id)}
                      data-testid="button-concatenate"
                    >
                      {concatenateMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Merge className="w-3.5 h-3.5 mr-1.5" />}
                      Объединить
                    </Button>
                  )}
                </div>
                {clips.map((clip, idx) => (
                  <Card key={clip.id} className="overflow-hidden">
                    <CardContent className="p-3">
                      <div className="flex items-start gap-3">
                        <div className="shrink-0 w-8 h-8 rounded bg-muted flex items-center justify-center text-xs font-medium">
                          {idx + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-muted-foreground truncate mb-1" title={clip.prompt}>
                            {clip.prompt}
                          </p>
                          <div className="flex items-center gap-2">
                            {clip.status === "generating" && (
                              <Badge variant="outline" className="text-[10px] gap-1">
                                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                                Генерируется...
                              </Badge>
                            )}
                            {clip.status === "completed" && (
                              <Badge variant="secondary" className="text-[10px] gap-1 text-green-600">
                                <Film className="w-2.5 h-2.5" />
                                Готов
                              </Badge>
                            )}
                            {clip.status === "error" && (
                              <Badge variant="destructive" className="text-[10px]">
                                Ошибка: {clip.error?.substring(0, 50)}
                              </Badge>
                            )}
                            {clip.status === "pending" && (
                              <Badge variant="outline" className="text-[10px]">Ожидает</Badge>
                            )}
                          </div>
                          {clip.status === "completed" && clip.localPath && (
                            <div className="mt-2">
                              <video
                                src={`/uploads/generated/${clip.localPath.split("/").pop()}`}
                                controls
                                className="rounded max-h-48 w-full object-contain bg-black"
                                data-testid={`video-preview-${clip.id}`}
                              />
                            </div>
                          )}
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => deleteClipMutation.mutate({ videoId: selectedVideo.id, clipId: clip.id })}
                          data-testid={`button-delete-clip-${clip.id}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            {/* Final video + publish */}
            {selectedVideo.status === "completed" && selectedVideo.finalOutputPath && (
              <Card className="border-green-500/30">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Film className="w-4 h-4 text-green-500" />
                    Финальное видео
                    {selectedVideo.finalDuration && (
                      <Badge variant="outline" className="text-[10px]">{selectedVideo.finalDuration.toFixed(1)}с</Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <video
                    src={`/uploads/generated/${selectedVideo.finalOutputPath.split("/").pop()}`}
                    controls
                    className="rounded w-full max-h-64 object-contain bg-black"
                    data-testid="video-final-preview"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    <a
                      href={`/uploads/generated/${selectedVideo.finalOutputPath.split("/").pop()}`}
                      download={`${selectedVideo.title || "video"}.mp4`}
                      className="inline-flex"
                    >
                      <Button size="sm" variant="outline" data-testid="button-download-video">
                        <Download className="w-3 h-3" />
                        <span className="ml-1 text-xs">Скачать</span>
                      </Button>
                    </a>
                    {[
                      { platform: "youtube", label: "YouTube", icon: <SiYoutube className="w-3 h-3 text-red-500" /> },
                      { platform: "vk", label: "VK", icon: <SiVk className="w-3 h-3 text-blue-500" /> },
                      { platform: "tiktok", label: "TikTok", icon: <SiTiktok className="w-3 h-3" /> },
                      { platform: "instagram", label: "Instagram", icon: <SiInstagram className="w-3 h-3 text-pink-500" /> },
                      { platform: "facebook", label: "Facebook", icon: <SiFacebook className="w-3 h-3 text-blue-600" /> },
                      { platform: "threads", label: "Threads", icon: <SiThreads className="w-3 h-3" /> },
                    ].map(({ platform, label, icon }) => {
                      const isPublished = selectedVideo.publishedTo?.includes(platform);
                      return (
                        <Button
                          key={platform}
                          size="sm"
                          variant={isPublished ? "secondary" : "outline"}
                          disabled={publishMutation.isPending}
                          onClick={() => {
                            setPublishTitle(selectedVideo.title || "");
                            setPublishDesc("");
                            setPublishDialog({ platform, label });
                          }}
                          data-testid={`button-publish-${platform}`}
                        >
                          {icon}
                          <span className="ml-1 text-xs">{label}</span>
                          {isPublished && <span className="ml-1 text-[10px] opacity-60">✓</span>}
                        </Button>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}

            {selectedVideo.status === "processing" && (
              <Card>
                <CardContent className="p-4 flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Сборка видео...
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>

      {lightboxImg && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 cursor-pointer"
          onClick={() => setLightboxImg(null)}
          data-testid="lightbox-overlay"
        >
          <img
            src={lightboxImg}
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
            alt="Full size preview"
            data-testid="lightbox-image"
          />
        </div>
      )}

      <Dialog open={!!publishDialog} onOpenChange={(open) => { if (!open) setPublishDialog(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">Публикация в {publishDialog?.label}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Название</Label>
              <Input
                value={publishTitle}
                onChange={e => setPublishTitle(e.target.value)}
                placeholder="Название видео..."
                className="text-sm mt-1"
                data-testid="input-publish-title"
              />
            </div>
            <div>
              <Label className="text-xs">Описание / хештеги</Label>
              <Textarea
                value={publishDesc}
                onChange={e => setPublishDesc(e.target.value)}
                placeholder={"Описание видео...\n\n#shorts #animation #skeleton"}
                rows={4}
                className="text-sm mt-1"
                data-testid="input-publish-description"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPublishDialog(null)}
              data-testid="button-cancel-publish"
            >
              Отмена
            </Button>
            <Button
              size="sm"
              disabled={publishMutation.isPending || !publishTitle.trim()}
              onClick={() => {
                if (selectedVideo && publishDialog) {
                  publishMutation.mutate({
                    videoId: selectedVideo.id,
                    platform: publishDialog.platform,
                    title: publishTitle.trim(),
                    description: publishDesc.trim(),
                  });
                }
              }}
              data-testid="button-confirm-publish"
            >
              {publishMutation.isPending ? (
                <><Loader2 className="w-3 h-3 animate-spin mr-1" /> Публикация...</>
              ) : (
                "Опубликовать"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
