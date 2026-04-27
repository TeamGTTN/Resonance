import type { App, Plugin } from "obsidian";

interface PluginManagerBridge {
  getPlugin?: (pluginId: string) => Plugin | null | undefined;
}

interface SettingsBridge {
  open?: () => void;
  openTabById?: (pluginId: string) => void;
}

interface AppDesktopBridge {
  plugins?: PluginManagerBridge;
  setting?: SettingsBridge;
}

type ToggleableElement = HTMLElement & {
  show?: () => void;
  hide?: () => void;
};

export function getPluginInstance(app: App, pluginId: string): Plugin | null {
  const desktop = app as unknown as App & AppDesktopBridge;
  return desktop.plugins?.getPlugin?.(pluginId) ?? null;
}

export function openPluginSettings(app: App, pluginId: string): void {
  const desktop = app as unknown as App & AppDesktopBridge;
  desktop.setting?.open?.();
  desktop.setting?.openTabById?.(pluginId);
}

export function setElementVisibility(element: HTMLElement, visible: boolean): void {
  const toggleable = element as ToggleableElement;
  if (visible) {
    if (toggleable.show) {
      toggleable.show();
      return;
    }
    element.style.removeProperty("display");
    return;
  }

  if (toggleable.hide) {
    toggleable.hide();
    return;
  }
  element.style.setProperty("display", "none");
}
