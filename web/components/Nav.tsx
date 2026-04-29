'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { HealthResponse } from '@/lib/dashboard-types';
import {
  HEATMAP_PALETTE_EVENT,
  HEATMAP_PALETTE_OPTIONS,
  HEATMAP_PALETTE_STORAGE_KEY,
  QUEUE_SOUND_AFA_STORAGE_KEY,
  QUEUE_SOUND_AI_STORAGE_KEY,
  QUEUE_SOUND_OPTIONS,
  QUEUE_SOUND_SETTINGS_EVENT,
  QUEUE_SOUND_TEST_EVENT,
  THEME_STORAGE_KEY,
  getStoredQueueSoundSetting,
  isDashboardTheme,
  isHeatmapPalette,
} from '@/lib/ui-settings';
import type {
  DashboardTheme,
  HeatmapPalette,
  QueueSoundSetting,
  QueueSoundSettings,
} from '@/lib/ui-settings';

function relTime(iso: string | null, now: number): string {
  if (!iso) return 'n/d';
  const delta = now - new Date(iso).getTime();
  if (delta < 0) return 'adesso';

  const seconds = Math.round(delta / 1000);
  if (seconds < 5) return 'adesso';
  if (seconds < 60) return `${seconds}s fa`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min fa`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h fa`;

  return `${Math.round(hours / 24)} g fa`;
}

function formatCollectorEvent(event: HealthResponse['last_collector_event']): string {
  if (!event) return 'nessun evento';
  return `${event.event_type.replace(/_/g, ' ')} · ${relTime(event.time, Date.now())}`;
}

function applyTheme(theme: DashboardTheme) {
  document.documentElement.dataset.theme = theme;
}

function formatPaletteLabel(palette: HeatmapPalette): string {
  return palette.charAt(0).toUpperCase() + palette.slice(1);
}

function formatQueueSoundLabel(sound: QueueSoundSetting): string {
  if (sound === 'soft') return 'Soft';
  if (sound === 'alert') return 'Alert';
  if (sound === 'chime') return 'Chime';
  if (sound === 'ping') return 'Ping';
  if (sound === 'bell') return 'Bell';
  if (sound === 'pulse') return 'Pulse';
  return 'Off';
}

