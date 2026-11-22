import { BellRing, FolderOpen, HardDrive, Save } from "lucide-react";
import { useEffect, useState } from "react";
import * as StorageSettings from "../../../bindings/dtv/internal/services/storagesettingsservice";
import type { StorageDirs } from "../../../bindings/dtv/internal/appdirs/models";
import { BilibiliLoginButton } from "@/features/bilibili/BilibiliLoginButton";
import { DouyuLoginButton } from "@/features/douyu/DouyuLoginButton";
import { LanSyncModal } from "@/features/sync/LanSyncModal";
import { loadAppSettings, saveAppSettings, type AppSettings } from "@/lib/appSettings";
import { isWailsRuntime } from "@/lib/window";
import { Modal } from "@/components/ui/Modal";
import { StorageSettingsModal } from "./StorageSettingsModal";
import styles from "./SettingsModal.module.css";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<AppSettings>(loadAppSettings);
  const [storagePaths, setStoragePaths] = useState<StorageDirs | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageMessage, setStorageMessage] = useState("");
  const [storageModalOpen, setStorageModalOpen] = useState(false);

  useEffect(() => {
    saveAppSettings({ ...settings, watchedSeconds: loadAppSettings().watchedSeconds });
  }, [settings]);

  useEffect(() => {
    if (!isWailsRuntime()) return;
    let active = true;
    void StorageSettings.GetPaths()
      .then((paths) => {
        if (active) setStoragePaths(paths);
      })
      .catch((error: unknown) => {
        if (active) {
          setStorageMessage(error instanceof Error ? error.message : "读取存储设置失败");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const patch = (next: Partial<AppSettings>) => {
    setSettings((previous) => ({ ...previous, ...next }));
    if (typeof next.replayEnabled === "boolean") {
      window.dispatchEvent(
        new CustomEvent("dtv:replay-enabled", { detail: { enabled: next.replayEnabled } }),
      );
    }
    if (typeof next.replaySeconds === "number") {
      window.dispatchEvent(
        new CustomEvent("dtv:replay-seconds", { detail: { seconds: next.replaySeconds } }),
      );
    }
  };

  const pickDirectory = async (field: keyof StorageDirs) => {
    setStorageMessage("");
    try {
      const path = await StorageSettings.PickDirectory();
      if (path && storagePaths) setStoragePaths({ ...storagePaths, [field]: path });
    } catch (error) {
      setStorageMessage(error instanceof Error ? error.message : "选择目录失败");
    }
  };

  const saveStoragePaths = async () => {
    if (!storagePaths) return;
    setStorageBusy(true);
    setStorageMessage("");
    try {
      // 录制目录由「存储设置」弹窗单独维护，这里以磁盘最新值为准，
      // 只保存本页负责的缓存 / 日志目录。
      const current = await StorageSettings.GetPaths();
      await StorageSettings.SetPaths({ ...storagePaths, recordingsDir: current.recordingsDir });
      const next = await StorageSettings.GetPaths();
      setStoragePaths(next);
      setStorageMessage("存储目录已保存");
    } catch (error) {
      setStorageMessage(error instanceof Error ? error.message : "保存存储设置失败");
    } finally {
      setStorageBusy(false);
    }
  };

  return (
    <Modal title="设置" onClose={onClose} width={560}>
      <div className={styles.sections}>
        <section className={styles.section}>
          <h3>个人账号</h3>
          <div className={styles.accountRow}>
            <span>斗鱼</span>
            <DouyuLoginButton />
          </div>
          <div className={styles.accountRow}>
            <span>B 站</span>
            <BilibiliLoginButton />
          </div>
        </section>

        <section className={styles.section}>
          <h3>休息提醒</h3>
          <label className={styles.reminderToggle}>
            <span>开启休息提醒</span>
            <input
              type="checkbox"
              checked={settings.restReminderEnabled}
              onChange={(event) => patch({ restReminderEnabled: event.target.checked })}
            />
          </label>
          <label className={styles.field}>
            提醒间隔（分钟）
            <input
              type="number"
              min={1}
              max={1440}
              value={settings.restMinutes}
              onChange={(event) =>
                patch({ restMinutes: Math.max(1, Number(event.target.value) || 1) })
              }
              disabled={!settings.restReminderEnabled}
            />
          </label>
          <p className={styles.hint}>
            <BellRing size={14} />
            默认每 60 分钟提醒一次
          </p>
        </section>

        <section className={styles.section}>
          <h3>开播提醒</h3>
          <label className={styles.reminderToggle}>
            <span>关注主播开播时弹出提醒</span>
            <input
              type="checkbox"
              checked={settings.liveNotifyEnabled}
              onChange={(event) => patch({ liveNotifyEnabled: event.target.checked })}
            />
          </label>
          <p className={styles.hint}>
            <BellRing size={14} />
            每分钟检查一次关注列表；主播从下播变为开播（或开始轮播）时弹出提醒
          </p>
        </section>

        <section className={styles.section}>
          <h3>直播回溯与本地存储</h3>
          <label className={styles.reminderToggle}>
            <span>开启直播回溯和保存功能</span>
            <input
              type="checkbox"
              checked={settings.replayEnabled}
              onChange={(event) => patch({ replayEnabled: event.target.checked })}
            />
          </label>
          <p className={styles.hint}>
            开启后，工作台中的直播间会滚动保留最近约 {settings.replaySeconds}
            秒，可随时预览或保存；回溯时长与精彩片段保存位置在「存储设置」中调整。
          </p>
          <button
            type="button"
            className={styles.action}
            onClick={() => setStorageModalOpen(true)}
          >
            <HardDrive size={15} />
            存储设置
          </button>
          {storagePaths ? (
            <div className={styles.storageFields}>
              {(
                [
                  ["cacheDir", "图片缓存目录"],
                  ["logsDir", "日志目录"],
                ] as const
              ).map(([field, label]) => (
                <div className={styles.storageField} key={field}>
                  <span>{label}</span>
                  <div className={styles.pathRow}>
                    <input type="text" value={storagePaths[field]} readOnly aria-label={label} />
                    <button
                      type="button"
                      className={styles.action}
                      onClick={() => void pickDirectory(field)}
                      disabled={storageBusy}
                      aria-label={`选择${label}`}
                    >
                      <FolderOpen size={15} />
                      选择
                    </button>
                  </div>
                </div>
              ))}
              <button
                type="button"
                className={styles.action}
                onClick={() => void saveStoragePaths()}
                disabled={storageBusy}
              >
                <Save size={15} />
                {storageBusy ? "正在保存…" : "保存存储设置"}
              </button>
            </div>
          ) : (
            <p className={styles.hint}>
              {isWailsRuntime() ? "正在读取目录设置…" : "目录设置仅在桌面应用中可用。"}
            </p>
          )}
          {storageMessage && (
            <p className={styles.hint} role="status">
              {storageMessage}
            </p>
          )}
        </section>

        <section className={styles.section}>
          <h3>数据同步</h3>
          <LanSyncModal embedded />
        </section>
      </div>
      {storageModalOpen && (
        <StorageSettingsModal
          onClose={() => setStorageModalOpen(false)}
          replaySeconds={settings.replaySeconds}
          onReplaySecondsChange={(seconds) => patch({ replaySeconds: seconds })}
        />
      )}
    </Modal>
  );
}
