import type { CaptureSettings } from "../../domain/settings";
import { requireNodeModule } from "../node";
import { resolveCaptureInputs, type ResolvedCaptureInputs } from "./captureUtils";
import { resolveAudioFilterChain } from "../../domain/captureProfiles";

interface ChildProcessModule {
  spawn: typeof import("node:child_process").spawn;
}

interface CaptureChildProcess {
  pid?: number;
  stdin?: { write: (chunk: string) => boolean };
  stderr?: {
    on: (event: "data", listener: (chunk: Buffer) => void) => void;
  } | null;
  on: {
    (event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
    (event: "error", listener: (error: Error) => void): void;
  };
  once?: (event: "close", listener: () => void) => void;
  off?: (event: "close", listener: () => void) => void;
  kill: (signal?: NodeJS.Signals | number) => boolean;
}

export interface AudioCaptureStartOptions {
  settings: CaptureSettings;
  fullAudioPath: string;
  segmentsDir: string;
  onLog?: (line: string) => void;
  onUnexpectedExit?: (message: string) => void;
}

export class AudioCaptureAdapter {
  private child: CaptureChildProcess | null = null;
  private closePromise: Promise<void> | null = null;
  private stopRequested = false;
  private resolvedInputs: ResolvedCaptureInputs | null = null;

  async start(options: AudioCaptureStartOptions): Promise<ResolvedCaptureInputs> {
    if (this.child) {
      throw new Error("Audio capture already running.");
    }
    if (!options.settings.ffmpegPath.trim()) {
      throw new Error("FFmpeg path not configured.");
    }

    const resolvedInputs = await resolveCaptureInputs(options.settings);
    const inputArgs: string[] = [];
    const pushInput = (spec?: string) => {
      if (!spec) return;
      inputArgs.push("-f", resolvedInputs.backend, "-thread_queue_size", "1024", "-i", spec);
    };
    pushInput(resolvedInputs.micSpec);
    pushInput(resolvedInputs.systemSpec);
    if (inputArgs.length === 0) {
      throw new Error("No audio input configured.");
    }

    const path = requireNodeModule<{ join: (...parts: string[]) => string }>("path");
    const { spawn } = requireNodeModule<ChildProcessModule>("child_process");
    const segmentPattern = path.join(options.segmentsDir, "segment-%04d.mp3");
    const shouldMix = Boolean(resolvedInputs.micSpec && resolvedInputs.systemSpec);
    const { filterArgs, mapArgs } = resolveAudioFilterChain(options.settings, shouldMix);
    const sampleRate = Math.max(8_000, Math.floor(options.settings.sampleRateHz));
    const channels = options.settings.channels === 1 ? 1 : 2;
    const bitrate = Math.max(64, Math.floor(options.settings.bitrateKbps));
    const segmentDuration = Math.max(5, Math.floor(options.settings.segmentDurationSeconds));
    const teeSpec = `[f=segment:segment_time=${segmentDuration}:reset_timestamps=1]${segmentPattern}|${options.fullAudioPath}`;
    const args = [
      "-y",
      ...inputArgs,
      ...filterArgs,
      ...mapArgs,
      "-vn",
      "-ar",
      String(sampleRate),
      "-ac",
      String(channels),
      "-c:a",
      "libmp3lame",
      "-b:a",
      `${bitrate}k`,
      "-f",
      "tee",
      teeSpec,
    ];

    options.onLog?.(`FFmpeg start: ${options.settings.ffmpegPath} ${args.join(" ")}`);
    this.stopRequested = false;
    this.child = spawn(options.settings.ffmpegPath, args, { detached: false, stdio: ["pipe", "ignore", "pipe"] }) as CaptureChildProcess;
    this.resolvedInputs = resolvedInputs;
    const child = this.child;
    let stderrTail = "";

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrTail = `${stderrTail}${text}`.split(/\r?\n/).slice(-10).join("\n");
      if (text.trim()) options.onLog?.(text.trim());
    });

    this.closePromise = new Promise<void>((resolve) => {
      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        const unexpected = !this.stopRequested && (code ?? 0) !== 0;
        if (unexpected) {
          options.onUnexpectedExit?.(`FFmpeg exited with code ${code ?? 0}${signal ? ` (${signal})` : ""}\n${stderrTail}`);
        }
        this.child = null;
        resolve();
      });
      child.on("error", (error: Error) => {
        options.onUnexpectedExit?.(error.message);
        this.child = null;
        resolve();
      });
    });

    return resolvedInputs;
  }

  isRunning(): boolean {
    return Boolean(this.child);
  }

  async stop(): Promise<void> {
    if (!this.child || !this.closePromise) return;
    this.stopRequested = true;
    const child = this.child;
    try {
      child.stdin?.write("q\n");
    } catch {}

    const closedGracefully = await waitForClose(child, 1_500);
    if (!closedGracefully) {
      try {
        child.kill("SIGINT");
      } catch {}
    }
    if (!(await waitForClose(child, 1_000))) {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
    if (!(await waitForClose(child, 800))) {
      if (process.platform === "win32") {
        try {
          const { spawn } = requireNodeModule<ChildProcessModule>("child_process");
          spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
        } catch {}
      } else {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }

    await this.closePromise;
  }

  getResolvedInputs(): ResolvedCaptureInputs | null {
    return this.resolvedInputs;
  }
}

async function waitForClose(child: CaptureChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      try {
        child.off?.("close", onClose);
      } catch {}
      resolve(value);
    };
    const onClose = () => finish(true);
    child.once?.("close", onClose);
    window.setTimeout(() => finish(false), timeoutMs);
  });
}
