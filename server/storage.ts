import { eq, isNull, isNotNull, and } from "drizzle-orm";
import { db } from "./db";
import {
  streamerProfiles,
  videos,
  suggestedClips,
  exportJobs,
  generatedVideos,
  autoCuts,
  type InsertStreamerProfile,
  type StreamerProfile,
  type InsertVideo,
  type Video,
  type InsertSuggestedClip,
  type SuggestedClip,
  type InsertExportJob,
  type ExportJob,
  type CalibrationData,
  type ThresholdsData,
  type InsertGeneratedVideo,
  type GeneratedVideo,
  type InsertAutoCut,
  type AutoCut,
} from "@shared/schema";

export interface IStorage {
  getProfiles(): Promise<StreamerProfile[]>;
  getProfile(id: string): Promise<StreamerProfile | undefined>;
  createProfile(data: InsertStreamerProfile): Promise<StreamerProfile>;
  deleteProfile(id: string): Promise<void>;
  updateProfileCalibration(id: string, calibration: CalibrationData): Promise<StreamerProfile>;
  updateProfileThresholds(id: string, thresholds: ThresholdsData): Promise<StreamerProfile>;
  updateProfileLogo(id: string, logoPath: string): Promise<StreamerProfile>;
  updateProfile(id: string, data: Partial<StreamerProfile>): Promise<StreamerProfile>;

  getVideos(): Promise<Video[]>;
  getVideo(id: string): Promise<Video | undefined>;
  createVideo(data: InsertVideo): Promise<Video>;
  updateVideo(id: string, data: Partial<Video>): Promise<Video>;
  deleteVideo(id: string): Promise<void>;

  getClips(): Promise<SuggestedClip[]>;
  getClipsByVideoId(videoId: string): Promise<SuggestedClip[]>;
  getClip(id: string): Promise<SuggestedClip | undefined>;
  createClip(data: InsertSuggestedClip): Promise<SuggestedClip>;
  updateClip(id: string, data: Partial<SuggestedClip>): Promise<SuggestedClip>;
  deleteClip(id: string): Promise<void>;
  restoreClip(id: string): Promise<SuggestedClip>;
  getDeletedClipsByVideoId(videoId: string): Promise<SuggestedClip[]>;
  deleteClipsByVideoId(videoId: string): Promise<void>;

  getExportJobs(): Promise<ExportJob[]>;
  getExportJob(id: string): Promise<ExportJob | undefined>;
  createExportJob(data: InsertExportJob): Promise<ExportJob>;
  updateExportJob(id: string, data: Partial<ExportJob>): Promise<ExportJob>;
  getStaleExports(): Promise<ExportJob[]>;
  getStuckProcessingVideos(): Promise<Video[]>;

  getGeneratedVideos(): Promise<GeneratedVideo[]>;
  getGeneratedVideo(id: string): Promise<GeneratedVideo | undefined>;
  createGeneratedVideo(data: InsertGeneratedVideo): Promise<GeneratedVideo>;
  updateGeneratedVideo(id: string, data: Partial<GeneratedVideo>): Promise<GeneratedVideo>;
  deleteGeneratedVideo(id: string): Promise<void>;

  getAutoCuts(): Promise<AutoCut[]>;
  getAutoCutsByVideoId(videoId: string): Promise<AutoCut[]>;
  getAutoCut(id: string): Promise<AutoCut | undefined>;
  createAutoCut(data: InsertAutoCut): Promise<AutoCut>;
  updateAutoCut(id: string, data: Partial<AutoCut>): Promise<AutoCut>;
  deleteAutoCut(id: string): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async getProfiles(): Promise<StreamerProfile[]> {
    return db.select().from(streamerProfiles);
  }

  async getProfile(id: string): Promise<StreamerProfile | undefined> {
    const [profile] = await db.select().from(streamerProfiles).where(eq(streamerProfiles.id, id));
    return profile;
  }

  async createProfile(data: InsertStreamerProfile): Promise<StreamerProfile> {
    const [profile] = await db.insert(streamerProfiles).values([data as any]).returning();
    return profile;
  }

  async deleteProfile(id: string): Promise<void> {
    await db.delete(streamerProfiles).where(eq(streamerProfiles.id, id));
  }

  async updateProfileCalibration(id: string, calibration: CalibrationData): Promise<StreamerProfile> {
    const [profile] = await db
      .update(streamerProfiles)
      .set({ calibration })
      .where(eq(streamerProfiles.id, id))
      .returning();
    return profile;
  }

  async updateProfileThresholds(id: string, thresholds: ThresholdsData): Promise<StreamerProfile> {
    const [profile] = await db
      .update(streamerProfiles)
      .set({ thresholds })
      .where(eq(streamerProfiles.id, id))
      .returning();
    return profile;
  }

  async updateProfileLogo(id: string, logoPath: string): Promise<StreamerProfile> {
    const [profile] = await db
      .update(streamerProfiles)
      .set({ logoPath })
      .where(eq(streamerProfiles.id, id))
      .returning();
    return profile;
  }

  async updateProfile(id: string, data: Partial<StreamerProfile>): Promise<StreamerProfile> {
    const [profile] = await db
      .update(streamerProfiles)
      .set(data)
      .where(eq(streamerProfiles.id, id))
      .returning();
    return profile;
  }

  async getVideos(): Promise<Video[]> {
    return db.select().from(videos);
  }

