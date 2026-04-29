export const THEME_STORAGE_KEY = 'dashboard.theme';
export const HEATMAP_PALETTE_STORAGE_KEY = 'dashboard.heatmap.palette';
export const HEATMAP_PALETTE_EVENT = 'dashboard:heatmap-palette';
export const QUEUE_SOUND_AI_STORAGE_KEY = 'dashboard.sound.ai';
export const QUEUE_SOUND_AFA_STORAGE_KEY = 'dashboard.sound.afa';
export const QUEUE_SOUND_SETTINGS_EVENT = 'dashboard:queue-sound-settings';
export const QUEUE_SOUND_TEST_EVENT = 'dashboard:queue-sound-test';

export const THEME_OPTIONS = ['dark', 'light'] as const;
export type DashboardTheme = (typeof THEME_OPTIONS)[number];

export const HEATMAP_PALETTE_OPTIONS = ['viridis', 'magma', 'plasma', 'inferno'] as const;
export type HeatmapPalette = (typeof HEATMAP_PALETTE_OPTIONS)[number];

export const QUEUE_SOUND_OPTIONS = ['soft', 'alert', 'chime', 'ping', 'bell', 'pulse', 'off'] as const;
export type QueueSoundSetting = (typeof QUEUE_SOUND_OPTIONS)[number];

export type QueueSoundSettings = {
  AI: QueueSoundSetting;
  AFA: QueueSoundSetting;
};

export type QueueSoundTestRequest = {
  queue: keyof QueueSoundSettings;
  sound: QueueSoundSetting;
};

export function isDashboardTheme(value: unknown): value is DashboardTheme {
  return typeof value === 'string' && THEME_OPTIONS.includes(value as DashboardTheme);
}

export function isHeatmapPalette(value: unknown): value is HeatmapPalette {
  return typeof value === 'string' && HEATMAP_PALETTE_OPTIONS.includes(value as HeatmapPalette);
}

export function isQueueSoundSetting(value: unknown): value is QueueSoundSetting {
  return typeof value === 'string' && QUEUE_SOUND_OPTIONS.includes(value as QueueSoundSetting);
}

export function getStoredQueueSoundSetting(
  key: typeof QUEUE_SOUND_AI_STORAGE_KEY | typeof QUEUE_SOUND_AFA_STORAGE_KEY,
  fallback: QueueSoundSetting
): QueueSoundSetting {
  if (typeof window === 'undefined') return fallback;
  const rawValue = window.localStorage.getItem(key);
  return isQueueSoundSetting(rawValue) ? rawValue : fallback;
}
