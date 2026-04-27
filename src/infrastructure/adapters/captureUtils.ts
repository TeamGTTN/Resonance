import type { CaptureSettings } from "../../domain/settings";
import { resolveCaptureBackend } from "../../domain/settings";
import { scanDevices, type ListedDevice } from "../system/deviceScanner";

export interface ResolvedCaptureInputs {
  backend: "avfoundation" | "dshow" | "pulse" | "alsa";
  micSpec?: string;
  systemSpec?: string;
  micLabel?: string;
  systemLabel?: string;
}

function stripDeviceIndexPrefix(label: string): string {
  return label.replace(/^\d+:\s*/, "").trim();
}

function normalizeDshowDevice(value: string): string {
  if (!value) return value;
  return /^(audio=|video=|@device_)/i.test(value) ? value : `audio=${value}`;
}

function normalizeAvfoundationIndex(value: string): string {
  if (!value) return "";
  if (/^:\d+$/.test(value)) return value;
  if (/^\d+$/.test(value)) return `:${value}`;
  return "";
}

function findAvfoundationDevice(devices: ListedDevice[], name: string, label: string): ListedDevice | undefined {
  const byLabel = label ? devices.find((device) => stripDeviceIndexPrefix(device.label) === stripDeviceIndexPrefix(label)) : undefined;
  if (byLabel) return byLabel;
  const normalizedName = normalizeAvfoundationIndex(name);
  if (normalizedName) {
    const byName = devices.find((device) => device.name === normalizedName);
    if (byName) return byName;
  }
  return name ? devices.find((device) => device.name === name) : undefined;
}

export async function resolveCaptureInputs(capture: CaptureSettings): Promise<ResolvedCaptureInputs> {
  const backend = resolveCaptureBackend(capture.backend);
  if (backend === "avfoundation") {
    let devices: ListedDevice[] = [];
    try {
      if (capture.ffmpegPath.trim()) {
        devices = (await scanDevices(capture.ffmpegPath, backend)).filter((device) => device.type === "audio");
      }
    } catch {}

    const resolvedMic = findAvfoundationDevice(devices, capture.microphoneDevice, capture.microphoneLabel) ?? devices[0];
    const resolvedSystem = capture.systemDevice || capture.systemLabel
      ? findAvfoundationDevice(devices, capture.systemDevice, capture.systemLabel)
      : undefined;

    return {
      backend,
      micSpec: resolvedMic?.name ?? ":0",
      systemSpec: resolvedSystem?.name,
      micLabel: resolvedMic?.label ?? capture.microphoneLabel,
      systemLabel: resolvedSystem?.label ?? capture.systemLabel,
    };
  }

  if (backend === "dshow") {
    return {
      backend,
      micSpec: normalizeDshowDevice(capture.microphoneDevice || "audio=Microphone (default)"),
      systemSpec: capture.systemDevice ? normalizeDshowDevice(capture.systemDevice) : "",
      micLabel: capture.microphoneLabel,
      systemLabel: capture.systemLabel,
    };
  }

  return {
    backend,
    micSpec: capture.microphoneDevice || "default",
    systemSpec: capture.systemDevice || "",
    micLabel: capture.microphoneLabel,
    systemLabel: capture.systemLabel,
  };
}
