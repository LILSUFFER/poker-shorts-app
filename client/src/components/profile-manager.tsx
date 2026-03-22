import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Plus, Trash2, Settings, CheckCircle2, Upload, Image, Wifi, WifiOff, Loader2, Eye, EyeOff } from "lucide-react";
import type { StreamerProfile } from "@shared/schema";

interface ProfileManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface SocialStatus {
  configured: boolean;
  platforms: {
    instagram: boolean;
    tiktok: boolean;
    facebook: boolean;
    threads: boolean;
    youtube: boolean;
    accountNames: Record<string, string | null>;
  };
}

export default function ProfileManager({ open, onOpenChange }: ProfileManagerProps) {
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState<Record<string, boolean>>({});
  const [localApiKey, setLocalApiKey] = useState<Record<string, string>>({});
  const [localUser, setLocalUser] = useState<Record<string, string>>({});
  const logoInputRef = useRef<HTMLInputElement>(null);

  const { data: profiles = [] } = useQuery<StreamerProfile[]>({
    queryKey: ["/api/profiles"],
    queryFn: async () => {
      const res = await fetch("/api/profiles");
      if (!res.ok) throw new Error("Failed to fetch profiles");
      return res.json();
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/profiles", { name: newName });
    },
    onSuccess: () => {
      setNewName("");
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/profiles/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
    },
  });

  const updateThresholdsMutation = useMutation({
    mutationFn: async ({ id, thresholds }: { id: string; thresholds: Record<string, number> }) => {
      await apiRequest("PATCH", `/api/profiles/${id}/thresholds`, thresholds);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
    },
  });

  const updateSettingsMutation = useMutation({
    mutationFn: async ({ id, uploadPostApiKey, uploadPostUser }: { id: string; uploadPostApiKey: string; uploadPostUser: string }) => {
      await apiRequest("PATCH", `/api/profiles/${id}/settings`, { uploadPostApiKey, uploadPostUser });
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", variables.id, "social-status"] });
    },
  });

  const uploadLogoMutation = useMutation({
    mutationFn: async ({ id, file }: { id: string; file: File }) => {
      const formData = new FormData();
      formData.append("logo", file);
      const res = await fetch(`/api/profiles/${id}/logo`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error("Logo upload failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
    },
  });

  const handleLogoUpload = (profileId: string) => {
    const input = logoInputRef.current;
    if (!input) return;
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        uploadLogoMutation.mutate({ id: profileId, file });
      }
      input.value = "";
    };
    input.click();
  };

  const handleSaveSettings = (profileId: string) => {
    const apiKey = localApiKey[profileId] ?? "";
    const user = localUser[profileId] ?? "";
    updateSettingsMutation.mutate({ id: profileId, uploadPostApiKey: apiKey, uploadPostUser: user });
  };

  const startEditing = (profile: StreamerProfile) => {
    const id = profile.id;
    if (editingId === id) {
      setEditingId(null);
      return;
    }
    setEditingId(id);
    setLocalApiKey((prev) => ({ ...prev, [id]: profile.uploadPostApiKey || "" }));
    setLocalUser((prev) => ({ ...prev, [id]: profile.uploadPostUser || "" }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>Профили стримеров</DialogTitle>
        </DialogHeader>

        <input
          ref={logoInputRef}
          type="file"
          accept=".png,.jpg,.jpeg,.webp"
          className="hidden"
        />

        <div className="space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder="Имя нового профиля..."
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              data-testid="input-profile-name"
            />
            <Button
              onClick={() => createMutation.mutate()}
              disabled={!newName.trim() || createMutation.isPending}
              data-testid="button-create-profile"
            >
              <Plus className="w-4 h-4 mr-2" />
              Создать
            </Button>
          </div>

          <div className="space-y-2 max-h-[500px] overflow-auto">
            {profiles.map((profile) => (
              <ProfileCard
                key={profile.id}
                profile={profile}
                isEditing={editingId === profile.id}
                showApiKey={showApiKey[profile.id] || false}
                localApiKey={localApiKey[profile.id] ?? profile.uploadPostApiKey ?? ""}
                localUser={localUser[profile.id] ?? profile.uploadPostUser ?? ""}
                onToggleEdit={() => startEditing(profile)}
                onDelete={() => deleteMutation.mutate(profile.id)}
                onLogoUpload={() => handleLogoUpload(profile.id)}
                onToggleShowApiKey={() => setShowApiKey((prev) => ({ ...prev, [profile.id]: !prev[profile.id] }))}
                onApiKeyChange={(v) => setLocalApiKey((prev) => ({ ...prev, [profile.id]: v }))}
                onUserChange={(v) => setLocalUser((prev) => ({ ...prev, [profile.id]: v }))}
                onSaveSettings={() => handleSaveSettings(profile.id)}
                onUpdateThresholds={(thresholds) => updateThresholdsMutation.mutate({ id: profile.id, thresholds })}
                isSaving={updateSettingsMutation.isPending}
                isLogoUploading={uploadLogoMutation.isPending}
              />
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProfileCard({
  profile,
  isEditing,
  showApiKey,
  localApiKey,
  localUser,
  onToggleEdit,
  onDelete,
  onLogoUpload,
  onToggleShowApiKey,
  onApiKeyChange,
  onUserChange,
  onSaveSettings,
  onUpdateThresholds,
  isSaving,
  isLogoUploading,
}: {
  profile: StreamerProfile;
  isEditing: boolean;
  showApiKey: boolean;
  localApiKey: string;
  localUser: string;
  onToggleEdit: () => void;
  onDelete: () => void;
  onLogoUpload: () => void;
  onToggleShowApiKey: () => void;
  onApiKeyChange: (v: string) => void;
  onUserChange: (v: string) => void;
  onSaveSettings: () => void;
  onUpdateThresholds: (thresholds: Record<string, number>) => void;
  isSaving: boolean;
  isLogoUploading: boolean;
}) {
  const { data: socialStatus, isLoading: socialLoading } = useQuery<SocialStatus>({
    queryKey: ["/api/profiles", profile.id, "social-status"],
    queryFn: async () => {
      const res = await fetch(`/api/profiles/${profile.id}/social-status`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: !!profile.uploadPostApiKey && !!profile.uploadPostUser,
    staleTime: 60000,
  });

  const hasUploadPost = !!profile.uploadPostApiKey && !!profile.uploadPostUser;
  const connectedPlatforms = socialStatus?.configured
    ? Object.entries(socialStatus.platforms)
        .filter(([k, v]) => v === true && k !== "accountNames")
        .map(([k]) => k)
    : [];

  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium truncate" data-testid={`text-profile-${profile.id}`}>
              {profile.name}
            </p>
            <div className="flex items-center gap-1 mt-1 flex-wrap">
              {profile.calibration ? (
                <Badge variant="outline"><CheckCircle2 className="w-3 h-3 mr-1" />Калиброван</Badge>
              ) : (
                <Badge variant="secondary">Без калибровки</Badge>
              )}
              {profile.logoPath ? (
                <Badge variant="outline"><Image className="w-3 h-3 mr-1" />Лого</Badge>
              ) : null}
              {hasUploadPost ? (
                socialLoading ? (
                  <Badge variant="outline"><Loader2 className="w-3 h-3 mr-1 animate-spin" />Соц. сети...</Badge>
                ) : connectedPlatforms.length > 0 ? (
                  <Badge variant="outline" className="text-green-600 border-green-300">
                    <Wifi className="w-3 h-3 mr-1" />
                    {connectedPlatforms.length} соц. {connectedPlatforms.length === 1 ? "сеть" : "сетей"}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-yellow-600 border-yellow-300">
                    <WifiOff className="w-3 h-3 mr-1" />Нет подключений
                  </Badge>
                )
              ) : (
                <Badge variant="secondary"><WifiOff className="w-3 h-3 mr-1" />Нет API</Badge>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              onClick={onLogoUpload}
              disabled={isLogoUploading}
              data-testid={`button-upload-logo-${profile.id}`}
            >
              <Upload className="w-4 h-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={onToggleEdit}
              data-testid={`button-edit-profile-${profile.id}`}
            >
              <Settings className="w-4 h-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={onDelete}
              data-testid={`button-delete-profile-${profile.id}`}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {isEditing && (
          <div className="mt-4 space-y-4 border-t pt-4">
            {profile.logoPath && (
              <div>
                <Label className="text-xs text-muted-foreground">Логотип (водяной знак)</Label>
                <div className="mt-1 flex items-center gap-2">
                  <div className="w-12 h-12 rounded-md bg-muted overflow-hidden flex items-center justify-center">
                    <img
                      src={`/api/profiles/${profile.id}/logo`}
                      alt="Logo"
                      className="max-w-full max-h-full object-contain"
                      data-testid={`img-logo-${profile.id}`}
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onLogoUpload}
                    data-testid={`button-change-logo-${profile.id}`}
                  >
                    Заменить
                  </Button>
                </div>
              </div>
            )}

            <div className="space-y-3 p-3 bg-muted/30 rounded-lg border">
              <Label className="text-xs font-medium">Upload-Post (соц. сети)</Label>
              <div>
                <Label className="text-xs text-muted-foreground">API ключ</Label>
                <div className="flex gap-1 mt-1">
                  <Input
                    type={showApiKey ? "text" : "password"}
                    placeholder="Apikey..."
                    value={localApiKey}
                    onChange={(e) => onApiKeyChange(e.target.value)}
                    className="text-xs"
                    data-testid={`input-api-key-${profile.id}`}
                  />
                  <Button size="icon" variant="ghost" onClick={onToggleShowApiKey} data-testid={`button-toggle-key-${profile.id}`}>
                    {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </Button>
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Имя пользователя</Label>
                <Input
                  placeholder="username..."
                  value={localUser}
                  onChange={(e) => onUserChange(e.target.value)}
                  className="text-xs mt-1"
                  data-testid={`input-user-${profile.id}`}
                />
              </div>
              <Button
                size="sm"
                onClick={onSaveSettings}
                disabled={isSaving}
                className="w-full"
                data-testid={`button-save-settings-${profile.id}`}
              >
                {isSaving ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
                Сохранить настройки
              </Button>

              {socialStatus?.configured && connectedPlatforms.length > 0 && (
                <div className="mt-2 space-y-1">
                  <Label className="text-xs text-muted-foreground">Подключённые платформы:</Label>
                  <div className="flex flex-wrap gap-1">
                    {connectedPlatforms.map((p) => (
                      <Badge key={p} variant="outline" className="text-green-600 border-green-300 text-xs">
                        {p === "instagram" ? "Instagram" : p === "tiktok" ? "TikTok" : p === "facebook" ? "Facebook" : p === "threads" ? "Threads" : p === "youtube" ? "YouTube" : p}
                        {socialStatus.platforms.accountNames?.[p] ? ` (${socialStatus.platforms.accountNames[p]})` : ""}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div>
              <Label className="text-xs text-muted-foreground">Порог RMS аудио</Label>
              <Slider
                min={0.01}
                max={0.5}
                step={0.01}
                value={[(profile.thresholds as any)?.audioRmsThreshold ?? 0.15]}
                onValueChange={([v]) =>
                  onUpdateThresholds({ ...((profile.thresholds as any) || {}), audioRmsThreshold: v })
                }
                data-testid={`slider-audio-threshold-${profile.id}`}
              />
              <span className="text-xs text-muted-foreground">
                {((profile.thresholds as any)?.audioRmsThreshold ?? 0.15).toFixed(2)}
              </span>
            </div>

            <div>
              <Label className="text-xs text-muted-foreground">Порог смены сцены</Label>
              <Slider
                min={0.1}
                max={0.9}
                step={0.05}
                value={[(profile.thresholds as any)?.sceneChangeThreshold ?? 0.4]}
                onValueChange={([v]) =>
                  onUpdateThresholds({ ...((profile.thresholds as any) || {}), sceneChangeThreshold: v })
                }
                data-testid={`slider-scene-threshold-${profile.id}`}
              />
              <span className="text-xs text-muted-foreground">
                {((profile.thresholds as any)?.sceneChangeThreshold ?? 0.4).toFixed(2)}
              </span>
            </div>

            <div>
              <Label className="text-xs text-muted-foreground">Мин. длина клипа (сек)</Label>
              <Slider
                min={10}
                max={90}
                step={5}
                value={[(profile.thresholds as any)?.minClipDuration ?? 20]}
                onValueChange={([v]) =>
                  onUpdateThresholds({ ...((profile.thresholds as any) || {}), minClipDuration: v })
                }
                data-testid={`slider-min-duration-${profile.id}`}
              />
              <span className="text-xs text-muted-foreground">
                {((profile.thresholds as any)?.minClipDuration ?? 20)}с
              </span>
            </div>

            <div>
              <Label className="text-xs text-muted-foreground">Макс. длина клипа (сек)</Label>
              <Slider
                min={20}
                max={120}
                step={5}
                value={[(profile.thresholds as any)?.maxClipDuration ?? 60]}
                onValueChange={([v]) =>
                  onUpdateThresholds({ ...((profile.thresholds as any) || {}), maxClipDuration: v })
                }
                data-testid={`slider-max-duration-${profile.id}`}
              />
              <span className="text-xs text-muted-foreground">
                {((profile.thresholds as any)?.maxClipDuration ?? 60)}с
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
