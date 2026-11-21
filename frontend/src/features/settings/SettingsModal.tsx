import { BellRing } from "lucide-react";
import { useEffect, useState } from "react";
import { BilibiliLoginButton } from "@/features/bilibili/BilibiliLoginButton";
import { DouyuLoginButton } from "@/features/douyu/DouyuLoginButton";
import { LanSyncModal } from "@/features/sync/LanSyncModal";
import { loadAppSettings, saveAppSettings, type AppSettings } from "@/lib/appSettings";
import { Modal } from "@/components/ui/Modal";
import styles from "./SettingsModal.module.css";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<AppSettings>(loadAppSettings);

  useEffect(() => {
    saveAppSettings({ ...settings, watchedSeconds: loadAppSettings().watchedSeconds });
  }, [settings]);

  const patch = (next: Partial<AppSettings>) =>
    setSettings((previous) => ({ ...previous, ...next }));

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
          <h3>数据同步</h3>
          <LanSyncModal embedded />
        </section>
      </div>
    </Modal>
  );
}
