using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using GlpiBoard.Api.Config;
using GlpiBoard.Api.Glpi;

namespace GlpiBoard.Api.Board;

/// <summary>Ticket do relatório por técnico. Tema = nível 2 da categoria (ou inferido pelo título).</summary>
public sealed record TechReportTicket
{
    public int Id { get; init; }
    public string Title { get; init; } = "";
    public int Status { get; init; }
    public string StatusLabel { get; init; } = "";
    public string? Entity { get; init; }
    public string Url { get; init; } = "";
    public List<int> TechIds { get; init; } = new();
    public List<int> RequesterIds { get; init; } = new();
    public DateTimeOffset? OpenedAtUtc { get; init; }
    /// <summary>Categoria completa como está no ITSM ("A > B > C").</summary>
    public string? Category { get; init; }
    /// <summary>"A > B" (nível 2); nível 1 quando ele não tem subcategorias ou quando não deu para inferir.</summary>
    public string? Theme { get; init; }
    /// <summary>categoria | inferido | nivel1 (só nível 1, sem inferência segura) | sem (sem categoria).</summary>
    public string ThemeSource { get; init; } = "sem";
    /// <summary>Confiança da inferência (0–100), só quando ThemeSource = inferido.</summary>
    public int? Confidence { get; init; }
}

public sealed record TechReport
{
    public DateTimeOffset GeneratedAtUtc { get; init; }
    public long DurationMs { get; init; }
    public string From { get; init; } = "";
    public string To { get; init; } = "";
    /// <summary>Técnicos e requerentes citados nos tickets.</summary>
    public List<PersonRef> People { get; init; } = new();
    public List<TechReportTicket> Tickets { get; init; } = new();
    /// <summary>Quantos tickets (últimos 365 dias, com nível 2) ensinaram a inferência.</summary>
    public int TrainingTickets { get; init; }
    public List<string> Warnings { get; init; } = new();
}

public sealed record TechReportResponse(TechReport? Report, string? Error, int? ThrottledSeconds = null);

/// <summary>
/// Relatório por técnico: tickets ABERTOS no período (fuso do ITSM). Técnico = atribuído (campo 5), requerente = campo 4,
/// categoria = campo 7. Tickets classificados só no nível 1 (ou sem categoria) recebem o nível 2 por inferência
/// conservadora a partir do título — ver <see cref="ThemeModel"/>.
/// </summary>
public sealed class TechReportService(GlpiClient glpi, BoardSettings settings, ILogger<TechReportService> log)
{
    public const int MaxDays = 366;
    private const string F_ID = "2", F_NAME = "1", F_STATUS = "12", F_DATE = "15", F_CATEGORY = "7", F_REQUESTER = "4", F_ENTITY = "80", F_TECH = "5";
    private static readonly string[] Display = [F_ID, F_NAME, F_STATUS, F_DATE, F_CATEGORY, F_REQUESTER, F_ENTITY, F_TECH];
    private static readonly TimeSpan ModelTtl = TimeSpan.FromHours(6);

    private readonly SemaphoreSlim _lock = new(1, 1);
    private readonly Dictionary<string, TechReport> _cache = new();
    private DateTimeOffset _lastAttempt = DateTimeOffset.MinValue;
    private Trained? _trained;
    private Dictionary<int, string>? _users;
    private DateTimeOffset _usersAt = DateTimeOffset.MinValue;

    /// <summary>Modelo + as linhas usadas para treiná-lo (reaproveitadas quando o período cabe na janela).</summary>
    private sealed record Trained(ThemeModel Model, DateOnly From, DateOnly To, List<JsonElement> Rows, DateTimeOffset At);

