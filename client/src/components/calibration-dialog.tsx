import { useState, useRef, useEffect, useCallback } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { StreamerProfile } from "@shared/schema";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, RotateCcw, Wand2 } from "lucide-react";
import type { CropBox, CalibrationData, RegionAspectRatio } from "@shared/schema";

interface CalibrationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  videoId: string;
  profileId: string;
  clipId?: string;
  frameTime?: number;
  videoDuration?: number;
  onSave?: () => void;
  contentType?: string;
}

type BoxType = "table" | "webcam" | "chat";

const BOX_COLORS: Record<BoxType, string> = {
  table: "#22c55e",
  webcam: "#3b82f6",
  chat: "#f59e0b",
};

const BOX_LABELS: Record<BoxType, string> = {
  table: "Стол (TABLE)",
  webcam: "Вебкамера (WEBCAM)",
  chat: "Чат (CHAT)",
};

const BG_FRAME_W = 886 - 12;
const BG_FRAME_TOP_H = 827 - 236;
const BG_FRAME_BOT_H = 1452 - 861;

const TEMPLATE_ASPECT: Record<BoxType, number | null> = {
  table: BG_FRAME_W / BG_FRAME_TOP_H,
  webcam: BG_FRAME_W / BG_FRAME_BOT_H,
  chat: null,
};

function getAspectForMode(mode: RegionAspectRatio, boxType: BoxType): number | null {
  if (mode === "none") return null;
  if (mode === "9:16") return 9 / 16;
  if (mode === "1:1") return 1;
  return TEMPLATE_ASPECT[boxType];
}

const ASPECT_LABELS: Record<RegionAspectRatio, string> = {
  "free": "Шаблон",
  "9:16": "9:16",
  "1:1": "1:1",
  "none": "Свободная",
};

