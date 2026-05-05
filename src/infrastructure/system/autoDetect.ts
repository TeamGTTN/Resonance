import type { TranscriptionSettings } from "../../domain/settings";
import { requireNodeModule } from "../node";

type WhisperModelPreset = TranscriptionSettings["modelPreset"];

interface ChildProcessModule {
  spawn: typeof import("node:child_process").spawn;
}

interface FsModule {
  existsSync: (path: string) => boolean;
  statSync: (path: string) => { isFile(): boolean; isDirectory(): boolean };
  readdirSync: (path: string) => string[];
}

interface OsModule {
  homedir: () => string;
}

interface PathModule {
  join: (...parts: string[]) => string;
}

export async function autoDetectWhisperRepo(): Promise<string | null> {
  const cliFromPath = await autoDetectWhisperCli(undefined, true);
  const inferred = inferWhisperRepoPath(cliFromPath);
  if (inferred && directoryLooksLikeWhisperRepo(inferred)) {
    return inferred;
  }

  for (const root of getLikelyWhisperRoots()) {
    if (directoryLooksLikeWhisperRepo(root)) return root;
  }

  return null;
}

export async function autoDetectWhisperCli(
  repoPath: string | undefined | null,
  skipRepoAutoDetect = false
): Promise<string | null> {
  const directPath = await detectCommandInPath("whisper-cli");
  if (directPath) return directPath;

  const roots = uniqueStrings([
    repoPath ?? undefined,
    skipRepoAutoDetect ? undefined : await autoDetectWhisperRepo(),
    ...getLikelyWhisperRoots(),
  ]);

  for (const root of roots) {
    const candidate = findWhisperCliUnderRoot(root);
    if (candidate) return candidate;
  }

  return null;
}

export async function autoDetectWhisperModel(options: {
  repoPath?: string | null;
  whisperCliPath?: string | null;
  preset?: WhisperModelPreset;
}): Promise<string | null> {
  const preset = options.preset ?? "medium";
  const roots = uniqueStrings([
    options.repoPath ?? undefined,
    inferWhisperRepoPath(options.whisperCliPath),
    await autoDetectWhisperRepo(),
    ...getLikelyWhisperRoots(),
  ]);

  for (const root of roots) {
    const candidate = findPreferredModelUnderRoot(root, preset);
    if (candidate) return candidate;
  }

  return null;
}

export function inferWhisperRepoPath(whisperCliPath: string | undefined | null): string | null {
  if (!whisperCliPath) return null;
  const normalized = whisperCliPath.replace(/\\/g, "/").trim();
  if (!normalized) return null;
  const match = normalized.match(/^(.*)\/build\/bin(?:\/Release)?\/(?:whisper-cli|main)(?:\.exe)?$/i);
  return match?.[1] ?? null;
}

export function getPreferredWhisperModelBasenames(preset: WhisperModelPreset): string[] {
  const orderedPresets = uniqueStrings([preset, "base", "small", "medium", "large"]) as WhisperModelPreset[];
  const basenames: string[] = [];
  for (const entry of orderedPresets) {
    basenames.push(`ggml-${entry}.bin`, `ggml-${entry}.en.bin`);
  }
  return basenames;
}

async function detectCommandInPath(command: string): Promise<string | null> {
  try {
    const { spawn } = requireNodeModule<ChildProcessModule>("child_process");
    const lookupCommand = process.platform === "win32" ? "where" : "which";
    const found = await new Promise<string | null>((resolve) => {
      const child = spawn(lookupCommand, [command]);
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.on("close", () => {
        const line = output
          .split(/\r?\n/)
          .map((value) => value.trim())
          .find(Boolean);
        resolve(line ?? null);
      });
      child.on("error", () => resolve(null));
    });
    return found;
  } catch {
    return null;
  }
}

