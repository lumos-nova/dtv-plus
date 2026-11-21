import * as DataTransfer from "../../../bindings/dtv/internal/services/datatransferservice";
import { isWailsRuntime } from "@/lib/window";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function saveRecording(blob: Blob, filename: string): Promise<string | null> {
  if (!isWailsRuntime()) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    return filename;
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const saved = await DataTransfer.SaveRecordingFile(toBase64(bytes), filename);
  return saved?.path ?? null;
}
