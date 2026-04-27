import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { requireNodeModule } from "../node";

export interface ListedDevice {
  backend: "dshow" | "avfoundation" | "pulse" | "alsa";
  type: "audio" | "video" | "unknown";
  name: string;
  label: string;
}

interface ChildProcessModule {
  spawn: typeof import("node:child_process").spawn;
}

export function parseFfmpegDeviceList(
  output: string,
  backend: "dshow" | "avfoundation" | "pulse" | "alsa"
): ListedDevice[] {
  const devices: ListedDevice[] = [];
  const lines = output.split(/\r?\n/);

  if (backend === "dshow") {
    let section: "audio" | "video" | "unknown" = "unknown";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (/DirectShow audio devices/i.test(line)) {
        section = "audio";
        continue;
      }
      if (/DirectShow video devices/i.test(line)) {
        section = "video";
        continue;
      }
      if (/Alternative name\s+"/.test(line)) continue;
      const match = line.match(/\s*"(.+?)"/);
      if (!match) continue;
      const label = match[1];
      if (/^@device_/i.test(label)) continue;
      const type = section;
      const name = type === "audio" ? `audio=${label}` : label;
      devices.push({ backend, type, name, label });
    }

    const seen = new Set<string>();
    return devices.filter((device) => {
      const key = `${device.type}|${device.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  if (backend === "avfoundation") {
    let section: "audio" | "video" | "unknown" = "unknown";
    for (const line of lines) {
      if (/AVFoundation video devices/i.test(line)) {
        section = "video";
        continue;
      }
      if (/AVFoundation audio devices/i.test(line)) {
        section = "audio";
        continue;
      }
      const match = line.match(/\[(\d+)\]\s+(.+)/);
      if (!match) continue;
      const index = match[1];
      const label = match[2];
      devices.push({
        backend,
        type: section,
        name: section === "audio" ? `:${index}` : `${index}:`,
        label: `${index}: ${label}`,
      });
    }
    return devices;
  }

  return [{ backend, type: "audio", name: "default", label: "default" }];
}

export async function scanDevices(
  ffmpegPath: string,
  backend: "dshow" | "avfoundation" | "pulse" | "alsa"
): Promise<ListedDevice[]> {
  const { spawn } = requireNodeModule<ChildProcessModule>("child_process");
  const args =
    backend === "dshow"
      ? ["-list_devices", "true", "-f", "dshow", "-i", "dummy"]
      : backend === "avfoundation"
      ? ["-f", "avfoundation", "-list_devices", "true", "-i", ""]
      : backend === "pulse"
      ? ["-f", "pulse", "-sources", "pulse"]
      : ["-f", "alsa", "-sources", "alsa"];

  const output = await new Promise<string>((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(ffmpegPath, args);
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
    });
    child.on("error", (error: Error) => reject(error));
    child.on("close", () => resolve(buffer));
  });

  return parseFfmpegDeviceList(output, backend);
}