function getLikelyWhisperRoots(): string[] {
  try {
    const os = requireNodeModule<OsModule>("os");
    const path = requireNodeModule<PathModule>("path");
    const home = os.homedir();
    return uniqueStrings([
      path.join(home, "whisper.cpp"),
      path.join(home, "code", "whisper.cpp"),
      path.join(home, "Code", "whisper.cpp"),
      path.join(home, "dev", "whisper.cpp"),
      path.join(home, "Developer", "whisper.cpp"),
      path.join(home, "Documents", "whisper.cpp"),
      path.join(process.cwd(), "whisper.cpp"),
      path.join(process.cwd(), "..", "whisper.cpp"),
    ]);
  } catch {
    return [];
  }
}

function directoryLooksLikeWhisperRepo(root: string | undefined | null): boolean {
  if (!root) return false;
  try {
    const fs = requireNodeModule<FsModule>("fs");
    const path = requireNodeModule<PathModule>("path");
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return false;
    return fs.existsSync(path.join(root, "models")) || fs.existsSync(path.join(root, "build"));
  } catch {
    return false;
  }
}

function findWhisperCliUnderRoot(root: string): string | null {
  try {
    const fs = requireNodeModule<FsModule>("fs");
    const path = requireNodeModule<PathModule>("path");
    const candidates = [
      ["build", "bin", "whisper-cli"],
      ["build", "bin", "whisper-cli.exe"],
      ["build", "bin", "Release", "whisper-cli"],
      ["build", "bin", "Release", "whisper-cli.exe"],
      ["build", "bin", "main"],
      ["build", "bin", "main.exe"],
      ["build", "bin", "Release", "main"],
      ["build", "bin", "Release", "main.exe"],
    ].map((parts) => path.join(root, ...parts));

    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }

    return walkFind(root, 3, (fullPath) => /(whisper-cli|main)(\.exe)?$/i.test(fullPath));
  } catch {
    return null;
  }
}

function findPreferredModelUnderRoot(root: string, preset: WhisperModelPreset): string | null {
  try {
    const fs = requireNodeModule<FsModule>("fs");
    const path = requireNodeModule<PathModule>("path");
    const basenames = getPreferredWhisperModelBasenames(preset);
    const directCandidates = [
      ...basenames.map((basename) => path.join(root, "models", basename)),
      ...basenames.map((basename) => path.join(root, basename)),
      ...basenames.map((basename) => path.join(root, "build", "bin", basename)),
    ];

    for (const candidate of directCandidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile() && !isTestModelPath(candidate)) return candidate;
    }

    const modelDir = path.join(root, "models");
    const discovered = walkCollect(modelDir, 2, (fullPath) => /ggml-.*\.bin$/i.test(fullPath) && !isTestModelPath(fullPath));
    if (discovered.length === 0) return null;

    const preferred = basenames.find((basename) =>
      discovered.some((candidate) => candidate.replace(/\\/g, "/").toLowerCase().endsWith(`/${basename.toLowerCase()}`))
    );
    if (preferred) {
      return discovered.find((candidate) => candidate.replace(/\\/g, "/").toLowerCase().endsWith(`/${preferred.toLowerCase()}`)) ?? null;
    }

    return discovered[0] ?? null;
  } catch {
    return null;
  }
}

function isTestModelPath(fullPath: string): boolean {
  const normalized = fullPath.replace(/\\/g, "/").toLowerCase();
  const basename = normalized.split("/").pop() ?? "";
  return basename.startsWith("for-tests-");
}

function walkFind(root: string, depth: number, match: (path: string) => boolean): string | null {
  for (const entry of walkCollect(root, depth, match)) {
    return entry;
  }
  return null;
}

function walkCollect(root: string, depth: number, match: (path: string) => boolean): string[] {
  const fs = requireNodeModule<FsModule>("fs");
  const path = requireNodeModule<PathModule>("path");
  if (depth < 0 || !fs.existsSync(root)) return [];

  const results: string[] = [];
  for (const entry of fs.readdirSync(root)) {
    const fullPath = path.join(root, entry);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isFile() && match(fullPath)) {
        results.push(fullPath);
        continue;
      }
      if (stat.isDirectory()) {
        results.push(...walkCollect(fullPath, depth - 1, match));
      }
    } catch {
      // Skip unreadable directories while probing likely local installs.
    }
  }

  return results;
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
