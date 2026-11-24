using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using GlpiBoard.Api.Config;

namespace GlpiBoard.Api.Glpi;

/// <summary>
/// Cliente mínimo da API REST legada do GLPI (apirest.php, v9.5/10.x).
/// Abre uma sessão por sincronização e a encerra ao final (killSession).
/// Credenciais nunca são logadas.
/// </summary>
public sealed class GlpiClient(HttpClient http, BoardSettings settings, ILogger<GlpiClient> log)
{
    public sealed class Session(GlpiClient owner, string token) : IAsyncDisposable
    {
        internal string Token { get; } = token;
        public ValueTask DisposeAsync() => new(owner.KillSessionAsync(Token));
    }

    public async Task<Session> OpenSessionAsync(CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, $"{settings.GlpiUrl}/initSession");
        if (!string.IsNullOrEmpty(settings.AppToken)) req.Headers.Add("App-Token", settings.AppToken);

        if (settings.UsesUserToken)
            req.Headers.TryAddWithoutValidation("Authorization", $"user_token {settings.UserToken}");
        else if (settings.UsesCredentials)
            req.Headers.Authorization = new AuthenticationHeaderValue("Basic",
                Convert.ToBase64String(Encoding.UTF8.GetBytes($"{settings.Username}:{settings.Password}")));
        else
            throw new GlpiException("Nenhuma credencial ITSM configurada.");

        using var res = await http.SendAsync(req, ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode)
            throw new GlpiException($"initSession falhou ({(int)res.StatusCode}): {SafeError(body)}", (int)res.StatusCode);

