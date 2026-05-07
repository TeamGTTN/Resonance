import type { TranscriptionSettings } from "../../domain/settings";
import { requireNodeModule } from "../node";

interface ProcessOutputStream {
  on(event: "data", listener: (chunk: Buffer) => void): void;
}

interface ChildProcessHandle {
  stdout?: ProcessOutputStream;
  stderr?: ProcessOutputStream;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: (code: number | null) => void): void;
}

interface ChildProcessModule {
  spawn(command: string, args: string[], options: { cwd: string }): ChildProcessHandle;
}

export class WhisperTranscriptionAdapter {
  constructor(private readonly settings: TranscriptionSettings) {}

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
    const preparedAudioPath = audioPath;

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
        } catch {
          // Temporary audio cleanup is best effort.
        }
      }
      try {
        fs.unlinkSync(outputTextPath);
      } catch {
        // whisper.cpp may not have created an output file.
      }
    }
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
      } catch {
        // Remove stale output when possible before invoking whisper.cpp.
      }
    }

    const args = this.buildWhisperArgs(inputAudioPath, outputPrefix, relaxed);
    const result = await this.spawnProcess(
      this.settings.whisperCliPath,
      args,
      requireNodeModule<{ dirname: (path: string) => string }>("path").dirname(inputAudioPath),
      "whisper.cpp"
    );

    let rawTranscript = "";
    if (fs.existsSync(outputTextPath)) {
      rawTranscript = fs.readFileSync(outputTextPath, { encoding: "utf8" }).trim();
    } else {
      rawTranscript = result.stdout.trim();
    }

    return this.cleanTranscript(rawTranscript);
  }

  private cleanTranscript(text: string): string {
    let cleaned = text
      // Rimuove tag di speaker o suoni ambientali [Suono], [Speaker 1], [PROFESSORI]
      .replace(/\[.*?\]/g, "")
      // Rimuove caratteri ripetuti in modo anomalo
      .replace(/[-_]{2,}/g, " ")
      .replace(/\.{4,}/g, "...")
      // Rimuove alcune allucinazioni note (in italiano e inglese)
      .replace(/(Sottotitoli|Subtitles) (creati|a cura|di).*$/gim, "")
      .replace(/Traduzione di.*$/gim, "")
      .replace(/Iscriviti.*$/gim, "")
      .replace(/Amara\.org/gim, "")
      // Normalizza gli spazi
      .replace(/\s+/g, " ")
      .trim();
      
    // Se la stringa pulita contiene solo punteggiatura o spazi, la consideriamo vuota
    if (/^[.,!?\-;: ]*$/.test(cleaned)) {
      return "";
    }
    
    return cleaned;
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
    const childProcess = requireNodeModule<ChildProcessModule>("child_process");
    let stderr = "";
    let stdout = "";

    await new Promise<void>((resolve, reject) => {
      const child = childProcess.spawn(command, args, { cwd });
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (error: Error) => reject(error));
      child.on("close", (code: number | null) => {
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
