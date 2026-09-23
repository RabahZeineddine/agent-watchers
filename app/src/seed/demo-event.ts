import { summarizeChecks } from "../sources/ci-status.js";
import type { PrContext } from "../sources/github.js";

/**
 * Evento sintetico para fumaca: exercita o executor, os runtimes e a fila de
 * aprovacao sem depender de credencial do GitHub. O diff tem defeito real
 * plantado, entao um run que devolve zero achado indica problema no pipeline.
 */
export const demoPr: PrContext = {
  repo: "exemplo/loja-api",
  owner: "exemplo",
  repoName: "loja-api",
  pull: 482,
  title: "Corrige validacao de expiracao do token",
  description: "Ajusta o TokenValidator e o cache de sessao.",
  headSha: "abc123def456",
  author: "alice.exemplo",
  baseBranch: "main",
  headBranch: "fix/token-expiry",
  url: "https://github.com/exemplo/loja-api/pull/482",
  additions: 15,
  deletions: 6,
  fileCount: 2,
  draft: false,
  changedFiles: ["src/Auth/TokenValidator.cs", "src/Auth/SessionCache.cs"],
  omittedFiles: [],
  omittedSummary: "nenhum",
  ci: summarizeChecks([]),
  diff: `--- src/Auth/TokenValidator.cs (modified, +9 -4)
@@ -38,10 +38,15 @@ public sealed class TokenValidator
-    public bool IsExpired(Token token) => token.ExpiresAt < DateTime.UtcNow;
+    public bool IsExpired(Token token)
+    {
+        var now = DateTime.Now;
+        return token.ExpiresAt < now;
+    }
 
-    public async Task<bool> ValidateAsync(Token token)
+    public bool Validate(Token token)
     {
-        var revoked = await _revocationStore.IsRevokedAsync(token.Id);
+        var revoked = _revocationStore.IsRevokedAsync(token.Id).Result;
         return !IsExpired(token) && !revoked;
     }

--- src/Auth/SessionCache.cs (modified, +6 -2)
@@ -21,8 +21,12 @@ public sealed class SessionCache
-    private readonly ConcurrentDictionary<string, Session> _items = new();
+    private readonly Dictionary<string, Session> _items = new();
 
     public void Put(string key, Session session)
     {
-        _items[key] = session;
+        if (!_items.ContainsKey(key)) _items.Add(key, session);
+        else _items[key] = session;
     }`,
};

/**
 * Par do evento de cima, com diff correto: troca literal por constante sem
 * mudar comportamento. Existe para testar a regra de não inventar achado, e por
 * isso fica longe de autenticação, concorrência e dado de entrada, onde um
 * revisor rigoroso sempre acha o que especular. Qualquer achado aqui é ruído.
 */
export const demoCleanPr: PrContext = {
  repo: "exemplo/loja-api",
  owner: "exemplo",
  repoName: "loja-api",
  pull: 483,
  title: "Extrai a extensão do nome do relatório para constante",
  description:
    "Sem mudança de comportamento. O nome gerado continua o mesmo; a constante prepara o formato xlsx do próximo pull request.",
  headSha: "def789abc012",
  author: "alice.exemplo",
  baseBranch: "main",
  headBranch: "refactor/extensao-relatorio",
  url: "https://github.com/exemplo/loja-api/pull/483",
  additions: 3,
  deletions: 1,
  fileCount: 1,
  draft: false,
  changedFiles: ["src/Relatorios/NomeDoArquivo.cs"],
  omittedFiles: [],
  omittedSummary: "nenhum",
  ci: summarizeChecks([]),
  diff: `--- src/Relatorios/NomeDoArquivo.cs (modified, +3 -1)
@@ -5,6 +5,8 @@ namespace Loja.Relatorios;
 public static class NomeDoArquivo
 {
+    private const string Extensao = ".csv";
+
     public static string Para(string pedido, DateOnly referencia)
-        => $"{pedido}_{referencia:yyyyMMdd}.csv";
+        => $"{pedido}_{referencia:yyyyMMdd}{Extensao}";
 }`,
};
