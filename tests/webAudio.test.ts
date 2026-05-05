import test from "node:test";
import assert from "node:assert/strict";
import { getWebAudioCapability, resolveWebAudioInputById } from "../src/infrastructure/system/webAudio";

test("getWebAudioCapability reports supported browser APIs", () => {
  installNavigator({
    mediaDevices: {
      getUserMedia: async () => ({}) as MediaStream,
      enumerateDevices: async () => [] as MediaDeviceInfo[],
    } as unknown as MediaDevices,
  });

  assert.deepEqual(getWebAudioCapability(), {
    supported: true,
    hasGetUserMedia: true,
    hasEnumerateDevices: true,
  });
});

test("resolveWebAudioInputById returns a matching audioinput device", async () => {
  installNavigator({
    mediaDevices: {
      getUserMedia: async () => ({}) as MediaStream,
      enumerateDevices: async () =>
        [
          {
            kind: "audioinput",
            deviceId: "default",
            label: "System default input",
            groupId: "default-group",
          },
          {
            kind: "audioinput",
            deviceId: "loopback-1",
            label: "BlackHole 2ch",
            groupId: "group-2",
          },
        ] as MediaDeviceInfo[],
    } as unknown as MediaDevices,
  });

  const device = await resolveWebAudioInputById("loopback-1");
  assert.equal(device?.label, "BlackHole 2ch");
});

function installNavigator(navigatorValue: Partial<Navigator>): void {
  Object.defineProperty(globalThis, "window", {
    value: {
      navigator: navigatorValue,
    },
    configurable: true,
    writable: true,
  });

  Object.defineProperty(globalThis, "navigator", {
    value: navigatorValue,
    configurable: true,
    writable: true,
  });
}