export default function Nav() {
  const panelRef = useRef<HTMLDivElement>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<DashboardTheme>('dark');
  const [palette, setPalette] = useState<HeatmapPalette>('viridis');
  const [queueSoundSettings, setQueueSoundSettings] = useState<QueueSoundSettings>({
    AI: 'soft',
    AFA: 'alert',
  });
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    const nextTheme = isDashboardTheme(storedTheme) ? storedTheme : 'dark';
    setTheme(nextTheme);
    applyTheme(nextTheme);

    const storedPalette = window.localStorage.getItem(HEATMAP_PALETTE_STORAGE_KEY);
    if (isHeatmapPalette(storedPalette)) {
      setPalette(storedPalette);
    }

    setQueueSoundSettings({
      AI: getStoredQueueSoundSetting(QUEUE_SOUND_AI_STORAGE_KEY, 'soft'),
      AFA: getStoredQueueSoundSetting(QUEUE_SOUND_AFA_STORAGE_KEY, 'alert'),
    });
  }, []);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) {
        setIsSettingsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsSettingsOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const fetchHealth = async () => {
      try {
        const response = await fetch('/api/health', { cache: 'no-store' });
        if (!response.ok) return;
        const nextHealth = (await response.json()) as HealthResponse;
        if (!cancelled) setHealth(nextHealth);
      } catch {
        // keep the last known collector state
      }
    };

    void fetchHealth();
    const id = setInterval(() => {
      void fetchHealth();
    }, 30_000);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const collectorTone = health?.collector_status === 'online' && !health.gap_open ? 'ok' : 'warn';
  const collectorSummary = useMemo(() => {
    if (!health) return 'carico collector';
    if (health.gap_open) return 'buco dati aperto';
    return health.collector_status === 'online' ? 'collector online' : 'collector offline';
  }, [health]);

  const handleThemeChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextTheme = event.currentTarget.value;
    if (!isDashboardTheme(nextTheme)) return;
    setTheme(nextTheme);
    applyTheme(nextTheme);
    window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  };

  const handlePaletteChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextPalette = event.currentTarget.value;
    if (!isHeatmapPalette(nextPalette)) return;
    setPalette(nextPalette);
    window.localStorage.setItem(HEATMAP_PALETTE_STORAGE_KEY, nextPalette);
    window.dispatchEvent(new CustomEvent<HeatmapPalette>(HEATMAP_PALETTE_EVENT, {
      detail: nextPalette,
    }));
  };

  const handleQueueSoundChange =
    (queue: keyof QueueSoundSettings) => (event: ChangeEvent<HTMLSelectElement>) => {
      const nextValue = event.currentTarget.value as QueueSoundSetting;
      const nextSettings = {
        ...queueSoundSettings,
        [queue]: nextValue,
      };
      setQueueSoundSettings(nextSettings);
      window.localStorage.setItem(
        queue === 'AI' ? QUEUE_SOUND_AI_STORAGE_KEY : QUEUE_SOUND_AFA_STORAGE_KEY,
        nextValue
      );
      window.dispatchEvent(new CustomEvent<QueueSoundSettings>(QUEUE_SOUND_SETTINGS_EVENT, {
        detail: nextSettings,
      }));
      window.dispatchEvent(new CustomEvent(QUEUE_SOUND_TEST_EVENT, {
        detail: {
          queue,
          sound: nextValue,
        },
      }));
    };

  return (
    <nav className="topbar" aria-label="Navigazione principale">
      <div className="topbar-brand">
        <span className="brand-mark">VP</span>
        <div>
          <div className="brand-name">
            Vine <span>Pulse</span>
          </div>
          <div className="brand-subtitle">Monitoraggio Amazon Vine</div>
        </div>
      </div>

      <div className="topbar-meta" ref={panelRef}>
        <button
          type="button"
          className="topbar-chip live topbar-settings-trigger"
          aria-label={isSettingsOpen ? 'Chiudi settings realtime' : 'Apri settings realtime'}
          aria-expanded={isSettingsOpen}
          aria-controls="topbar-settings-panel"
          title={isSettingsOpen ? 'Chiudi settings realtime' : 'Apri settings realtime'}
          onClick={() => setIsSettingsOpen((current) => !current)}
        >
          <span className="topbar-live-dot" />
          realtime
          <svg
            className="topbar-disclosure-icon"
            viewBox="0 0 16 16"
            width="12"
            height="12"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M4.2 6.2a.8.8 0 0 1 1.13 0L8 8.88l2.67-2.67a.8.8 0 1 1 1.13 1.13l-3.24 3.24a.8.8 0 0 1-1.13 0L4.2 7.34a.8.8 0 0 1 0-1.13Z" fill="currentColor" />
          </svg>
        </button>

        {isSettingsOpen && (
          <div
            id="topbar-settings-panel"
            className="topbar-settings-panel"
            role="dialog"
            aria-label="Settings dashboard"
          >
            <div className="settings-panel-head">
              <div>
                <p className="settings-panel-eyebrow">Settings</p>
                <strong>Dashboard live</strong>
              </div>
              <span className={`collector-pill ${collectorTone}`}>{collectorSummary}</span>
            </div>

            <label className="settings-field">
              <span>Tema</span>
              <select value={theme} onChange={handleThemeChange}>
                <option value="dark">Scuro</option>
                <option value="light">Chiaro</option>
              </select>
            </label>

            <label className="settings-field">
              <span>Palette heatmap</span>
              <select value={palette} onChange={handlePaletteChange}>
                {HEATMAP_PALETTE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {formatPaletteLabel(option)}
                  </option>
                ))}
              </select>
            </label>

            <label className="settings-field">
              <span>Sound queue AI</span>
              <select value={queueSoundSettings.AI} onChange={handleQueueSoundChange('AI')}>
                {QUEUE_SOUND_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {formatQueueSoundLabel(option)}
                  </option>
                ))}
              </select>
            </label>

            <label className="settings-field">
              <span>Sound queue AFA</span>
              <select value={queueSoundSettings.AFA} onChange={handleQueueSoundChange('AFA')}>
                {QUEUE_SOUND_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {formatQueueSoundLabel(option)}
                  </option>
                ))}
              </select>
            </label>

            <div className="collector-card">
              <div className="collector-card-title">Collector</div>
              <dl>
                <div>
                  <dt>Stato</dt>
                  <dd>{health?.collector_status ?? 'n/d'}</dd>
                </div>
                <div>
                  <dt>Ultimo prodotto</dt>
                  <dd>{relTime(health?.last_event_time ?? null, Date.now())}</dd>
                </div>
                <div>
                  <dt>Evento collector</dt>
                  <dd>{formatCollectorEvent(health?.last_collector_event ?? null)}</dd>
                </div>
                <div>
                  <dt>Buchi dati</dt>
                  <dd>{health?.gap_open ? 'buco aperto' : 'nessun buco aperto'}</dd>
                </div>
                <div>
                  <dt>Qualità 1h</dt>
                  <dd>{health?.data_quality_1h ?? 'n/d'}</dd>
                </div>
              </dl>
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}
