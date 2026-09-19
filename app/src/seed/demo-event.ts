import type { PrContext } from "../sources/github.js";

/**
 * Evento sintetico para fumaca: exercita o executor, os runtimes e a fila de
 * aprovacao sem depender de credencial do GitHub. O diff tem defeito real
 * plantado, entao um run que devolve zero achado indica problema no pipeline.
 */
export const demoPr: PrContext = {
  repo: "exemplo/loja-api",
  owner: "time",
  repoName: "loja-api",
  pull: 482,
  title: "Corrige validacao de expiracao do token",
  description: "Ajusta o TokenValidator e o cache de sessao.",
  headSha: "abc123def456",
  changedFiles: ["src/Auth/TokenValidator.cs", "src/Auth/SessionCache.cs"],
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
