import { FolderOpen } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import * as Recording from "../../../bindings/dtv/internal/services/recordingservice";
import type {
  RecordingSettings,
  RecordingTask,
} from "../../../bindings/dtv/internal/services/models";
import * as StorageSettings from "../../../bindings/dtv/internal/services/storagesettingsservice";
import { Modal } from "@/components/ui/Modal";
import { isWailsRuntime } from "@/lib/window";
import { useToast } from "@/state/ToastProvider";
import type { MonitorRoom } from "./layout";
import { getRoomDirectorySnapshot, subscribeRoomDirectory } from "./roomDirectory";
import {
  formatRecordingBytes,
  formatRecordingDuration,
  recordingStatusLabel,
} from "./recordingFormat";
import styles from "./RecordingManagerModal.module.css";

const QUALITY_OPTIONS = [
  { id: "best", label: "原画 / 最高可用" },
  { id: "high", label: "蓝光 / 超清优先" },
  { id: "medium", label: "高清优先" },
  { id: "low", label: "最低档" },
] as const;

interface RecordingManagerModalProps {
  rooms: MonitorRoom[];
  preselectKey: string | null;
  onClose: () => void;
}

/**
 * 「独立录制」管理器：后端原流录制（不经过播放器），关闭本窗口、
 * 停止播放或移除画面都不会中断录制；退出软件才停止全部。
 */