    public async Task<TechReportResponse> GetAsync(DateOnly from, DateOnly to, bool force, CancellationToken ct)
    {
        await _lock.WaitAsync(ct);
        try
        {
            var key = $"{from:yyyy-MM-dd}_{to:yyyy-MM-dd}";
            var now = DateTimeOffset.UtcNow;
            _cache.TryGetValue(key, out var cached);
            var fresh = cached is not null && (now - cached.GeneratedAtUtc).TotalSeconds < settings.CacheSeconds;
            var throttled = force && (now - _lastAttempt).TotalSeconds < settings.RefreshMinIntervalSeconds;
            if (cached is not null && (fresh && !force || throttled))
                return new(cached, null, throttled ? settings.RefreshMinIntervalSeconds : null);

            _lastAttempt = now;
            try
            {
                var rep = await BuildAsync(from, to, force, ct);
                _cache[key] = rep;
                return new(rep, null);
            }
            catch (Exception ex) when (ex is GlpiException or HttpRequestException or TaskCanceledException or JsonException)
            {
                log.LogWarning("Relatório por técnico falhou: {Message}", ex.Message);
                return new(cached, ex is TaskCanceledException ? "Tempo esgotado ao consultar o ITSM." : ex.Message);
            }
        }
        finally { _lock.Release(); }
    }

