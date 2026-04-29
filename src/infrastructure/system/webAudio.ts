export type WebAudioPermissionState = PermissionState | "unsupported" | "unknown";

export interface WebAudioInputDevice {
  deviceId: string;
  label: string;
  groupId: string;
  isDefault: boolean;
}

export interface WebAudioDeviceSnapshot {
  devices: WebAudioInputDevice[];
  permissionState: WebAudioPermissionState;
  labelsAvailable: boolean;
}

export interface WebAudioCapability {
  supported: boolean;
  hasGetUserMedia: boolean;
  hasEnumerateDevices: boolean;
}

export interface WebShareAudioCapability {
  supported: boolean;
  hasGetDisplayMedia: boolean;
}

export function getWebAudioCapability(): WebAudioCapability {
  const mediaDevices = globalThis.navigator?.mediaDevices;
  return {
    supported: Boolean(mediaDevices),
    hasGetUserMedia: typeof mediaDevices?.getUserMedia === "function",
    hasEnumerateDevices: typeof mediaDevices?.enumerateDevices === "function",
  };
}

export function getWebShareAudioCapability(): WebShareAudioCapability {
  const mediaDevices = globalThis.navigator?.mediaDevices;
  return {
    supported: Boolean(mediaDevices),
    hasGetDisplayMedia: typeof mediaDevices?.getDisplayMedia === "function",
  };
}

export async function getMicrophonePermissionState(): Promise<WebAudioPermissionState> {
  if (!globalThis.navigator) return "unsupported";

  try {
    const permissions = globalThis.navigator.permissions;
    if (!permissions?.query) return "unknown";
    const status = await permissions.query({ name: "microphone" as PermissionName });
    return status.state;
  } catch {
    return "unknown";
  }
}

export async function listWebAudioInputDevices(): Promise<WebAudioDeviceSnapshot> {
  const capability = getWebAudioCapability();
  if (!capability.hasEnumerateDevices || !globalThis.navigator?.mediaDevices) {
    return {
      devices: [],
      permissionState: capability.supported ? "unknown" : "unsupported",
      labelsAvailable: false,
    };
  }

  const permissionState = await getMicrophonePermissionState();
  const devices = await globalThis.navigator.mediaDevices.enumerateDevices();
  const inputs = devices
    .filter((device) => device.kind === "audioinput")
    .map((device) => ({
      deviceId: device.deviceId,
      label: device.label || (device.deviceId === "default" ? "System default input" : "Audio input"),
      groupId: device.groupId,
      isDefault: device.deviceId === "default",
    }));

  return {
    devices: inputs,
    permissionState,
    labelsAvailable: inputs.some((device) => {
      const normalized = device.label.trim().toLowerCase();
      return normalized !== "" && normalized !== "microphone" && normalized !== "system default microphone";
    }),
  };
}

export async function resolvePreferredWebAudioInput(selectedDeviceId?: string): Promise<WebAudioInputDevice | undefined> {
  const snapshot = await listWebAudioInputDevices();
  if (!snapshot.devices.length) return undefined;
  if (selectedDeviceId?.trim()) {
    const exact = snapshot.devices.find((device) => device.deviceId === selectedDeviceId.trim());
    if (exact) return exact;
  }
  return snapshot.devices.find((device) => device.isDefault) ?? snapshot.devices[0];
}

export async function resolveWebAudioInputById(selectedDeviceId?: string): Promise<WebAudioInputDevice | undefined> {
  if (!selectedDeviceId?.trim()) return undefined;
  const snapshot = await listWebAudioInputDevices();
  return snapshot.devices.find((device) => device.deviceId === selectedDeviceId.trim());
}
