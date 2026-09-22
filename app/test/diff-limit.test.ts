import { test } from "node:test";
import assert from "node:assert/strict";
import { limitDiff, type PrFile } from "../src/sources/diff-limit.js";
import { renderPrompt } from "../src/executor/executor.js";
import { prReviewSpec } from "../src/seed/pr-review.js";
import { GithubService, DEFAULT_DIFF_MAX_CHARS } from "../src/services/github-service.js";
import { SettingsService } from "../src/services/settings-service.js";
import { bancoDeTeste } from "./helpers/db.js";

const arquivo = (filename: string, patch = "@@ -1 +1 @@\n-a\n+b"): PrFile => ({
  filename,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch,
});

test("lockfile, minificado, build e gerado ficam fora e são listados", () => {
  const descartados = [
    "package-lock.json",
    "web/yarn.lock",
    "pnpm-lock.yaml",
    "Cargo.lock",
    "go.sum",
    "public/app.min.js",
    "dist/index.js",
    "src/Api/obj/Debug/Api.AssemblyInfo.cs",
    "src/__generated__/schema.ts",
    "src/Forms/Main.Designer.cs",
  ];
  const r = limitDiff([arquivo("src/Auth/TokenValidator.cs"), ...descartados.map((f) => arquivo(f))], 100_000);

  assert.match(r.diff, /TokenValidator\.cs/);
  for (const f of descartados) assert.doesNotMatch(r.diff, new RegExp(f.replace(/[.]/g, "\\.")));
  assert.deepEqual(
    r.omittedFiles.map((o) => o.file),
    descartados,
  );
  assert.equal(r.omittedFiles.find((o) => o.file === "go.sum")?.reason, "lockfile");
  assert.equal(r.omittedFiles.find((o) => o.file === "public/app.min.js")?.reason, "minified");
  assert.equal(r.omittedFiles.find((o) => o.file === "dist/index.js")?.reason, "build");
  assert.equal(r.omittedFiles.find((o) => o.file === "src/__generated__/schema.ts")?.reason, "generated");
});

test("arquivo que estoura o teto sai inteiro, sem corte no meio, e os menores seguem", () => {
  const grande = arquivo("src/Migrations/0042_Seed.cs", "+x".repeat(5_000));
  const r = limitDiff([arquivo("src/a.cs"), grande, arquivo("src/b.cs")], 2_000);

  assert.ok(r.diff.length <= 2_000);
  assert.match(r.diff, /src\/a\.cs/);
  assert.match(r.diff, /src\/b\.cs/);
  assert.doesNotMatch(r.diff, /0042_Seed/);
  assert.doesNotMatch(r.diff, /\+x/);
  assert.deepEqual(r.omittedFiles, [{ file: "src/Migrations/0042_Seed.cs", reason: "size", chars: grande.patch!.length }]);
});

test("pasta de nome parecido não é confundida com pasta de build", () => {
  const r = limitDiff([arquivo("src/distribution/rules.ts"), arquivo("src/builder.ts")], 100_000);
  assert.deepEqual(r.omittedFiles, []);
});

test("o prompt de triagem e de auditoria recebem o que ficou fora", () => {
  const r = limitDiff([arquivo("src/a.cs"), arquivo("package-lock.json")], 100_000);
  const evento = { repo: "o/r", changedFiles: ["src/a.cs", "package-lock.json"], ...r };

  for (const chave of ["triage", "audit"]) {
    const passo = prReviewSpec.steps.find((s) => s.key === chave);
    assert.ok(passo?.type === "model");
    const prompt = renderPrompt(passo.prompt, evento, new Map());
    assert.match(prompt, /package-lock\.json/, chave);
    assert.doesNotMatch(prompt, /"lockfile"/, `${chave}: motivo sai em texto, não em JSON`);
  }
});

test("nada de fora é dito com todas as letras", () => {
  const r = limitDiff([arquivo("src/a.cs")], 100_000);
  assert.deepEqual(r.omittedFiles, []);
  assert.equal(r.omittedSummary, "nenhum");
});

test("teto configurável com padrão e recusa de valor inválido", async () => {
  const service = new GithubService(undefined, new SettingsService(bancoDeTeste()));
  assert.equal(await service.diffMaxChars(), DEFAULT_DIFF_MAX_CHARS);

  await service.setDiffMaxChars(50_000);
  assert.equal(await service.diffMaxChars(), 50_000);

  await assert.rejects(service.setDiffMaxChars(0));
  await assert.rejects(service.setDiffMaxChars(1.5));
  assert.equal(await service.diffMaxChars(), 50_000);
});
