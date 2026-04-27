import type { TranscriptionSettings } from "../../domain/settings";
import { requireNodeModule } from "../node";

export class WhisperTranscriptionAdapter {
  constructor(
    private readonly settings: TranscriptionSettings,
    private readonly ffmpegPath?: string
  ) {}

  async transcribeFile(audioPath: string): Promise<string> {
    if (!this.settings.whisperCliPath.trim()) {
      throw new Error("whisper.cpp CLI path not configured.");
    }
    if (!this.settings.modelPath.trim()) {
      throw new Error("Whisper model path not configured.");
    }

    const fs = requireNodeModule<{
      existsSync: (path: string) => boolean;
      readFileSync: (path: string, options: { encoding: "utf8" }) => string;
      unlinkSync: (path: string) => void;
    }>("fs");
    const outputPrefix = audioPath.replace(/\.[^.]+$/i, "");
    const outputTextPath = `${outputPrefix}.txt`;
    const preparedAudioPath = await this.prepareAudioForWhisper(audioPath, outputPrefix);

    try {
      let transcript = await this.runWhisper(preparedAudioPath, outputPrefix, outputTextPath, false);
      if (transcript.trim()) {
        return transcript;
      }

      transcript = await this.runWhisper(preparedAudioPath, outputPrefix, outputTextPath, true);
      return transcript;
    } finally {
      if (preparedAudioPath !== audioPath) {
        try {
          fs.unlinkSync(preparedAudioPath);
        } catch {}
      }
      try {
        fs.unlinkSync(outputTextPath);
      } catch {}
    }
  }

  private async prepareAudioForWhisper(audioPath: string, outputPrefix: string): Promise<string> {
    const extension = audioPath.split(".").pop()?.toLowerCase();
    if (extension === "wav" || !this.ffmpegPath?.trim()) {
      return audioPath;
    }

    const wavPath = `${outputPrefix}.whisper.wav`;
    await this.spawnProcess(this.ffmpegPath, [
      "-y",
      "-i",
      audioPath,
      "-vn",
      "-af",
      "highpass=f=80,lowpass=f=7000,dynaudnorm=framelen=250:gausssize=31",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      wavPath,
    ], requireNodeModule<{ dirname: (path: string) => string }>("path").dirname(audioPath), "FFmpeg prepare");
    return wavPath;
  }

  private async runWhisper(
    inputAudioPath: string,
    outputPrefix: string,
    outputTextPath: string,
    relaxed: boolean
  ): Promise<string> {
    const fs = requireNodeModule<{
      existsSync: (path: string) => boolean;
      readFileSync: (path: string, options: { encoding: "utf8" }) => string;
      unlinkSync: (path: string) => void;
    }>("fs");

    if (fs.existsSync(outputTextPath)) {
      try {
        fs.unlinkSync(outputTextPath);
      } catch {}
    }

    const args = this.buildWhisperArgs(inputAudioPath, outputPrefix, relaxed);
    const result = await this.spawnProcess(
      this.settings.whisperCliPath,
      args,
      requireNodeModule<{ dirname: (path: string) => string }>("path").dirname(inputAudioPath),
      "whisper.cpp"
    );

    if (fs.existsSync(outputTextPath)) {
      return fs.readFileSync(outputTextPath, { encoding: "utf8" }).trim();
    }

    return result.stdout.trim();
  }

  private buildWhisperArgs(inputAudioPath: string, outputPrefix: string, relaxed: boolean): string[] {
    const args = ["-m", this.settings.modelPath, "-f", inputAudioPath, "-otxt", "-of", outputPrefix];
    const language = this.settings.language.trim();
    if (language && language !== "auto") args.push("-l", language);
    args.push("--max-context", "128", "--max-len", "0", "-bs", String(this.settings.beamSize));

    if (!relaxed) {
      args.push(
        "--entropy-thold",
        String(this.settings.entropyThreshold),
        "--logprob-thold",
        String(this.settings.logprobThreshold),
        "--word-thold",
        "0.01"
      );
    }

    return args;
  }

  private async spawnProcess(
    command: string,
    args: string[],
    cwd: string,
    label: string
  ): Promise<{ stdout: string; stderr: string }> {
    const { spawn } = requireNodeModule<{ spawn: Function }>("child_process");
    let stderr = "";
    let stdout = "";

    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { cwd });
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (error: Error) => reject(error));
      child.on("close", (code: number) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${label} exited with code ${code}: ${stderr}`));
        }
      });
    });

    return { stdout, stderr };
  }
}
