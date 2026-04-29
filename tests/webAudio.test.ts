import test from "node:test";
import assert from "node:assert/strict";
import { getWebAudioCapability, getWebShareAudioCapability, resolveWebAudioInputById } from "../src/infrastructure/system/webAudio";

test("getWebAudioCapability and getWebShareAudioCapability report supported browser APIs", () => {
  Object.defineProperty(globalThis, "navigator", {
    value: {
      mediaDevices: {
        getUserMedia: async () => ({}) as MediaStream,
        enumerateDevices: async () => [] as MediaDeviceInfo[],
        getDisplayMedia: async () => ({}) as MediaStream,
      },
    },
    configurable: true,
    writable: true,
  });

  assert.deepEqual(getWebAudioCapability(), {
    supported: true,
    hasGetUserMedia: true,
    hasEnumerateDevices: true,
  });
  assert.deepEqual(getWebShareAudioCapability(), {
    supported: true,
    hasGetDisplayMedia: true,
  });
});

test("getWebShareAudioCapability reports unsupported when display sharing is unavailable", () => {
  Object.defineProperty(globalThis, "navigator", {
    value: {
      mediaDevices: {
        getUserMedia: async () => ({}) as MediaStream,
        enumerateDevices: async () => [] as MediaDeviceInfo[],
      },
    },
    configurable: true,
    writable: true,
  });

  assert.deepEqual(getWebShareAudioCapability(), {
    supported: true,
    hasGetDisplayMedia: false,
  });
});

test("resolveWebAudioInputById returns a matching audioinput device", async () => {
  Object.defineProperty(globalThis, "navigator", {
    value: {
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
      },
    },
    configurable: true,
    writable: true,
  });

  const device = await resolveWebAudioInputById("loopback-1");
  assert.equal(device?.label, "BlackHole 2ch");
});
