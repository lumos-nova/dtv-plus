import { FolderOpen, HardDrive, Trash2 } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import * as StorageSettings from "../../../bindings/dtv/internal/services/storagesettingsservice";
import type { StorageDirs } from "../../../bindings/dtv/internal/appdirs/models";
import {
  getRecordingStatsSnapshot,
  subscribeRecordingStats,
  summarizeRecordingStats,
} from "@/features/multiview/recordingStats";
import { disposeReplayEngine } from "@/features/multiview/replayExport";
import { REPLAY_SECONDS_OPTIONS } from "@/lib/appSettings";
import { isWailsRuntime } from "@/lib/window";
import { Modal } from "@/components/ui/Modal";
import styles from "./StorageSettingsModal.module.css";

function toMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

interface StorageSettingsModalProps {
  onClose: () => void;
  replaySeconds: number;
  onReplaySecondsChange: (seconds: number) => void;
}

/**
 * 「存储设置」弹窗（todo01-1）。
 *
 * - 内存回溯时长：调整工作台各房间在内存里保留的直播码流时长，
 *   缩短会立即裁剪缓存（不重启录制器）。
 * - 精彩片段保存位置：录制 / 回溯导出对话框的默认目录，
 *   支持选择、在文件管理器中打开、清理遗留临时文件。
 */
export function StorageSettingsModal({
  onClose,
  replaySeconds,
  onReplaySecondsChange,
}: StorageSettingsModalProps) {
  const [paths, setPaths] = useState<StorageDirs | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const stats = useSyncExternalStore(subscribeRecordingStats, getRecordingStatsSnapshot);
  const summary = summarizeRecordingStats(stats, replaySeconds);

  useEffect(() => {
    if (!isWailsRuntime()) return;
    let active = true;
    void StorageSettings.GetPaths()
      .then((current) => {
        if (active) setPaths(current);
      })
      .catch((error: unknown) => {
        if (active) {
          setMessage(error instanceof Error ? error.message : "读取存储设置失败");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const persistRecordingsDir = async (recordingsDir: string) => {
    setBusy(true);
    setMessage("");
    try {
      // 以磁盘上的最新配置为基底，只覆盖录制目录，
      // 避免把设置页里尚未保存的缓存 / 日志改动冲掉。
      const current = await StorageSettings.GetPaths();
      await StorageSettings.SetPaths({ ...current, recordingsDir });
      setPaths(await StorageSettings.GetPaths());
      setMessage("精彩片段保存位置已更新");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存存储设置失败");
    } finally {
      setBusy(false);
    }
  };

  const pickDirectory = async () => {
    setMessage("");
    try {
      const path = await StorageSettings.PickDirectory();
      if (path) await persistRecordingsDir(path);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "选择目录失败");
    }
  };

  const openDirectory = async () => {
    if (!paths) return;
    setMessage("");
    try {
      await StorageSettings.OpenDirectory(paths.recordingsDir);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "打开目录失败");
    }
  };

  const cleanTempFiles = async () => {
    setBusy(true);
    setMessage("");
    try {
      const engineReleased = disposeReplayEngine();
      const result = await StorageSettings.CleanTempFiles();
      setMessage(
        `已清理 ${result.removedFiles} 个临时文件，释放 ${toMB(result.freedBytes)} MB` +
          (engineReleased ? "；FFmpeg 转码缓存已释放" : ""),
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "清理临时文件失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="存储设置" onClose={onClose} width={560}>
      <div className={styles.sections}>
        <section className={styles.section}>
          <h3>内存回溯时长</h3>
          <p className={styles.description}>
            在内存中保留最近收到的压缩直播码流；缩短时长会立即裁剪缓存，但 FFmpeg
            与系统可能保留可复用内存，因此任务管理器中的进程占用不会同步下降
          </p>
          <select
            className={styles.durationSelect}
            value={replaySeconds}
            onChange={(event) => onReplaySecondsChange(Number(event.target.value))}
            aria-label="内存回溯时长"
          >
            {REPLAY_SECONDS_OPTIONS.map((seconds) => (
              <option key={seconds} value={seconds}>
                {seconds} 秒
              </option>
            ))}
          </select>
          <p className={styles.stats} role="status">
            当前实际缓存：{toMB(summary.bufferedBytes)} MB；按近期码率估算目标：约{" "}
            {toMB(summary.estimatedTargetBytes)} MB
          </p>
        </section>

        <section className={styles.section}>
          <h3>精彩片段保存位置</h3>
          {paths ? (
            <>
              <input
                type="text"
                className={styles.pathInput}
                value={paths.recordingsDir}
                readOnly
                aria-label="精彩片段保存位置"
              />
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.action}
                  onClick={() => void pickDirectory()}
                  disabled={busy}
                >
                  <FolderOpen size={15} />
                  选择
                </button>
                <button
                  type="button"
                  className={styles.action}
                  onClick={() => void openDirectory()}
                  disabled={busy}
                >
                  <HardDrive size={15} />
                  打开
                </button>
                <button
                  type="button"
                  className={styles.action}
                  onClick={() => void cleanTempFiles()}
                  disabled={busy}
                >
                  <Trash2 size={15} />
                  {busy ? "正在清理…" : "清理临时文件"}
                </button>
              </div>
            </>
          ) : (
            <p className={styles.description}>
              {isWailsRuntime() ? "正在读取目录设置…" : "目录设置仅在桌面应用中可用。"}
            </p>
          )}
        </section>

        {message && (
          <p className={styles.message} role="status">
            {message}
          </p>
        )}
      </div>
    </Modal>
  );
}