export function RecordingManagerModal({
  rooms,
  preselectKey,
  onClose,
}: RecordingManagerModalProps) {
  const { toast } = useToast();
  const directory = useSyncExternalStore(subscribeRoomDirectory, getRoomDirectorySnapshot);
  const [settings, setSettings] = useState<RecordingSettings | null>(null);
  const [tasks, setTasks] = useState<RecordingTask[]>([]);
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(preselectKey ? [preselectKey] : []),
  );
  const [quality, setQuality] = useState<string>("best");
  const [busy, setBusy] = useState(false);
  const desktop = isWailsRuntime();

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void Recording.GetSettings().then((next) => {
      if (active) setSettings(next);
    });
    const refresh = () => {
      void Recording.Tasks().then((next) => {
        if (active) setTasks(next ?? []);
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 1_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [desktop]);

  const activeTasks = tasks.filter((task) => task.status === "recording");
  const activeKeys = new Set(activeTasks.map((task) => `${task.platform}:${task.roomId}`));
  const failedMerges = tasks.filter((task) => task.mergeState === "failed");

  const roomLabel = (room: MonitorRoom) => {
    const meta = directory.get(room.key);
    const name = meta?.nickname || `房间 ${room.roomId}`;
    return `${name} (${room.platform}:${room.roomId})`;
  };

  const toggleChecked = (key: string) => {
    setChecked((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const patchSettings = async (patch: Partial<RecordingSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      await Recording.UpdateSettings(next);
    } catch (error) {
      toast(error instanceof Error ? error.message : "保存录制设置失败", "error");
      setSettings(await Recording.GetSettings());
    }
  };

  const pickFolder = async () => {
    try {
      const path = await StorageSettings.PickDirectory();
      if (path) await patchSettings({ saveDir: path });
    } catch (error) {
      toast(error instanceof Error ? error.message : "选择文件夹失败", "error");
    }
  };

  const startSelected = async () => {
    const targets = rooms.filter((room) => checked.has(room.key) && !activeKeys.has(room.key));
    if (targets.length === 0) {
      toast("请先勾选要录制的直播间", "info");
      return;
    }
    setBusy(true);
    let started = 0;
    for (const room of targets) {
      try {
        await Recording.Start(room.platform, room.roomId, quality);
        started += 1;
      } catch (error) {
        toast(
          `${roomLabel(room)}：${error instanceof Error ? error.message : "开始录制失败"}`,
          "error",
        );
      }
    }
    if (started > 0) toast(`已开始 ${started} 路独立录制`, "success");
    setTasks((await Recording.Tasks()) ?? []);
    setBusy(false);
  };

  const stopSelected = async () => {
    const targets = activeTasks.filter((task) => checked.has(`${task.platform}:${task.roomId}`));
    if (targets.length === 0) {
      toast("勾选的直播间没有正在进行的录制", "info");
      return;
    }
    for (const task of targets) await Recording.Stop(task.id);
    toast(`已停止 ${targets.length} 路录制`, "success");
  };

  const stopAll = async () => {
    await Recording.StopAll();
    toast("已停止全部录制", "success");
  };

  const openFolder = async () => {
    try {
      await Recording.OpenSaveDirectory();
    } catch (error) {
      toast(error instanceof Error ? error.message : "打开文件夹失败", "error");
    }
  };

  const retryMerges = async () => {
    if (failedMerges.length === 0) {
      toast("没有需要重试的合并任务", "info");
      return;
    }
    for (const task of failedMerges) {
      try {
        await Recording.RetryMerge(task.id);
      } catch (error) {
        toast(error instanceof Error ? error.message : "重试合并失败", "error");
      }
    }
  };

  return (
    <Modal title="独立录制" onClose={onClose} width={960}>
      <div className={styles.body}>
        <p className={styles.description}>
          最多同时四路 · 原流保存，不转码 · 每约 15 分钟一个 MKV 文件；最后不足一段也会保留。
          清晰度选择为目标，实际以平台提供的直播流为准。
        </p>
        {!desktop ? (
          <p className={styles.description}>独立录制仅在桌面应用中可用。</p>
        ) : (
          <>
            <div className={styles.saveRow}>
              <span className={styles.saveLabel}>保存位置</span>
              <input
                type="text"
                className={styles.savePath}
                value={settings?.saveDir ?? ""}
                readOnly
                aria-label="录制保存位置"
              />
              <button type="button" className={styles.action} onClick={() => void pickFolder()}>
                <FolderOpen size={15} />
                选择文件夹
              </button>
            </div>

            <div className={styles.roomList} role="group" aria-label="选择要录制的直播间">
              {rooms.length === 0 && (
                <p className={styles.description}>工作台还没有直播间，先把主播拖入工作台。</p>
              )}
              {rooms.map((room) => (
                <label key={room.key} className={styles.roomItem}>
                  <input
                    type="checkbox"
                    checked={checked.has(room.key)}
                    onChange={() => toggleChecked(room.key)}
                  />
                  <span className={styles.roomName}>{roomLabel(room)}</span>
                  {activeKeys.has(room.key) && <span className={styles.recordingBadge}>录制中</span>}
                </label>
              ))}
            </div>

            <div className={styles.startRow}>
              <span className={styles.saveLabel}>清晰度</span>
              <select
                className={styles.qualitySelect}
                value={quality}
                onChange={(event) => setQuality(event.target.value)}
                aria-label="录制清晰度目标"
              >
                {QUALITY_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={styles.startButton}
                disabled={busy || activeTasks.length >= 4}
                onClick={() => void startSelected()}
              >
                {busy ? "正在启动…" : "开始所选录制"}
              </button>
              <span className={styles.counter}>{activeTasks.length} / 4</span>
            </div>
            {/* RECORDING_MANAGER_CONTINUED */}
            <div className={styles.toggleRow}>
              <label className={styles.toggle}>
                <span>录制结束后自动合并分片</span>
                <input
                  type="checkbox"
                  className={styles.switch}
                  checked={settings?.autoMerge ?? false}
                  onChange={(event) => void patchSettings({ autoMerge: event.target.checked })}
                />
              </label>
              <label className={styles.toggle}>
                <span>录制异常时发送系统通知</span>
                <input
                  type="checkbox"
                  className={styles.switch}
                  checked={settings?.notifyOnError ?? true}
                  onChange={(event) => void patchSettings({ notifyOnError: event.target.checked })}
                />
              </label>
            </div>
            <p className={styles.mergeHint}>
              自动合并对新录制生效；正常停止后后台无损合并，格式变化时分别合并。
              校验成功才清理原分片，失败可重试。关闭软件将取消合并并保留分片。
            </p>

            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>直播间</th>
                    <th>状态</th>
                    <th>清晰度</th>
                    <th>任务时长</th>
                    <th>已保存</th>
                    <th>实际写入码率</th>
                    <th>预计占用</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.length === 0 && (
                    <tr>
                      <td colSpan={7} className={styles.emptyCell}>
                        还没有录制任务
                      </td>
                    </tr>
                  )}
                  {tasks.map((task) => (
                    <tr key={task.id}>
                      <td>
                        {task.nickname || `房间 ${task.roomId}`} ({task.platform}:{task.roomId})
                      </td>
                      <td title={task.error || task.mergeError || undefined}>
                        {recordingStatusLabel(task)}
                      </td>
                      <td>{task.qualityLabel || "—"}</td>
                      <td>{formatRecordingDuration(task.durationSeconds)}</td>
                      <td>{formatRecordingBytes(task.savedBytes)}</td>
                      <td>
                        {task.bitrateBps > 0
                          ? `${(task.bitrateBps / 1_000_000).toFixed(2)} Mbps`
                          : "—"}
                      </td>
                      <td>
                        {task.estimatedBytesPerHour > 0
                          ? `约 ${formatRecordingBytes(task.estimatedBytesPerHour)}/小时`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className={styles.actions}>
              <button type="button" className={styles.action} onClick={() => void stopSelected()}>
                停止所选
              </button>
              <button type="button" className={styles.action} onClick={() => void stopAll()}>
                停止全部
              </button>
              <button type="button" className={styles.action} onClick={() => void openFolder()}>
                打开文件夹
              </button>
              <button
                type="button"
                className={styles.action}
                disabled={failedMerges.length === 0}
                onClick={() => void retryMerges()}
              >
                重试合并
              </button>
            </div>
          </>
        )}
        <p className={styles.footerNote}>
          关闭本窗口、停止播放或移除画面，录制仍会继续。退出软件会停止全部录制。
          独立录制会额外消耗网络带宽；磁盘剩余不足 1 GB 时停止，不自动清理其他录制文件。
        </p>
      </div>
    </Modal>
  );
}