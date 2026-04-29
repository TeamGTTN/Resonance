import test from "node:test";
import assert from "node:assert/strict";
import { SUPPORTED_SESSION_SCHEMA_VERSION, isSupportedSessionManifest } from "../src/domain/session";

test("isSupportedSessionManifest accepts only the current schema version", () => {
  assert.equal(isSupportedSessionManifest({ schemaVersion: SUPPORTED_SESSION_SCHEMA_VERSION }), true);
  assert.equal(isSupportedSessionManifest({ schemaVersion: 3 }), false);
  assert.equal(isSupportedSessionManifest({}), false);
});
