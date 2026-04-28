import { useState, useEffect, useCallback } from "react";
import { load } from "@tauri-apps/plugin-store";
import type { AppSettings, AudioSource } from "../types";

const DEFAULT_SETTINGS: AppSettings = {
  claude_path: "claude",
  notion_api_key: "",
  notion_database_id: "",
  whisper_model: "mlx-community/whisper-large-v3-mlx",
  recordings_path: "",
  audio_source: "microphone" as AudioSource,
  python_path: "/Users/kwon/Coding/notetaker/.venv/bin/python",
};

async function getStore() {
  return load("settings.json", {
    defaults: DEFAULT_SETTINGS as unknown as Record<string, unknown>,
    autoSave: true,
  });
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    try {
      const store = await getStore();
      const loaded: Partial<AppSettings> = {};

      for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
        const val = await store.get<string>(key);
        if (val !== undefined && val !== null) {
          (loaded as Record<string, unknown>)[key] = val;
        }
      }

      setSettings({ ...DEFAULT_SETTINGS, ...loaded });
    } catch (e) {
      console.error("설정 로드 실패:", e);
    } finally {
      setLoading(false);
    }
  }

  const saveSettings = useCallback(async (newSettings: AppSettings) => {
    try {
      const store = await getStore();
      for (const [key, value] of Object.entries(newSettings)) {
        await store.set(key, value);
      }
      await store.save();
      setSettings(newSettings);
    } catch (e) {
      console.error("설정 저장 실패:", e);
      throw e;
    }
  }, []);

  return { settings, loading, saveSettings, reloadSettings: loadSettings };
}