        using var doc = JsonDocument.Parse(body);
        var token = doc.RootElement.TryGetProperty("session_token", out var t) ? t.GetString() : null;
        if (string.IsNullOrEmpty(token)) throw new GlpiException("initSession não retornou session_token.");
        return new Session(this, token);
    }

    private async Task KillSessionAsync(string token)
    {
        try
        {
            using var req = Build(HttpMethod.Get, "killSession", token);
            using var _ = await http.SendAsync(req);
        }
        catch (Exception ex) { log.LogDebug(ex, "killSession falhou (ignorado)"); }
    }

    /// <summary>GET genérico. Retorna null para 404/ERROR_ITEM_NOT_FOUND (sub-itens inexistentes).</summary>
    public async Task<JsonElement?> GetAsync(Session s, string pathAndQuery, CancellationToken ct)
    {
        using var req = Build(HttpMethod.Get, pathAndQuery, s.Token);
        using var res = await http.SendAsync(req, ct);
        var body = await res.Content.ReadAsStringAsync(ct);

        if (res.StatusCode == HttpStatusCode.NotFound) return null;
        // 206 Partial Content é sucesso paginado no GLPI
        if (!res.IsSuccessStatusCode)
        {
            if (body.Contains("ERROR_RANGE_EXCEED_TOTAL")) return null;
            throw new GlpiException($"GET {StripQuery(pathAndQuery)} falhou ({(int)res.StatusCode}): {SafeError(body)}", (int)res.StatusCode);
        }
        if (string.IsNullOrWhiteSpace(body)) return null;
        using var doc = JsonDocument.Parse(body);
        return doc.RootElement.Clone();
    }

    /// <summary>POST {itemtype} com {"input": {...}}. Retorna o id criado.</summary>
    public async Task<int> CreateAsync(Session s, string itemtype, object input, CancellationToken ct)
    {
        var root = await SendJsonAsync(s, HttpMethod.Post, itemtype, new { input }, ct);
        var id = root is { ValueKind: JsonValueKind.Object } o && o.TryGetProperty("id", out var v) ? ReadInt(v) : null;
        if (id is not > 0) throw new GlpiException($"POST {itemtype} não retornou id: {SafeError(root?.GetRawText() ?? "")}");
        return id.Value;
    }

    /// <summary>PUT {itemtype}/{id}. O GLPI responde 200 mesmo quando recusa: [{"5": false, "message": "..."}].</summary>
    public async Task UpdateAsync(Session s, string itemtype, int id, object input, CancellationToken ct)
    {
        var root = await SendJsonAsync(s, HttpMethod.Put, $"{itemtype}/{id}", new { input }, ct);
        if (root is { ValueKind: JsonValueKind.Array } a)
            foreach (var r in a.EnumerateArray())
                if (r.ValueKind == JsonValueKind.Object && r.TryGetProperty(id.ToString(), out var ok) && ok.ValueKind == JsonValueKind.False)
                    throw new GlpiException($"PUT {itemtype}/{id} recusado: {(r.TryGetProperty("message", out var m) ? m.GetString() : "")}");
    }

    /// <summary>DELETE {itemtype}/{id} (force_purge: apaga definitivamente). 404 é ignorado.</summary>
    public async Task DeleteAsync(Session s, string itemtype, int id, bool purge, CancellationToken ct)
    {
        using var req = Build(HttpMethod.Delete, $"{itemtype}/{id}{(purge ? "?force_purge=true" : "")}", s.Token);
        using var res = await http.SendAsync(req, ct);
        if (res.StatusCode == HttpStatusCode.NotFound) return;
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode)
            throw new GlpiException($"DELETE {itemtype}/{id} falhou ({(int)res.StatusCode}): {SafeError(body)}", (int)res.StatusCode);
    }

    private async Task<JsonElement?> SendJsonAsync(Session s, HttpMethod m, string path, object body, CancellationToken ct)
    {
        using var req = Build(m, path, s.Token);
        req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        using var res = await http.SendAsync(req, ct);
        var text = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode)
            throw new GlpiException($"{m} {StripQuery(path)} falhou ({(int)res.StatusCode}): {SafeError(text)}", (int)res.StatusCode);
        if (string.IsNullOrWhiteSpace(text)) return null;
        using var doc = JsonDocument.Parse(text);
        return doc.RootElement.Clone();
    }

    /// <summary>
    /// Executa /search/Ticket paginando automaticamente.
    /// criteria: lista de (prefixo-sem-índice-externo) já formatada pelo chamador.
    /// </summary>
    public async Task<List<JsonElement>> SearchAllAsync(Session s, string itemtype, IReadOnlyList<KeyValuePair<string, string>> query, CancellationToken ct, int pageSize = 500)
    {
        var all = new List<JsonElement>();
        var start = 0;
        while (true)
        {
            var qs = string.Join("&", query.Select(kv => $"{Uri.EscapeDataString(kv.Key)}={Uri.EscapeDataString(kv.Value)}"));
            var json = await GetAsync(s, $"search/{itemtype}?{qs}&range={start}-{start + pageSize - 1}", ct);
            if (json is null) break;
            var root = json.Value;
            var total = root.TryGetProperty("totalcount", out var tc) ? ReadInt(tc) ?? 0 : 0;
            if (root.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array)
                all.AddRange(data.EnumerateArray().Select(e => e.Clone()));
            start += pageSize;
            if (start >= total) break;
        }
        return all;
    }

    /// <summary>Igual a <see cref="SearchAllAsync"/>, mas busca as páginas restantes em paralelo (máx. <paramref name="parallelism"/>), mantendo a ordem.</summary>
    public async Task<List<JsonElement>> SearchAllParallelAsync(Session s, string itemtype, IReadOnlyList<KeyValuePair<string, string>> query, CancellationToken ct, int pageSize = 500, int parallelism = 4)
    {
        var qs = string.Join("&", query.Select(kv => $"{Uri.EscapeDataString(kv.Key)}={Uri.EscapeDataString(kv.Value)}"));
        async Task<(int Total, List<JsonElement> Rows)> Page(int start)
        {
            var json = await GetAsync(s, $"search/{itemtype}?{qs}&range={start}-{start + pageSize - 1}", ct);
            if (json is null) return (0, new());
            var root = json.Value;
            var total = root.TryGetProperty("totalcount", out var tc) ? ReadInt(tc) ?? 0 : 0;
            var rows = root.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array
                ? data.EnumerateArray().Select(e => e.Clone()).ToList() : new List<JsonElement>();
            return (total, rows);
        }

        var first = await Page(0);
        var all = new List<JsonElement>(Math.Max(first.Total, first.Rows.Count));
        all.AddRange(first.Rows);
        var starts = new List<int>();
        for (var st = pageSize; st < first.Total; st += pageSize) starts.Add(st);
        using var gate = new SemaphoreSlim(Math.Max(1, parallelism));
        var pages = await Task.WhenAll(starts.Select(async st =>
        {
            await gate.WaitAsync(ct);
            try { return (await Page(st)).Rows; }
            finally { gate.Release(); }
        }));
        foreach (var p in pages) all.AddRange(p);
        return all;
    }

    private HttpRequestMessage Build(HttpMethod m, string pathAndQuery, string sessionToken)
    {
        var req = new HttpRequestMessage(m, $"{settings.GlpiUrl}/{pathAndQuery}");
        req.Headers.Add("Session-Token", sessionToken);
        if (!string.IsNullOrEmpty(settings.AppToken)) req.Headers.Add("App-Token", settings.AppToken);
        return req;
    }

    private static string StripQuery(string p) => p.Split('?')[0];

    /// <summary>Mensagens de erro do GLPI vêm como ["ERROR_CODE","mensagem"]. Limita tamanho e não ecoa headers.</summary>
    private static string SafeError(string body)
    {
        if (string.IsNullOrWhiteSpace(body)) return "(sem corpo)";
        var b = body.Length > 300 ? body[..300] + "…" : body;
        return b.Replace("\n", " ");
    }

    public static int? ReadInt(JsonElement e) => e.ValueKind switch
    {
        JsonValueKind.Number => e.TryGetInt32(out var i) ? i : null,
        JsonValueKind.String => int.TryParse(e.GetString(), out var i) ? i : null,
        _ => null
    };

    public static string? ReadString(JsonElement e) => e.ValueKind switch
    {
        JsonValueKind.String => e.GetString(),
        JsonValueKind.Number => e.GetRawText(),
        JsonValueKind.Null or JsonValueKind.Undefined => null,
        _ => e.GetRawText()
    };
}
