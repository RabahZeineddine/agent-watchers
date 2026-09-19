import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillRule } from "../config/types.js";

export type LoadedSkill = {
  name: string;
  description: string;
  body: string;
  origin: string;
  /** Sem o hash a metrica mente quando o plugin externo atualiza a skill. */
  hash: string;
};

function roots(): string[] {
  const home = homedir();
  return [
    join(home, ".claude", "skills"),
    join(home, ".claude", "plugins"),
    join(process.cwd(), ".claude", "skills"),
  ].filter((p) => existsSync(p));
}

function findSkillFiles(dir: string, depth = 0): string[] {
  if (depth > 4) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) {
      if (entry === "SKILL.md") out.push(full);
      continue;
    }
    out.push(...findSkillFiles(full, depth + 1));
  }
  return out;
}

function parseFrontmatter(raw: string): { name?: string; description?: string; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { body: raw };
  const [, head, body = ""] = match;
  const field = (key: string) =>
    head!.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "");
  return { name: field("name"), description: field("description"), body };
}

/** Acervo do usuario e dos plugins, sem formato novo. */
export function discoverSkills(): Map<string, LoadedSkill> {
  const found = new Map<string, LoadedSkill>();
  for (const root of roots()) {
    for (const file of findSkillFiles(root)) {
      const raw = readFileSync(file, "utf8");
      const { name, description, body } = parseFrontmatter(raw);
      if (!name) continue;
      found.set(name, {
        name,
        description: description ?? "",
        body,
        origin: file,
        hash: createHash("sha256").update(raw).digest("hex").slice(0, 12),
      });
    }
  }
  return found;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(/\*\*\//g, "(?:.*/)?").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
  return new RegExp(`^${body}$`);
}

export type SkillContext = { repo: string; changedFiles: string[] };

/**
 * Selecao deterministica pelos arquivos alterados no evento, nao pela
 * linguagem do repositorio: PR que so mexe no frontend de um repo poliglota
 * carrega a skill de front, nao a de backend.
 */
export function selectSkills(
  rules: SkillRule[],
  ctx: SkillContext,
  catalog = discoverSkills(),
): LoadedSkill[] {
  const picked: LoadedSkill[] = [];

  for (const rule of rules) {
    const { always, filesMatch, repoMatch } = rule.when;
    let hit = Boolean(always);

    if (!hit && repoMatch?.length) {
      hit = repoMatch.some((g) => globToRegExp(g).test(ctx.repo));
    }
    if (!hit && filesMatch?.length) {
      const patterns = filesMatch.map(globToRegExp);
      hit = ctx.changedFiles.some((f) => patterns.some((p) => p.test(f)));
    }
    if (!hit) continue;

    const skill = catalog.get(rule.skill);
    if (skill && !picked.some((s) => s.name === skill.name)) picked.push(skill);
  }

  return picked;
}

/**
 * Divulgacao progressiva. So nome e descricao entram no prompt; o corpo vem
 * sob demanda. Dez candidatas custam ~400 tokens em vez de 20 mil.
 */
export function skillsPreamble(skills: LoadedSkill[], inline: boolean): string {
  if (skills.length === 0) return "";
  if (inline) {
    return skills.map((s) => `## Skill: ${s.name}\n\n${s.body}`).join("\n\n");
  }
  return [
    "Skills disponiveis para esta tarefa:",
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
  ].join("\n");
}
