/** O que o `pulls.listFiles` devolve e o corte precisa. */
export type PrFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
};

export type OmitReason = "lockfile" | "minified" | "build" | "generated" | "size";

export type OmittedFile = {
  file: string;
  reason: OmitReason;
  /** Tamanho do trecho que ficou fora, só no corte por teto. */
  chars?: number;
};

export type LimitedDiff = {
  diff: string;
  omittedFiles: OmittedFile[];
  /**
   * A mesma lista em texto corrido, pronta para o prompt.
   *
   * Vai pronta no evento porque a interpolação do executor só sabe colar
   * texto ou JSON, e um modelo lendo `"reason": "size"` entende menos o que
   * não viu do que lendo "acima do teto".
   */
  omittedSummary: string;
};

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "cargo.lock",
  "go.sum",
]);

// Comparado por segmento inteiro do caminho: `src/distribution` não é `dist`.
const BUILD_DIRS = new Set(["dist", "build", "out", "target", "obj", ".next", "node_modules"]);
const GENERATED_DIRS = new Set(["__generated__", "generated"]);

const MINIFIED = /\.min\.(js|css|mjs)$|\.(js|css)\.map$/i;
const GENERATED = /\.(generated|g|designer)\.\w+$|\.pb\.go$|_pb2\.py$/i;

function reasonToSkip(path: string): OmitReason | undefined {
  const segments = path.split("/");
  const name = segments.pop()!;
  if (LOCKFILES.has(name.toLowerCase())) return "lockfile";
  if (MINIFIED.test(name)) return "minified";
  if (segments.some((s) => BUILD_DIRS.has(s.toLowerCase()))) return "build";
  if (GENERATED.test(name) || segments.some((s) => GENERATED_DIRS.has(s.toLowerCase()))) return "generated";
  return undefined;
}

const REASON_TEXT: Record<OmitReason, string> = {
  lockfile: "arquivo de lock",
  minified: "arquivo minificado",
  build: "pasta de build",
  generated: "código gerado",
  size: "acima do teto de tamanho do diff",
};

function summarize(omitted: OmittedFile[]): string {
  if (omitted.length === 0) return "nenhum";
  return omitted.map((o) => `- ${o.file} (${REASON_TEXT[o.reason]})`).join("\n");
}

/**
 * O diff que vai para o modelo, sem o que não se revisa e dentro do teto.
 *
 * O corte é por arquivo inteiro. Metade de um arquivo parece arquivo completo
 * para o modelo, e ele afirmaria que o resto não tem defeito. Arquivo que não
 * cabe sai inteiro e os seguintes continuam tentando, porque um arquivo gigante
 * no meio da lista não é motivo para deixar os pequenos depois dele sem leitura.
 */
export function limitDiff(files: PrFile[], maxChars: number): LimitedDiff {
  const omittedFiles: OmittedFile[] = [];
  const parts: string[] = [];
  let used = 0;
  const SEPARATOR = "\n\n";

  for (const f of files) {
    const skip = reasonToSkip(f.filename);
    if (skip !== undefined) {
      omittedFiles.push({ file: f.filename, reason: skip });
      continue;
    }

    const part = `--- ${f.filename} (${f.status}, +${f.additions} -${f.deletions})\n${f.patch ?? "(sem patch)"}`;
    const cost = part.length + (parts.length > 0 ? SEPARATOR.length : 0);
    if (used + cost > maxChars) {
      omittedFiles.push({ file: f.filename, reason: "size", chars: f.patch?.length ?? 0 });
      continue;
    }

    parts.push(part);
    used += cost;
  }

  return { diff: parts.join(SEPARATOR), omittedFiles, omittedSummary: summarize(omittedFiles) };
}
