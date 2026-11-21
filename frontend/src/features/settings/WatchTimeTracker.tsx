import { useEffect, useRef } from "react";
import { loadAppSettings, saveAppSettings } from "@/lib/appSettings";
import { useToast } from "@/state/ToastProvider";

export function WatchTimeTracker() {
  const sessionSecondsRef = useRef(0);
  const restElapsedRef = useRef(0);
  const { toast } = useToast();

  useEffect(() => {
    const timer = window.setInterval(() => {
      const settings = loadAppSettings();
      sessionSecondsRef.current += 1;
      if (settings.restReminderEnabled) {
        restElapsedRef.current += 1;
        if (restElapsedRef.current >= settings.restMinutes * 60) {
          restElapsedRef.current = 0;
          toast(
            `小主，您已经观看${settings.restMinutes}分钟，请注意休息~~`,
            "info",
            undefined,
            30_000,
          );
        }
      } else {
        restElapsedRef.current = 0;
      }

      const watchedSeconds = settings.watchedSeconds + 1;
      saveAppSettings({ ...settings, watchedSeconds });
      window.dispatchEvent(
        new CustomEvent("dtv:watch-time", {
          detail: { sessionSeconds: sessionSecondsRef.current, watchedSeconds },
        }),
      );
    }, 1000);
    return () => window.clearInterval(timer);
  }, [toast]);

  return null;
}
