import { z } from 'zod';
import type { Settings } from '../shared/types';

export const settingsSchema = z
  .object({
    llmMode: z.enum(['external', 'managed']),
    modelDirectory: z.string().max(32768),
    serverPath: z.string().max(32768),
    managedModel: z.string().max(64),
    idleUnloadMinutes: z.number().int().min(0).max(120),
    motionLevel: z.enum(['off', 'gentle', 'lively']),
    renderQuality: z.enum(['eco', 'balanced', 'high']),
    endpoint: z.string().max(200),
    model: z.string().max(200),
    context: z.number().int().min(1024).max(131072),
    outputTokens: z.number().int().min(64).max(4096),
    persona: z.string().min(1).max(80),
    userName: z.string().max(80),
    style: z.string().max(2000),
    saveHistory: z.boolean(),
    avatarId: z.string().uuid().nullable(),
    avatarVisible: z.boolean(),
    scale: z.number().min(0.5).max(1.8),
    fps: z.number().int().min(10).max(60),
    alwaysOnTop: z.boolean(),
    autoStart: z.boolean(),
    avatarX: z.number().optional(),
    avatarY: z.number().optional(),
  })
  .strict();

// These fields belong to dedicated commands. Merge at commit time, after awaited work.
export function mergeSettingsEdit(edit: Settings, current: Settings): Settings {
  return {
    ...edit,
    avatarId: current.avatarId,
    avatarVisible: current.avatarVisible,
    avatarX: current.avatarX,
    avatarY: current.avatarY,
    modelDirectory: current.modelDirectory,
    serverPath: current.serverPath,
    managedModel: current.managedModel,
  };
}
