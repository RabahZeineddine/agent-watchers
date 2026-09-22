import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { smokeHome } from "../src/db/path.js";

const REAL = join(homedir(), "Library", "Application Support", "locum");

test("fumaça sem pasta escolhida roda num rascunho, longe do banco real", () => {
  const env: NodeJS.ProcessEnv = {};
  const pasta = smokeHome(env);
  try {
    assert.ok(pasta.temporary);
    assert.notEqual(pasta.dir, REAL);
    assert.ok(!pasta.dir.startsWith(REAL));
    assert.equal(env.LOCUM_HOME, pasta.dir);
    assert.deepEqual(readdirSync(pasta.dir), []);
  } finally {
    pasta.cleanup();
  }
  assert.ok(!existsSync(pasta.dir));
});

test("pasta escolhida por quem chamou é respeitada e não é apagada", () => {
  const escolhida = process.env.LOCUM_HOME!;
  const env: NodeJS.ProcessEnv = { LOCUM_HOME: escolhida };
  const pasta = smokeHome(env);
  assert.equal(pasta.temporary, false);
  assert.equal(pasta.dir, escolhida);
  pasta.cleanup();
  assert.ok(existsSync(escolhida));
});
