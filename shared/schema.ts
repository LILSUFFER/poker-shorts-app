import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, real, boolean, jsonb, timestamp, bigint } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const boxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export type CropBox = z.infer<typeof boxSchema>;

export const regionAspectRatioSchema = z.enum(["9:16", "1:1", "free", "none"]).default("free");
export type RegionAspectRatio = z.infer<typeof regionAspectRatioSchema>;

export const calibrationSchema = z.object({
  table: boxSchema.optional(),
  webcam: boxSchema.optional(),
  chat: boxSchema.optional(),
  sourceWidth: z.number(),
  sourceHeight: z.number(),
  regionAspectRatio: regionAspectRatioSchema.optional(),
});

export type CalibrationData = z.infer<typeof calibrationSchema>;

export const thresholdsSchema = z.object({
  audioRmsThreshold: z.number().default(0.15),
  sceneChangeThreshold: z.number().default(0.4),
  minClipDuration: z.number().default(20),
  maxClipDuration: z.number().default(60),
  ocrKeywordWeights: z.record(z.string(), z.number()).default({}),
});

export type ThresholdsData = z.infer<typeof thresholdsSchema>;

export const contentTypes = ["poker", "streamer"] as const;
export type ContentType = (typeof contentTypes)[number];

export const streamerProfiles = pgTable("streamer_profiles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  contentType: text("content_type").notNull().default("poker").$type<ContentType>(),
  calibration: jsonb("calibration").$type<CalibrationData>(),
  thresholds: jsonb("thresholds").$type<ThresholdsData>(),
  logoPath: text("logo_path"),
  uploadPostApiKey: text("upload_post_api_key"),
  uploadPostUser: text("upload_post_user"),
  vkEnabled: boolean("vk_enabled").default(true),
  postmypostProjectId: integer("postmypost_project_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertStreamerProfileSchema = createInsertSchema(streamerProfiles).omit({ id: true, createdAt: true });
export type InsertStreamerProfile = z.infer<typeof insertStreamerProfileSchema>;
export type StreamerProfile = typeof streamerProfiles.$inferSelect;

export const videos = pgTable("videos", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  filename: text("filename").notNull(),
  originalName: text("original_name").notNull(),
  filepath: text("filepath").notNull(),
  fileSize: bigint("file_size", { mode: "number" }),
  youtubeUrl: text("youtube_url"),
  duration: real("duration"),
  width: integer("width"),
  height: integer("height"),
  profileId: varchar("profile_id"),
  contentType: text("content_type").notNull().default("poker").$type<ContentType>(),
  status: text("status").notNull().default("uploaded"),
  thumbnailPath: text("thumbnail_path"),
  vpsPath: text("vps_path"),
  vpsVideoId: text("vps_video_id"),
  transcription: text("transcription"),
  transcriptionSegments: jsonb("transcription_segments").$type<TranscriptSegment[]>(),
  highlights: jsonb("highlights").$type<HighlightMoment[]>(),
  pipelineStep: text("pipeline_step"),
  pipelineProgress: integer("pipeline_progress").default(0),
  pipelineError: text("pipeline_error"),
  analysisMode: text("analysis_mode"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertVideoSchema = createInsertSchema(videos).omit({ id: true, createdAt: true });
export type InsertVideo = z.infer<typeof insertVideoSchema>;
export type Video = typeof videos.$inferSelect;

export interface WordTimestamp {
  word: string;
  start: number | null;
  end: number | null;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words?: WordTimestamp[];
}

export interface HighlightMoment {
  startTime: number;
  endTime: number;
  title: string;
  description: string;
  excitement: number;
  tags: string[];
  dropTime?: number;
}

export const suggestedClips = pgTable("suggested_clips", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  videoId: varchar("video_id").notNull(),
  startTime: real("start_time").notNull(),
  endTime: real("end_time").notNull(),
  confidence: real("confidence").notNull(),
  title: text("title"),
  description: text("description"),
  reasons: jsonb("reasons").$type<string[]>().notNull(),
  signals: jsonb("signals").$type<Record<string, number>>().notNull(),
  status: text("status").notNull().default("pending"),
  adjustedStartTime: real("adjusted_start_time"),
  adjustedEndTime: real("adjusted_end_time"),
  dropTime: real("drop_time"),
  calibration: jsonb("calibration").$type<CalibrationData>(),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertSuggestedClipSchema = createInsertSchema(suggestedClips).omit({ id: true, createdAt: true });
export type InsertSuggestedClip = z.infer<typeof insertSuggestedClipSchema>;
export type SuggestedClip = typeof suggestedClips.$inferSelect;

export const exportJobs = pgTable("export_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  videoId: varchar("video_id").notNull(),
  clipId: varchar("clip_id").notNull(),
  profileId: varchar("profile_id").notNull(),
  status: text("status").notNull().default("queued"),
  outputPath: text("output_path"),
  watermarkEnabled: boolean("watermark_enabled").default(true),
  subtitlesEnabled: boolean("subtitles_enabled").default(false),
  isPreview: boolean("is_preview").default(false),
  aspectRatio: text("aspect_ratio").default("9:16"),
  progress: integer("progress").default(0),
  error: text("error"),
  thumbnailPath: text("thumbnail_path"),
  cleanOutputPath: text("clean_output_path"),
  publishedTo: text("published_to").array().default(sql`'{}'::text[]`),
  publishedUrls: jsonb("published_urls").default(sql`'{}'::jsonb`),
  publishedAt: timestamp("published_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertExportJobSchema = createInsertSchema(exportJobs).omit({ id: true, createdAt: true, publishedAt: true });
export type InsertExportJob = z.infer<typeof insertExportJobSchema>;
export type ExportJob = typeof exportJobs.$inferSelect;

export const youtubeTokens = pgTable("youtube_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  expiryDate: bigint("expiry_date", { mode: "number" }),
  channelTitle: text("channel_title"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type YouTubeToken = typeof youtubeTokens.$inferSelect;

export const socialTokens = pgTable("social_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  platform: text("platform").notNull(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  expiryDate: bigint("expiry_date", { mode: "number" }),
  accountName: text("account_name"),
  accountId: text("account_id"),
  extra: jsonb("extra").$type<Record<string, any>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type SocialToken = typeof socialTokens.$inferSelect;

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const autoCuts = pgTable("auto_cuts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  videoId: varchar("video_id").notNull(),
  profileId: varchar("profile_id").notNull(),
  startTime: real("start_time").notNull(),
  endTime: real("end_time").notNull(),
  title: text("title"),
  description: text("description"),
  excitement: integer("excitement").default(0),
  tags: jsonb("tags").$type<string[]>().default([]),
  hookLine: text("hook_line"),
  dropTime: real("drop_time"),
  status: text("status").notNull().default("queued"),
  outputPath: text("output_path"),
  thumbnailPath: text("thumbnail_path"),
  progress: integer("progress").default(0),
  error: text("error"),
  captionStyle: text("caption_style").default("mrbeast"),
  aspectRatio: text("aspect_ratio").default("9:16"),
  renderEngine: text("render_engine").default("runpod"),
  publishedTo: text("published_to").array().default(sql`'{}'::text[]`),
  publishedUrls: jsonb("published_urls").default(sql`'{}'::jsonb`),
  publishedAt: timestamp("published_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertAutoCutSchema = createInsertSchema(autoCuts).omit({ id: true, createdAt: true, publishedAt: true });
export type InsertAutoCut = z.infer<typeof insertAutoCutSchema>;
export type AutoCut = typeof autoCuts.$inferSelect;

export const generatedVideos = pgTable("generated_videos", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title"),
  status: text("status").default("draft").notNull(),
  clips: jsonb("clips").$type<GeneratedClip[]>().default([]),
  scenario: jsonb("scenario").$type<SceneData[]>(),
  narrationText: text("narration_text"),
  ttsPath: text("tts_path"),
  finalOutputPath: text("final_output_path"),
  finalDuration: real("final_duration"),
  publishedTo: text("published_to").array(),
  publishedUrls: jsonb("published_urls").$type<Record<string, string>>(),
  profileId: varchar("profile_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export interface SceneData {
  sceneIndex: number;
  visualPrompt: string;
  narrationText: string;
  durationHint: number;
  sceneType?: "intro" | "question" | "outcome_wrong" | "outcome_correct" | "progression" | "climax" | "conclusion";
  optionLabel?: string;
  imagePrompt?: string;
  imagePath?: string;
}

export interface GeneratedClip {
  id: string;
  prompt: string;
  status: "pending" | "generating" | "completed" | "error";
  sceneIndex?: number;
  xaiJobId?: string;
  videoUrl?: string;
  localPath?: string;
  duration?: number;
  error?: string;
  createdAt: string;
}

export const insertGeneratedVideoSchema = createInsertSchema(generatedVideos).omit({
  id: true,
  createdAt: true,
});

export type InsertGeneratedVideo = z.infer<typeof insertGeneratedVideoSchema>;
export type GeneratedVideo = typeof generatedVideos.$inferSelect;
