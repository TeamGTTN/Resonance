import type { App } from "obsidian";

interface DesktopWindow {
  require?: (moduleName: string) => unknown;
}

export function requireNodeModule<T>(name: string): T {
  const req = (window as unknown as DesktopWindow).require;
  if (!req) {
    throw new Error("Resonance requires Obsidian desktop runtime.");
  }
  return req(name) as T;
}

export function getVaultBasePath(app: App): string {
  const adapter = app.vault.adapter as { getBasePath?: () => string; basePath?: string };
  return adapter?.getBasePath?.() ?? adapter?.basePath ?? "";
}

export function getVaultConfigDir(app: App): string {
  const configDir = app.vault.configDir.trim();
  if (!configDir) {
    throw new Error("Unable to determine vault configuration directory.");
  }
  return configDir;
}
