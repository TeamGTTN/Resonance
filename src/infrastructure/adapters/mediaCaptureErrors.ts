export class CaptureCancelledError extends Error {
  constructor(message = "Audio capture was canceled.") {
    super(message);
    this.name = "CaptureCancelledError";
  }
}

export function isDisplayShareCancellation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name?: unknown }).name ?? "") : "";
  return name === "AbortError" || name === "NotAllowedError";
}

export function getSharedAudioCaptureFailureDetail(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const name = "name" in error ? String((error as { name?: unknown }).name ?? "") : "";
  const message = "message" in error ? String((error as { message?: unknown }).message ?? "") : "";
  const normalized = `${name} ${message}`.toLowerCase();

  if (name === "NotSupportedError" || normalized.includes("not supported")) {
    return "Shared system audio is not supported by this Obsidian/Electron runtime. Use Loopback device instead.";
  }

  if (name === "NotReadableError") {
    return "The shared surface could not start an audio stream. Check OS screen/audio capture permissions or use Loopback device instead.";
  }

  if (name === "OverconstrainedError") {
    return "The chosen shared surface could not provide a compatible audio stream. Try a different surface or use Loopback device instead.";
  }

  return null;
}