    private async Task<TechReport> BuildAsync(DateOnly from, DateOnly to, bool force, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var warnings = new ConcurrentBag<string>();
        var now = DateTimeOffset.UtcNow;
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, settings.GlpiTimeZone).DateTime);
        await using var session = await glpi.OpenSessionAsync(ct);

        // modelo de temas: últimos 365 dias, renovado a cada 6 h (ou no "Atualizar")
        var trained = _trained;
        if (trained is null || force || now - trained.At > ModelTtl)
        {
            var mFrom = today.AddDays(-364);
            var mRows = await SearchAsync(session, mFrom, today, ct);
            var cats = await LoadCategoriesAsync(session, warnings, ct);
            var samples = mRows.Select(r => (Title: Title(r), Category: BoardService.CleanDropdown(Str(r, F_CATEGORY))));
            trained = _trained = new Trained(ThemeModel.Train(samples, cats), mFrom, today, mRows, now);
        }

        // período dentro da janela do modelo e buscado há pouco: reaproveita as linhas
        var reuse = from >= trained.From && to <= trained.To && (now - trained.At).TotalSeconds < settings.CacheSeconds;
        var rows = reuse ? trained.Rows : await SearchAsync(session, from, to, ct);

        var tickets = new List<TechReportTicket>();
        var seen = new HashSet<int>();
        foreach (var r in rows)
        {
            if (Int(r, F_ID) is not { } id || !seen.Add(id)) continue;
            var opened = BoardService.ToUtc(Str(r, F_DATE), settings);
            if (opened is null) continue;
            var day = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(opened.Value, settings.GlpiTimeZone).DateTime);
            if (day < from || day > to) continue;
            var title = Title(r);
            var category = BoardService.CleanDropdown(Str(r, F_CATEGORY));
            var (theme, source, conf) = trained.Model.ThemeOf(title, category);
            var status = Int(r, F_STATUS) ?? 0;
            tickets.Add(new TechReportTicket
            {
                Id = id,
                Title = title.Length > 0 ? title : $"(sem título) #{id}",
                Status = status,
                StatusLabel = BoardService.StatusLabels.GetValueOrDefault(status, $"Status {status}"),
                Entity = BoardService.CleanDropdown(Str(r, F_ENTITY)),
                Url = $"{settings.GlpiWebBase}/front/ticket.form.php?id={id}",
                TechIds = Ids(r, F_TECH),
                RequesterIds = Ids(r, F_REQUESTER),
                OpenedAtUtc = opened,
                Category = category,
                Theme = theme,
                ThemeSource = source,
                Confidence = conf,
            });
        }

        var names = await NamesAsync(session, tickets.SelectMany(t => t.TechIds.Concat(t.RequesterIds)).ToHashSet(), force, warnings, ct);
        return new TechReport
        {
            GeneratedAtUtc = DateTimeOffset.UtcNow,
            DurationMs = sw.ElapsedMilliseconds,
            From = from.ToString("yyyy-MM-dd"),
            To = to.ToString("yyyy-MM-dd"),
            People = names.Select(kv => new PersonRef(kv.Key, kv.Value)).OrderBy(p => p.Name).ToList(),
            Tickets = tickets.OrderBy(t => t.OpenedAtUtc).ToList(),
            TrainingTickets = trained.Model.TrainingCount,
            Warnings = warnings.Distinct().OrderBy(w => w).ToList(),
        };
    }

    private Task<List<JsonElement>> SearchAsync(GlpiClient.Session session, DateOnly from, DateOnly to, CancellationToken ct)
    {
        const string fmt = "yyyy-MM-dd HH:mm:ss";
        var q = new List<KeyValuePair<string, string>>
        {
            new("criteria[0][field]", F_DATE), new("criteria[0][searchtype]", "morethan"),
            new("criteria[0][value]", from.ToDateTime(TimeOnly.MinValue).AddSeconds(-1).ToString(fmt, CultureInfo.InvariantCulture)),
            new("criteria[1][link]", "AND"),
            new("criteria[1][field]", F_DATE), new("criteria[1][searchtype]", "lessthan"),
            new("criteria[1][value]", to.AddDays(1).ToDateTime(TimeOnly.MinValue).ToString(fmt, CultureInfo.InvariantCulture)),
        };
        for (var i = 0; i < Display.Length; i++) q.Add(new($"forcedisplay[{i}]", Display[i]));
        return glpi.SearchAllParallelAsync(session, "Ticket", q, ct);
    }

    /// <summary>Árvore de categorias (para saber quais nível 1 têm subcategorias).</summary>
    private async Task<List<string>> LoadCategoriesAsync(GlpiClient.Session session, ConcurrentBag<string> warnings, CancellationToken ct)
    {
        var list = new List<string>();
        try
        {
            for (var start = 0; start < 10000; start += 1000)
            {
                var page = await glpi.GetAsync(session, $"ITILCategory?range={start}-{start + 999}&expand_dropdowns=false", ct);
                if (page is not { ValueKind: JsonValueKind.Array } arr) break;
                var n = 0;
                foreach (var c in arr.EnumerateArray()) { n++; if (BoardService.CleanDropdown(Str(c, "completename")) is { } cn) list.Add(cn); }
                if (n < 1000) break;
            }
        }
        catch (GlpiException ex) when (ex.StatusCode is 401 or 403)
        {
            warnings.Add("Sem permissão para ler Categorias no ITSM — a inferência usa só as categorias vistas nos tickets.");
        }
        return list;
    }

    /// <summary>Nomes de usuários: lista completa (cache de 6 h) + busca individual dos que faltarem (ex.: excluídos).</summary>
    internal async Task<Dictionary<int, string>> NamesAsync(GlpiClient.Session session, HashSet<int> ids, bool force, ConcurrentBag<string> warnings, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        if (_users is null || force || now - _usersAt > ModelTtl)
        {
            var all = new Dictionary<int, string>();
            try
            {
                // busca só id(2), login(1), sobrenome(34) e nome(9) — a lista /User completa é ~25x mais lenta
                var q = new List<KeyValuePair<string, string>> { new("forcedisplay[0]", "2"), new("forcedisplay[1]", "1"), new("forcedisplay[2]", "9"), new("forcedisplay[3]", "34") };
                foreach (var u in await glpi.SearchAllParallelAsync(session, "User", q, ct, pageSize: 1000))
                {
                    if (Int(u, "2") is not { } uid) continue;
                    var full = $"{Str(u, "9")} {Str(u, "34")}".Trim();
                    all[uid] = FixMojibake(System.Net.WebUtility.HtmlDecode(full.Length > 0 ? full : Str(u, "1") ?? $"Usuário #{uid}"));
                }
            }
            catch (GlpiException ex) when (ex.StatusCode is 401 or 403)
            {
                warnings.Add("Sem permissão para ler Usuários no ITSM — pessoas exibidas pelo ID. Conceda leitura de Usuários ao perfil da API.");
            }
            _users = all; _usersAt = now;
        }
        var users = _users;
        var result = new ConcurrentDictionary<int, string>();
        var missing = new List<int>();
        foreach (var id in ids.Where(i => i > 0)) { if (users.TryGetValue(id, out var nm)) result[id] = nm; else missing.Add(id); }

        using var gate = new SemaphoreSlim(6);
        await Task.WhenAll(missing.Take(300).Select(async id =>
        {
            await gate.WaitAsync(ct);
            try
            {
                var u = await glpi.GetAsync(session, $"User/{id}", ct);
                result[id] = u is { ValueKind: JsonValueKind.Object } e ? UserName(e, id) : $"Usuário #{id}";
            }
            catch (GlpiException) { result[id] = $"Usuário #{id}"; }
            finally { gate.Release(); }
        }));
        foreach (var id in missing) result.TryAdd(id, $"Usuário #{id}");
        return new Dictionary<int, string>(result);
    }

    private static string UserName(JsonElement u, int id)
    {
        var full = $"{Str(u, "firstname")} {Str(u, "realname")}".Trim();
        return FixMojibake(full.Length > 0 ? System.Net.WebUtility.HtmlDecode(full) : Str(u, "name") ?? $"Usuário #{id}");
    }

    /// <summary>"HernÃ¡ndez" → "Hernández": nome gravado no ITSM como UTF-8 lido em Latin-1. Só troca se a reconversão for válida.</summary>
    private static string FixMojibake(string s)
    {
        if (s.IndexOf('Ã') < 0 && s.IndexOf('Â') < 0) return s;
        if (s.Any(c => c > 0xFF)) return s;
        var bytes = s.Select(c => (byte)c).ToArray();
        try { return new UTF8Encoding(false, true).GetString(bytes); }
        catch (DecoderFallbackException) { return s; }
    }

    private static string Title(JsonElement r) => System.Net.WebUtility.HtmlDecode(Str(r, F_NAME) ?? "").Trim();

    /// <summary>Campos de usuário vêm como "251" ou ["251","572"].</summary>
    private static List<int> Ids(JsonElement r, string field)
    {
        if (!r.TryGetProperty(field, out var v)) return new();
        var items = v.ValueKind == JsonValueKind.Array ? v.EnumerateArray().ToList() : [v];
        return items.Select(GlpiClient.ReadInt).Where(i => i is > 0).Select(i => i!.Value).Distinct().ToList();
    }

    private static int? Int(JsonElement e, string p) => e.TryGetProperty(p, out var v) ? GlpiClient.ReadInt(v) : null;
    private static string? Str(JsonElement e, string p)
    {
        if (!e.TryGetProperty(p, out var v)) return null;
        var s = GlpiClient.ReadString(v);
        return string.IsNullOrWhiteSpace(s) ? null : s.Trim();
    }
}