export default function CalibrationDialog({
  open,
  onOpenChange,
  videoId,
  profileId,
  clipId,
  frameTime,
  videoDuration,
  onSave,
  contentType,
}: CalibrationDialogProps) {
  const isStreamer = contentType === "streamer";
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [frameImage, setFrameImage] = useState<HTMLImageElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [streamerDualMode, setStreamerDualMode] = useState(false);
  const [streamerModeChosen, setStreamerModeChosen] = useState(!isStreamer);
  const [activeBox, setActiveBox] = useState<BoxType>(isStreamer ? "webcam" : "table");
  const [boxes, setBoxes] = useState<Partial<Record<BoxType, CropBox>>>({});
  const [drawing, setDrawing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState<{ dx: number; dy: number } | null>(null);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  type ResizeHandle = "tl" | "tr" | "bl" | "br" | "t" | "b" | "l" | "r";
  const [resizing, setResizing] = useState<ResizeHandle | null>(null);
  const [resizeAnchor, setResizeAnchor] = useState<CropBox | null>(null);
  const [sourceWidth, setSourceWidth] = useState(0);
  const [sourceHeight, setSourceHeight] = useState(0);
  const [regionAspectRatio, setRegionAspectRatio] = useState<RegionAspectRatio>("free");
  const [initialLoaded, setInitialLoaded] = useState(false);

  const { data: profiles = [] } = useQuery<StreamerProfile[]>({
    queryKey: ["/api/profiles"],
    queryFn: async () => {
      const res = await fetch("/api/profiles");
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const { data: clipCalibrationData } = useQuery({
    queryKey: ["/api/clips", clipId, "calibration"],
    queryFn: async () => {
      if (!clipId) return null;
      const res = await fetch(`/api/clips/${clipId}/calibration`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!clipId && open,
  });

  useEffect(() => {
    if (!open) {
      setInitialLoaded(false);
      return;
    }
    if (initialLoaded) return;
    if (clipId && clipCalibrationData === undefined) return;
    const profile = profiles.find((p) => p.id === profileId);
    const clipCal = clipId && clipCalibrationData ? clipCalibrationData as CalibrationData : null;
    const calSource = clipCal || (profile?.calibration as CalibrationData | null);
    if (calSource) {
      const cal = calSource;
      const loaded: Partial<Record<BoxType, CropBox>> = {};
      if (isStreamer && cal.table) {
        loaded.table = cal.table;
        setStreamerDualMode(true);
        setStreamerModeChosen(true);
      } else if (isStreamer && cal.webcam) {
        setStreamerDualMode(false);
        setStreamerModeChosen(true);
      } else if (!isStreamer && cal.table) {
        loaded.table = cal.table;
      }
      if (cal.webcam) loaded.webcam = cal.webcam;
      if (!isStreamer && cal.chat) loaded.chat = cal.chat;
      setBoxes(loaded);
      if (cal.regionAspectRatio) setRegionAspectRatio(cal.regionAspectRatio);
      if (isStreamer) {
        if (cal.table) {
          setActiveBox("table");
        } else {
          setActiveBox("webcam");
        }
      } else if (cal.table) {
        setActiveBox("webcam");
      }
    } else {
      setBoxes({});
      setStreamerDualMode(false);
      setStreamerModeChosen(!isStreamer);
      setActiveBox(isStreamer ? "webcam" : "table");
    }
    setInitialLoaded(true);
  }, [open, profiles, profileId, initialLoaded, clipId, clipCalibrationData]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);

    const defaultTime = videoDuration ? Math.round(videoDuration * 0.2) : 120;
    const t = frameTime != null ? frameTime : defaultTime;
    fetch(`/api/videos/${videoId}/frame?t=${t}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Frame fetch failed: ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        setFrameUrl(url);
        const img = new Image();
        img.onload = () => {
          setFrameImage(img);
          setSourceWidth(img.naturalWidth);
          setSourceHeight(img.naturalHeight);
          setLoading(false);
        };
        img.src = url;
      })
      .catch(() => setLoading(false));
  }, [open, videoId, frameTime]);

  const getCanvasScale = useCallback(() => {
    if (!canvasRef.current || !frameImage) return 1;
    return canvasRef.current.width / frameImage.naturalWidth;
  }, [frameImage]);

  const HANDLE_SIZE = 8;

  const getHandlePositions = useCallback((box: CropBox, scale: number) => {
    const sx = box.x * scale;
    const sy = box.y * scale;
    const sw = box.width * scale;
    const sh = box.height * scale;
    const hs = HANDLE_SIZE;
    return {
      tl: { x: sx - hs / 2, y: sy - hs / 2 },
      tr: { x: sx + sw - hs / 2, y: sy - hs / 2 },
      bl: { x: sx - hs / 2, y: sy + sh - hs / 2 },
      br: { x: sx + sw - hs / 2, y: sy + sh - hs / 2 },
      t:  { x: sx + sw / 2 - hs / 2, y: sy - hs / 2 },
      b:  { x: sx + sw / 2 - hs / 2, y: sy + sh - hs / 2 },
      l:  { x: sx - hs / 2, y: sy + sh / 2 - hs / 2 },
      r:  { x: sx + sw - hs / 2, y: sy + sh / 2 - hs / 2 },
    };
  }, []);

  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !frameImage) return;

    canvas.width = Math.min(800, frameImage.naturalWidth);
    canvas.height = (canvas.width / frameImage.naturalWidth) * frameImage.naturalHeight;

    const scale = canvas.width / frameImage.naturalWidth;

    ctx.drawImage(frameImage, 0, 0, canvas.width, canvas.height);

    for (const [boxType, box] of Object.entries(boxes) as [BoxType, CropBox][]) {
      if (!box) continue;
      const color = BOX_COLORS[boxType];
      const isActive = boxType === activeBox;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.strokeRect(box.x * scale, box.y * scale, box.width * scale, box.height * scale);
      ctx.setLineDash([]);

      ctx.fillStyle = color + "33";
      ctx.fillRect(box.x * scale, box.y * scale, box.width * scale, box.height * scale);

      ctx.fillStyle = color;
      ctx.font = "bold 14px Inter, sans-serif";
      ctx.fillText(BOX_LABELS[boxType as BoxType], box.x * scale + 4, box.y * scale + 16);

      if (isActive) {
        const handles = getHandlePositions(box, scale);
        for (const pos of Object.values(handles)) {
          ctx.fillStyle = "#ffffff";
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.fillRect(pos.x, pos.y, HANDLE_SIZE, HANDLE_SIZE);
          ctx.strokeRect(pos.x, pos.y, HANDLE_SIZE, HANDLE_SIZE);
        }
      }
    }
  }, [frameImage, boxes, activeBox, getHandlePositions]);

  useEffect(() => {
    drawCanvas();
  }, [drawCanvas]);

  const getCanvasCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !frameImage) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = frameImage.naturalWidth / rect.width;
    const scaleY = frameImage.naturalHeight / rect.height;
    return {
      x: Math.round((e.clientX - rect.left) * scaleX),
      y: Math.round((e.clientY - rect.top) * scaleY),
    };
  };

  const isInsideBox = (coords: { x: number; y: number }, box: CropBox): boolean => {
    return (
      coords.x >= box.x &&
      coords.x <= box.x + box.width &&
      coords.y >= box.y &&
      coords.y <= box.y + box.height
    );
  };

  const HANDLE_HIT = 12;

  const hitTestHandle = useCallback((coords: { x: number; y: number }, box: CropBox): ResizeHandle | null => {
    const edges = {
      left: Math.abs(coords.x - box.x) < HANDLE_HIT,
      right: Math.abs(coords.x - (box.x + box.width)) < HANDLE_HIT,
      top: Math.abs(coords.y - box.y) < HANDLE_HIT,
      bottom: Math.abs(coords.y - (box.y + box.height)) < HANDLE_HIT,
    };
    const inX = coords.x >= box.x - HANDLE_HIT && coords.x <= box.x + box.width + HANDLE_HIT;
    const inY = coords.y >= box.y - HANDLE_HIT && coords.y <= box.y + box.height + HANDLE_HIT;

    if (edges.top && edges.left) return "tl";
    if (edges.top && edges.right) return "tr";
    if (edges.bottom && edges.left) return "bl";
    if (edges.bottom && edges.right) return "br";
    if (edges.top && inX) return "t";
    if (edges.bottom && inX) return "b";
    if (edges.left && inY) return "l";
    if (edges.right && inY) return "r";
    return null;
  }, []);

  const HANDLE_CURSORS: Record<ResizeHandle, string> = {
    tl: "nwse-resize", tr: "nesw-resize", bl: "nesw-resize", br: "nwse-resize",
    t: "ns-resize", b: "ns-resize", l: "ew-resize", r: "ew-resize",
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const coords = getCanvasCoords(e);
    const activeBoxData = boxes[activeBox];

    if (activeBoxData) {
      const handle = hitTestHandle(coords, activeBoxData);
      if (handle) {
        setResizing(handle);
        setResizeAnchor({ ...activeBoxData });
        return;
      }
      if (isInsideBox(coords, activeBoxData)) {
        setDragging(true);
        setDragOffset({ dx: coords.x - activeBoxData.x, dy: coords.y - activeBoxData.y });
        return;
      }
    }
    setDrawing(true);
    setDrawStart(coords);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!frameImage) return;
    const coords = getCanvasCoords(e);
    const imgW = frameImage.naturalWidth;
    const imgH = frameImage.naturalHeight;

    if (resizing && resizeAnchor) {
      const anchor = resizeAnchor;
      const aspect = getAspectForMode(regionAspectRatio, activeBox);
      let newX = anchor.x;
      let newY = anchor.y;
      let newW = anchor.width;
      let newH = anchor.height;

      const applyAspect = (w: number, h: number, fromW: boolean): [number, number] => {
        if (!aspect) return [w, h];
        return fromW ? [w, Math.round(w / aspect)] : [Math.round(h * aspect), h];
      };

      if (resizing === "br") {
        newW = Math.max(20, coords.x - anchor.x);
        newH = Math.max(20, coords.y - anchor.y);
        [newW, newH] = applyAspect(newW, newH, newW / (newH || 1) > (aspect || 1));
      } else if (resizing === "bl") {
        newW = Math.max(20, anchor.x + anchor.width - coords.x);
        newH = Math.max(20, coords.y - anchor.y);
        [newW, newH] = applyAspect(newW, newH, newW / (newH || 1) > (aspect || 1));
        newX = anchor.x + anchor.width - newW;
      } else if (resizing === "tr") {
        newW = Math.max(20, coords.x - anchor.x);
        newH = Math.max(20, anchor.y + anchor.height - coords.y);
        [newW, newH] = applyAspect(newW, newH, newW / (newH || 1) > (aspect || 1));
        newY = anchor.y + anchor.height - newH;
      } else if (resizing === "tl") {
        newW = Math.max(20, anchor.x + anchor.width - coords.x);
        newH = Math.max(20, anchor.y + anchor.height - coords.y);
        [newW, newH] = applyAspect(newW, newH, newW / (newH || 1) > (aspect || 1));
        newX = anchor.x + anchor.width - newW;
        newY = anchor.y + anchor.height - newH;
      } else if (resizing === "r") {
        newW = Math.max(20, coords.x - anchor.x);
        if (aspect) [newW, newH] = applyAspect(newW, newH, true);
      } else if (resizing === "l") {
        newW = Math.max(20, anchor.x + anchor.width - coords.x);
        if (aspect) [newW, newH] = applyAspect(newW, newH, true);
        newX = anchor.x + anchor.width - newW;
      } else if (resizing === "b") {
        newH = Math.max(20, coords.y - anchor.y);
        if (aspect) [newW, newH] = applyAspect(newW, newH, false);
      } else if (resizing === "t") {
        newH = Math.max(20, anchor.y + anchor.height - coords.y);
        if (aspect) [newW, newH] = applyAspect(newW, newH, false);
        newY = anchor.y + anchor.height - newH;
      }

      newX = Math.max(0, Math.min(newX, imgW - newW));
      newY = Math.max(0, Math.min(newY, imgH - newH));
      newW = Math.min(newW, imgW - newX);
      newH = Math.min(newH, imgH - newY);

      setBoxes((prev) => ({
        ...prev,
        [activeBox]: { x: Math.round(newX), y: Math.round(newY), width: Math.round(newW), height: Math.round(newH) },
      }));
      return;
    }

    if (dragging && dragOffset) {
      const box = boxes[activeBox];
      if (!box) return;

      let newX = coords.x - dragOffset.dx;
      let newY = coords.y - dragOffset.dy;

      newX = Math.max(0, Math.min(newX, imgW - box.width));
      newY = Math.max(0, Math.min(newY, imgH - box.height));

      setBoxes((prev) => ({
        ...prev,
        [activeBox]: { ...box, x: Math.round(newX), y: Math.round(newY) },
      }));
      return;
    }

    if (!drawing || !drawStart) return;
    const aspect = getAspectForMode(regionAspectRatio, activeBox);

    let rawW = coords.x - drawStart.x;
    let rawH = coords.y - drawStart.y;

    if (aspect) {
      const absW = Math.abs(rawW);
      const absH = Math.abs(rawH);
      const hFromW = absW / aspect;
      const wFromH = absH * aspect;
      if (absW / aspect > absH) {
        rawH = Math.sign(rawH || 1) * hFromW;
      } else {
        rawW = Math.sign(rawW || 1) * wFromH;
      }
    }

    let x = rawW >= 0 ? drawStart.x : drawStart.x + rawW;
    let y = rawH >= 0 ? drawStart.y : drawStart.y + rawH;
    let w = Math.abs(rawW);
    let h = Math.abs(rawH);

    x = Math.max(0, Math.min(x, imgW - w));
    y = Math.max(0, Math.min(y, imgH - h));

    const newBox: CropBox = { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
    setBoxes((prev) => ({ ...prev, [activeBox]: newBox }));
  };

  const handleMouseUp = () => {
    setDrawing(false);
    setDragging(false);
    setResizing(null);
    setResizeAnchor(null);
    setDrawStart(null);
    setDragOffset(null);
  };

  const autoDetectMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/videos/${videoId}/auto-calibrate?profileId=${profileId}`);
      return res.json();
    },
    onSuccess: (data) => {
      const detected: Partial<Record<BoxType, CropBox>> = {};
      if (data.table) detected.table = data.table;
      if (data.webcam) detected.webcam = data.webcam;
      if (data.chat) detected.chat = data.chat;
      setBoxes(detected);
      if (data.sourceWidth) setSourceWidth(data.sourceWidth);
      if (data.sourceHeight) setSourceHeight(data.sourceHeight);
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!boxes.table && !boxes.webcam) {
        throw new Error("Нужна хотя бы одна область");
      }
      const calibration: CalibrationData = {
        table: (isStreamer && !streamerDualMode) ? undefined : boxes.table,
        webcam: boxes.webcam,
        chat: isStreamer ? undefined : boxes.chat,
        sourceWidth,
        sourceHeight,
        regionAspectRatio,
      };
      if (clipId) {
        await apiRequest("PATCH", `/api/clips/${clipId}/calibration`, calibration);
      } else {
        await apiRequest("PATCH", `/api/profiles/${profileId}/calibration`, calibration);
      }
    },
    onSuccess: () => {
      if (clipId) {
        queryClient.invalidateQueries({ queryKey: ["/api/clips"] });
      } else {
        queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      }
      onOpenChange(false);
      onSave?.();
    },
  });

  const hasAnyRegion = !!boxes.table || !!boxes.webcam;
  const isSingleRegion = (!!boxes.table) !== (!!boxes.webcam);
  const currentAspect = getAspectForMode(regionAspectRatio, activeBox);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[900px] max-h-[90vh] overflow-auto" onPointerDownOutside={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Калибровка областей</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : isStreamer && !streamerModeChosen ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">Выберите тип калибровки:</p>
            <div className="grid grid-cols-2 gap-4">
              <button
                onClick={() => {
                  setStreamerDualMode(false);
                  setStreamerModeChosen(true);
                  setActiveBox("webcam");
                  setBoxes({});
                }}
                className="flex flex-col items-center gap-3 p-6 rounded-lg border-2 border-muted hover:border-blue-500 hover:bg-blue-500/5 transition-all cursor-pointer text-center"
                data-testid="button-choose-single-crop"
              >
                <div className="w-16 h-28 rounded-lg border-2 border-blue-500 bg-blue-500/10 flex items-center justify-center">
                  <span className="text-2xl">👤</span>
                </div>
                <div>
                  <div className="font-medium text-sm">Один кроп</div>
                  <div className="text-xs text-muted-foreground mt-1">Выделить область стримера — лицо найдётся автоматически и будет вырезан 9:16 кроп</div>
                </div>
              </button>
              <button
                onClick={() => {
                  setStreamerDualMode(true);
                  setStreamerModeChosen(true);
                  setActiveBox("table");
                  setBoxes({});
                }}
                className="flex flex-col items-center gap-3 p-6 rounded-lg border-2 border-muted hover:border-green-500 hover:bg-green-500/5 transition-all cursor-pointer text-center"
                data-testid="button-choose-dual-crop"
              >
                <div className="flex flex-col gap-1">
                  <div className="w-16 h-12 rounded-t-lg border-2 border-green-500 bg-green-500/10 flex items-center justify-center">
                    <span className="text-lg">🖥️</span>
                  </div>
                  <div className="w-16 h-12 rounded-b-lg border-2 border-blue-500 bg-blue-500/10 flex items-center justify-center">
                    <span className="text-lg">👤</span>
                  </div>
                </div>
                <div>
                  <div className="font-medium text-sm">Два кропа</div>
                  <div className="text-xs text-muted-foreground mt-1">Две области складываются вертикально — как в покерном режиме (верх + низ)</div>
                </div>
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {isStreamer && (
              <div className="flex items-center gap-2 mb-1">
                <button
                  onClick={() => {
                    setStreamerModeChosen(false);
                    setBoxes({});
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground underline"
                  data-testid="button-back-to-mode-select"
                >
                  ← Сменить режим
                </button>
                <Badge variant="secondary" className="text-xs">
                  {streamerDualMode ? "Два кропа" : "Один кроп"}
                </Badge>
              </div>
            )}
            <div className="flex items-center gap-2 flex-wrap">
              {(isStreamer
                ? (streamerDualMode ? ["table", "webcam"] as BoxType[] : ["webcam"] as BoxType[])
                : ["table", "webcam", "chat"] as BoxType[]
              ).map((type) => (
                <Button
                  key={type}
                  variant={activeBox === type ? "default" : "outline"}
                  onClick={() => setActiveBox(type)}
                  className="toggle-elevate"
                  data-testid={`button-box-${type}`}
                >
                  <span
                    className="w-3 h-3 rounded-sm mr-2 flex-shrink-0"
                    style={{ backgroundColor: BOX_COLORS[type] }}
                  />
                  {isStreamer && !streamerDualMode && type === "webcam" ? "Область стримера" :
                   isStreamer && streamerDualMode && type === "table" ? "Область 1 (верх)" :
                   isStreamer && streamerDualMode && type === "webcam" ? "Область 2 (низ)" :
                   BOX_LABELS[type]}
                  {type === "chat" && (
                    <Badge variant="secondary" className="ml-2">опционально</Badge>
                  )}
                  {boxes[type] && <span className="ml-2 text-xs opacity-60">OK</span>}
                </Button>
              ))}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setBoxes({})}
                data-testid="button-reset-calibration"
              >
                <RotateCcw className="w-4 h-4" />
              </Button>
              <div className="ml-auto">
                <Button
                  variant="outline"
                  onClick={() => autoDetectMutation.mutate()}
                  disabled={autoDetectMutation.isPending}
                  data-testid="button-auto-detect"
                >
                  {autoDetectMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Wand2 className="w-4 h-4 mr-2" />
                  )}
                  {autoDetectMutation.isPending ? "AI анализирует..." : "AI авто-детект"}
                </Button>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground mr-1">Формат области:</span>
              {(["free", "9:16", "1:1", "none"] as RegionAspectRatio[]).map((ar) => (
                <Button
                  key={ar}
                  variant={regionAspectRatio === ar ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    const wasAlready = regionAspectRatio === ar;
                    setRegionAspectRatio(ar);
                    if (!wasAlready && ar !== "free" && ar !== "none" && frameImage && !boxes[activeBox]) {
                      const aspect = ar === "9:16" ? 9 / 16 : 1;
                      const imgW = frameImage.naturalWidth;
                      const imgH = frameImage.naturalHeight;
                      let boxH = imgH;
                      let boxW = Math.round(boxH * aspect);
                      if (boxW > imgW) {
                        boxW = imgW;
                        boxH = Math.round(boxW / aspect);
                      }
                      const boxX = Math.round((imgW - boxW) / 2);
                      const boxY = Math.round((imgH - boxH) / 2);
                      setBoxes((prev) => ({
                        ...prev,
                        [activeBox]: { x: boxX, y: boxY, width: boxW, height: boxH },
                      }));
                    }
                  }}
                  data-testid={`button-aspect-${ar}`}
                >
                  {ASPECT_LABELS[ar]}
                </Button>
              ))}
            </div>

            {autoDetectMutation.isError && (
              <p className="text-sm text-destructive" data-testid="text-auto-detect-error">
                {(autoDetectMutation.error as Error).message}
              </p>
            )}

            <p className="text-sm text-muted-foreground">
              {isStreamer && !streamerDualMode ? (
                <>Выдели область со стримером мышкой — внутри неё будет найдено лицо и вырезан <strong>9:16 кроп</strong></>
              ) : isStreamer && streamerDualMode ? (
                <>Выдели <strong>две области</strong> — они будут сложены вертикально (верх + низ) как в покерном режиме</>
              ) : (
                <>Рисуй прямоугольники мышкой для выделения области <strong>{BOX_LABELS[activeBox]}</strong>, или нажми <strong>AI авто-детект</strong> для автоматического определения</>
              )}
              {currentAspect && (
                <span className="ml-1 opacity-70">
                  (пропорции: {regionAspectRatio === "free" ? "шаблон" : regionAspectRatio === "none" ? "свободная" : regionAspectRatio})
                </span>
              )}
            </p>

            {isSingleRegion && !isStreamer && (
              <p className="text-sm text-yellow-500">
                Выбрана одна область — видео будет рендериться без деления
              </p>
            )}

            <div className="border rounded-md overflow-hidden bg-black">
              <canvas
                ref={canvasRef}
                className="w-full"
                style={{ cursor: resizing ? HANDLE_CURSORS[resizing] : dragging ? "grabbing" : "crosshair" }}
                onMouseDown={handleMouseDown}
                onMouseMove={(e) => {
                  handleMouseMove(e);
                  if (!dragging && !drawing && !resizing) {
                    const coords = getCanvasCoords(e);
                    const box = boxes[activeBox];
                    const canvas = canvasRef.current;
                    if (canvas && box) {
                      const handle = hitTestHandle(coords, box);
                      if (handle) {
                        canvas.style.cursor = HANDLE_CURSORS[handle];
                      } else if (isInsideBox(coords, box)) {
                        canvas.style.cursor = "grab";
                      } else {
                        canvas.style.cursor = "crosshair";
                      }
                    } else if (canvas) {
                      canvas.style.cursor = "crosshair";
                    }
                  }
                }}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                data-testid="canvas-calibration"
              />
            </div>
          </div>
        )}

        {(!isStreamer || streamerModeChosen) && (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-calibration">
              Отмена
            </Button>
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={!hasAnyRegion || saveMutation.isPending}
              data-testid="button-save-calibration"
            >
              {saveMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : null}
              Сохранить калибровку
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
