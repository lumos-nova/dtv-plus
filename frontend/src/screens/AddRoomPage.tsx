import { ArrowRight, Check, Link2, LoaderCircle, Star } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, PLATFORM_LABEL, PLATFORM_LOGO, type Streamer } from "@/api";
import { parseLiveRoomUrl, type ParsedLiveRoomUrl } from "@/features/multiview/roomUrl";
import { useFollow } from "@/state/FollowProvider";
import styles from "./AddRoomPage.module.css";

export function AddRoomPage() {
  const navigate = useNavigate();
  const { isFollowing, toggleFollow } = useFollow();
  const [url, setUrl] = useState("");
  const [room, setRoom] = useState<ParsedLiveRoomUrl | null>(null);
  const [streamer, setStreamer] = useState<Streamer | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setNotice("");
    setStreamer(null);

    let parsed: ParsedLiveRoomUrl;
    try {
      parsed = parseLiveRoomUrl(url);
    } catch (reason) {
      setRoom(null);
      setError(reason instanceof Error ? reason.message : "无法识别该直播间链接");
      return;
    }

    setRoom(parsed);
    setLoading(true);
    try {
      const info = await api.getRoomInfo(parsed.platform, parsed.roomId);
      setStreamer(info);
      if (!isFollowing(info.platform, info.id)) {
        toggleFollow(info);
      }
      // 识别并关注后直接在多房间工作台打开该直播间
      navigate("/monitor", {
        state: { dtvMonitorRoom: { platform: info.platform, roomId: info.id } },
      });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? `链接已识别，但获取直播间信息失败：${reason.message}`
          : "链接已识别，但获取直播间信息失败",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className={styles.page}>
      <header className={styles.heading}>
        <div className={styles.icon} aria-hidden="true">
          <Link2 size={21} />
        </div>
        <div>
          <h1 className={styles.title}>添加直播间</h1>
          <p className={styles.subtitle}>粘贴斗鱼、虎牙、抖音或 B 站直播间链接</p>
        </div>
      </header>

      <form className={styles.form} onSubmit={(event) => void handleSubmit(event)}>
        <label className={styles.visuallyHidden} htmlFor="add-live-room-url">
          直播间链接
        </label>
        <input
          id="add-live-room-url"
          className={styles.input}
          type="text"
          inputMode="url"
          autoComplete="url"
          placeholder="例如：https://www.douyu.com/房间号"
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            setRoom(null);
            setStreamer(null);
            setError("");
            setNotice("");
          }}
          aria-invalid={Boolean(error)}
          disabled={loading}
        />
        <button className={styles.submit} type="submit" disabled={loading || !url.trim()}>
          {loading ? <LoaderCircle className={styles.spinner} size={16} /> : <Star size={16} />}
          {loading ? "识别中…" : "识别并关注"}
        </button>
      </form>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={styles.notice} role="status">
          <Check size={15} />
          {notice}
        </p>
      )}

      {room && (
        <div className={styles.result}>
          <img src={PLATFORM_LOGO[room.platform]} alt="" />
          <span className={styles.platform}>{PLATFORM_LABEL[room.platform]}</span>
          <code>{streamer?.id ?? room.roomId}</code>
          {streamer && <span className={styles.nickname}>{streamer.nickname}</span>}
          {streamer && !streamer.isLive && <span className={styles.offline}>当前未开播</span>}
          <button
            type="button"
            className={styles.workspaceLink}
            onClick={() =>
              navigate("/monitor", {
                state: {
                  dtvMonitorRoom: {
                    platform: room.platform,
                    roomId: streamer?.id ?? room.roomId,
                  },
                },
              })
            }
          >
            打开多房间工作台
            <ArrowRight size={14} />
          </button>
        </div>
      )}

      <p className={styles.hint}>
        识别成功后会自动加入左侧关注列表，并直接在多房间工作台打开播放；
        也可以将关注列表中的主播拖到多房间工作台。
      </p>
    </section>
  );
}