  async getVideo(id: string): Promise<Video | undefined> {
    const [video] = await db.select().from(videos).where(eq(videos.id, id));
    return video;
  }

  async createVideo(data: InsertVideo): Promise<Video> {
    const [video] = await db.insert(videos).values(data).returning();
    return video;
  }

  async updateVideo(id: string, data: Partial<Video>): Promise<Video> {
    const [video] = await db.update(videos).set(data).where(eq(videos.id, id)).returning();
    return video;
  }

  async deleteVideo(id: string): Promise<void> {
    await db.delete(suggestedClips).where(eq(suggestedClips.videoId, id));
    await db.delete(videos).where(eq(videos.id, id));
  }

  async getClips(): Promise<SuggestedClip[]> {
    return db.select().from(suggestedClips);
  }

  async getClipsByVideoId(videoId: string): Promise<SuggestedClip[]> {
    return db.select().from(suggestedClips).where(and(eq(suggestedClips.videoId, videoId), isNull(suggestedClips.deletedAt)));
  }

  async getClip(id: string): Promise<SuggestedClip | undefined> {
    const [clip] = await db.select().from(suggestedClips).where(eq(suggestedClips.id, id));
    return clip;
  }

  async createClip(data: InsertSuggestedClip): Promise<SuggestedClip> {
    const [clip] = await db.insert(suggestedClips).values([data as any]).returning();
    return clip;
  }

  async updateClip(id: string, data: Partial<SuggestedClip>): Promise<SuggestedClip> {
    const [clip] = await db.update(suggestedClips).set(data).where(eq(suggestedClips.id, id)).returning();
    return clip;
  }

  async deleteClip(id: string): Promise<void> {
    await db.update(suggestedClips).set({ deletedAt: new Date() }).where(eq(suggestedClips.id, id));
  }

  async restoreClip(id: string): Promise<SuggestedClip> {
    const [clip] = await db.update(suggestedClips).set({ deletedAt: null }).where(eq(suggestedClips.id, id)).returning();
    return clip;
  }

  async getDeletedClipsByVideoId(videoId: string): Promise<SuggestedClip[]> {
    return db.select().from(suggestedClips).where(and(eq(suggestedClips.videoId, videoId), isNotNull(suggestedClips.deletedAt)));
  }

  async deleteClipsByVideoId(videoId: string): Promise<void> {
    await db.delete(suggestedClips).where(eq(suggestedClips.videoId, videoId));
  }

  async getExportJobs(): Promise<ExportJob[]> {
    return db.select().from(exportJobs);
  }

  async getExportJob(id: string): Promise<ExportJob | undefined> {
    const [job] = await db.select().from(exportJobs).where(eq(exportJobs.id, id));
    return job;
  }

  async createExportJob(data: InsertExportJob): Promise<ExportJob> {
    const [job] = await db.insert(exportJobs).values(data).returning();
    return job;
  }

  async updateExportJob(id: string, data: Partial<ExportJob>): Promise<ExportJob> {
    const [job] = await db.update(exportJobs).set(data).where(eq(exportJobs.id, id)).returning();
    return job;
  }

  async getStaleExports(): Promise<ExportJob[]> {
    return db.select().from(exportJobs).where(eq(exportJobs.status, "processing"));
  }

  async getStuckProcessingVideos(): Promise<Video[]> {
    return db.select().from(videos).where(eq(videos.status, "processing"));
  }

  async getGeneratedVideos(): Promise<GeneratedVideo[]> {
    return db.select().from(generatedVideos);
  }

  async getGeneratedVideo(id: string): Promise<GeneratedVideo | undefined> {
    const [v] = await db.select().from(generatedVideos).where(eq(generatedVideos.id, id));
    return v;
  }

  async createGeneratedVideo(data: InsertGeneratedVideo): Promise<GeneratedVideo> {
    const [v] = await db.insert(generatedVideos).values(data).returning();
    return v;
  }

  async updateGeneratedVideo(id: string, data: Partial<GeneratedVideo>): Promise<GeneratedVideo> {
    const [v] = await db.update(generatedVideos).set(data).where(eq(generatedVideos.id, id)).returning();
    return v;
  }

  async deleteGeneratedVideo(id: string): Promise<void> {
    await db.delete(generatedVideos).where(eq(generatedVideos.id, id));
  }

  async getAutoCuts(): Promise<AutoCut[]> {
    return db.select().from(autoCuts);
  }

  async getAutoCutsByVideoId(videoId: string): Promise<AutoCut[]> {
    return db.select().from(autoCuts).where(eq(autoCuts.videoId, videoId));
  }

  async getAutoCut(id: string): Promise<AutoCut | undefined> {
    const [cut] = await db.select().from(autoCuts).where(eq(autoCuts.id, id));
    return cut;
  }

  async createAutoCut(data: InsertAutoCut): Promise<AutoCut> {
    const [cut] = await db.insert(autoCuts).values([data as any]).returning();
    return cut;
  }

  async updateAutoCut(id: string, data: Partial<AutoCut>): Promise<AutoCut> {
    const [cut] = await db.update(autoCuts).set(data).where(eq(autoCuts.id, id)).returning();
    return cut;
  }

  async deleteAutoCut(id: string): Promise<void> {
    await db.delete(autoCuts).where(eq(autoCuts.id, id));
  }
}

export const storage = new DatabaseStorage();
