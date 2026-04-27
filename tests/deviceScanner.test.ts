import test from "node:test";
import assert from "node:assert/strict";
import { parseFfmpegDeviceList } from "../src/infrastructure/system/deviceScanner";

test("parseFfmpegDeviceList parses avfoundation audio indexes", () => {
  const output = `
[AVFoundation indev @ 0x0] AVFoundation video devices:
[AVFoundation indev @ 0x0] [0] FaceTime HD Camera
[AVFoundation indev @ 0x0] AVFoundation audio devices:
[AVFoundation indev @ 0x0] [0] Built-in Microphone
[AVFoundation indev @ 0x0] [1] BlackHole 2ch
  `;

  const devices = parseFfmpegDeviceList(output, "avfoundation");
  assert.equal(devices.length, 3);
  assert.equal(devices[1].name, ":0");
  assert.equal(devices[2].label, "1: BlackHole 2ch");
});

test("parseFfmpegDeviceList ignores dshow alternative names", () => {
  const output = `
[dshow @ 0x0] DirectShow audio devices
[dshow @ 0x0]  "Microphone Array"
[dshow @ 0x0]     Alternative name "@device_cm_{GUID}\\wave_{GUID}"
  `;

  const devices = parseFfmpegDeviceList(output, "dshow");
  assert.deepEqual(devices, [
    {
      backend: "dshow",
      type: "audio",
      name: "audio=Microphone Array",
      label: "Microphone Array",
    },
  ]);
});
