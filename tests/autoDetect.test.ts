import test from "node:test";
import assert from "node:assert/strict";
import { getPreferredWhisperModelBasenames, inferWhisperRepoPath } from "../src/infrastructure/system/autoDetect";

test("inferWhisperRepoPath resolves repo root from whisper-cli path", () => {
  assert.equal(
    inferWhisperRepoPath("/Users/test/whisper.cpp/build/bin/whisper-cli"),
    "/Users/test/whisper.cpp"
  );
  assert.equal(
    inferWhisperRepoPath("C:\\dev\\whisper.cpp\\build\\bin\\Release\\whisper-cli.exe"),
    "C:/dev/whisper.cpp"
  );
});

test("getPreferredWhisperModelBasenames prioritizes the selected preset first", () => {
  const names = getPreferredWhisperModelBasenames("large");
  assert.deepEqual(names.slice(0, 4), [
    "ggml-large.bin",
    "ggml-large.en.bin",
    "ggml-base.bin",
    "ggml-base.en.bin",
  ]);
});