/// <summary>
/// Inferência do nível 2 da categoria pelo título (Naive Bayes sobre palavras), treinada com os tickets que já têm nível 2.
/// Critérios para aceitar (calibrados com 5,6 mil tickets reais — acerto de ~99% no nível 1 e ~93% sem categoria):
/// 1) ticket só no nível 1: escolhe entre as subcategorias DESSE nível 1, probabilidade ≥ 75%;
///    ticket sem categoria: escolhe entre todas as de nível 2, probabilidade ≥ 90%;
/// 2) e o título precisa ter pelo menos uma palavra-chave FORTE da categoria escolhida
///    (vista ≥ 3 vezes nela e com ≥ 60% das ocorrências nela). Sem isso, não infere.
/// </summary>
public sealed class ThemeModel
{
    private const double MinP1 = 0.75, MinP0 = 0.90, StrongShare = 0.6;
    private const int StrongMin = 3, MinClassSize = 5;
    private static readonly HashSet<string> Stop = new((
        "de da do das dos para com sem por que uma um the and for to of in on em no na nos nas ao aos as os ou se sua seu meu minha " +
        "via del los las con el la y en al are is be this that please favor solicito solicitacao chamado abertura urgente re fw fwd enc rv " +
        "ticket problema erro help request").Split(' '));

    private readonly Dictionary<string, Dictionary<string, int>> _cnt = new();
    private readonly Dictionary<string, int> _tot = new();
    private readonly Dictionary<string, int> _words = new();   // total de palavras por classe
    private readonly Dictionary<string, int> _wsum = new();    // ocorrências da palavra em todas as classes
    private readonly Dictionary<string, List<string>> _children = new(StringComparer.OrdinalIgnoreCase);
    private List<string> _allLevel2 = new();
    private int _vocab;
    public int TrainingCount { get; private set; }

