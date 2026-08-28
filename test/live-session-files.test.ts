import assert from "node:assert/strict";
import test from "node:test";

import { liveSessionFiles } from "../extensions/live-session-files.ts";

test("live session indicators come directly from Tau registry instances", () => {
  const files = liveSessionFiles([
    { sessionFile: "/sessions/older.jsonl" },
    { sessionFile: "/sessions/newer.jsonl" },
    { sessionFile: "" },
  ]);

  assert.deepEqual([...files], [
    "/sessions/older.jsonl",
    "/sessions/newer.jsonl",
  ]);
});
