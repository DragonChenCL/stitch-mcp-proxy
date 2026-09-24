import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");

test("upload tools expose backward-compatible placement and original-size options", () => {
  assert.match(source, /near_screen/);
  assert.match(source, /asset_area/);
  assert.match(source, /preserveOriginalSize/);
  assert.match(source, /createScreenInstances/);
});

test("screen image fetch no longer applies implicit screen width resize", () => {
  assert.match(source, /const width = normalizeWidth\(args\.width\);/);
  assert.doesNotMatch(source, /args\.width \?\? screenInfo\.width/);
});

test("alpha-safe policy rejects transparent non-PNG uploads", () => {
  assert.match(source, /Alpha\/background-removed uploads must be image\/png/);
  assert.match(source, /Transparent WEBP is intentionally rejected/);
});

test("upload path keeps original bytes separate from preview resizing", () => {
  const start = source.indexOf("async function uploadImageToStitch(");
  const end = source.indexOf("async function fetchImageAsset(", start);
  const uploadFn = source.slice(start, end);
  assert.match(uploadFn, /fileContentBase64/);
  assert.match(uploadFn, /screenshot:\s*\{\s*fileContentBase64,\s*mimeType/);
  assert.doesNotMatch(uploadFn, /buildStitchAssetUrl/);
});

test("placement writes screenInstances and verifies them with get_project", () => {
  assert.match(source, /updateMask=screenInstances/);
  assert.match(source, /method: "PATCH"/);
  assert.match(source, /"get_project"/);
  assert.match(source, /Canvas PATCH returned success, but get_project/);
});

test("fetch responses expose unified image metadata", () => {
  for (const field of [
    "mimeType",
    "format",
    "width",
    "height",
    "hasAlpha",
    "nativeAlphaChannel"
  ]) {
    assert.ok(source.includes(field), `missing metadata field: ${field}`);
  }
});