    public static ThemeModel Train(IEnumerable<(string Title, string? Category)> samples, IEnumerable<string> treeCompleteNames)
    {
        var m = new ThemeModel();
        var level2 = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var cn in treeCompleteNames) if (Level2(cn) is { } k) level2.Add(k);
        foreach (var (title, cat) in samples)
        {
            if (Level2(cat) is not { } k) continue;
            level2.Add(k);
            m.TrainingCount++;
            m._tot[k] = m._tot.GetValueOrDefault(k) + 1;
            m.Add(k, Tokens(title), 1);
        }
        // o próprio nome da subcategoria também ensina (peso 3)
        foreach (var k in level2) m.Add(k, Tokens(k.Split(" > ")[1]), 3);
        foreach (var k in level2) { var p = k.Split(" > ")[0]; if (!m._children.TryGetValue(p, out var l)) m._children[p] = l = new(); l.Add(k); }
        m._allLevel2 = level2.Where(k => m._tot.GetValueOrDefault(k) >= MinClassSize).ToList();
        m._vocab = Math.Max(1, m._wsum.Count);
        return m;
    }

    private void Add(string k, IEnumerable<string> words, int weight)
    {
        if (!_cnt.TryGetValue(k, out var c)) _cnt[k] = c = new();
        foreach (var w in words)
        {
            c[w] = c.GetValueOrDefault(w) + weight;
            _words[k] = _words.GetValueOrDefault(k) + weight;
            _wsum[w] = _wsum.GetValueOrDefault(w) + weight;
        }
    }

    /// <summary>Tema do ticket: (tema, origem, confiança).</summary>
    public (string? Theme, string Source, int? Confidence) ThemeOf(string title, string? category)
    {
        var parts = Parts(category);
        if (parts.Length >= 2) return ($"{parts[0]} > {parts[1]}", "categoria", null);
        if (parts.Length == 1)
        {
            if (!_children.TryGetValue(parts[0], out var kids) || kids.Count == 0) return (parts[0], "categoria", null); // nível 1 sem filhos
            if (kids.Count == 1) return (parts[0], "nivel1", null);  // só uma opção: não força
            return Classify(title, kids, MinP1) is { } g ? (g.Key, "inferido", g.Pct) : (parts[0], "nivel1", null);
        }
        return Classify(title, _allLevel2, MinP0) is { } h ? (h.Key, "inferido", h.Pct) : (null, "sem", null);
    }

    private (string Key, int Pct)? Classify(string title, IReadOnlyCollection<string> cands, double minP)
    {
        var ws = Tokens(title).Where(_wsum.ContainsKey).ToList();
        if (ws.Count == 0 || cands.Count == 0) return null;
        double n = cands.Sum(k => _tot.GetValueOrDefault(k) + 1);
        var scored = cands.Select(k =>
        {
            _cnt.TryGetValue(k, out var c); c ??= new();
            double s = Math.Log((_tot.GetValueOrDefault(k) + 1) / n), words = _words.GetValueOrDefault(k) + _vocab;
            foreach (var w in ws) s += Math.Log((c.GetValueOrDefault(w) + 1) / words);
            var strong = ws.Count(w => c.GetValueOrDefault(w) >= StrongMin && (double)c[w] / _wsum[w] >= StrongShare);
            return (Key: k, Score: s, Strong: strong);
        }).ToList();
        var max = scored.Max(x => x.Score);
        var z = scored.Sum(x => Math.Exp(x.Score - max));
        var best = scored.MaxBy(x => x.Score);
        var p = 1 / z;    // exp(best - max) = 1
        return p >= minP && best.Strong >= 1 ? (best.Key, (int)Math.Round(p * 100)) : null;
    }

    private static string[] Parts(string? category) =>
        string.IsNullOrWhiteSpace(category) ? [] : category.Split('>', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    private static string? Level2(string? category) { var p = Parts(category); return p.Length >= 2 ? $"{p[0]} > {p[1]}" : null; }

    internal static IEnumerable<string> Tokens(string? s)
    {
        if (string.IsNullOrEmpty(s)) return [];
        var sb = new StringBuilder(s.Length);
        foreach (var ch in s.ToLowerInvariant().Normalize(NormalizationForm.FormD))
        {
            if (CharUnicodeInfo.GetUnicodeCategory(ch) == UnicodeCategory.NonSpacingMark) continue;
            sb.Append(ch is >= 'a' and <= 'z' or >= '0' and <= '9' ? ch : ' ');
        }
        return sb.ToString().Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .Where(w => w.Length >= 3 && !Stop.Contains(w) && !w.All(char.IsDigit)).Distinct();
    }
}
