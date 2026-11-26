using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using GlpiBoard.Api.Config;
using GlpiBoard.Api.Glpi;

namespace GlpiBoard.Api.Board;

/// <summary>Um ticket da análise por cliente. Pode estar em mais de um conjunto (fila atual, aberto no período, solucionado no período).</summary>
public sealed record ClientTicket
{
    public int Id { get; init; }
    public string Title { get; init; } = "";
    public int Status { get; init; }
    public string StatusLabel { get; init; } = "";
    public int? Priority { get; init; }
    public string? Entity { get; init; }
    public string? Category { get; init; }
    public string Url { get; init; } = "";
    public List<int> TechIds { get; init; } = new();
    public List<int> RequesterIds { get; init; } = new();
    public DateTimeOffset? OpenedAtUtc { get; init; }
    public DateTimeOffset? UpdatedAtUtc { get; init; }
    /// <summary>Data da solução; sem ela, a do fechamento.</summary>
    public DateTimeOffset? SolvedAtUtc { get; init; }
    public DateTimeOffset? TtoDueUtc { get; init; }
    public DateTimeOffset? TtrDueUtc { get; init; }
    /// <summary>Flags "excedido" do próprio ITSM (campos 159 e 82).</summary>
    public bool TtoLate { get; init; }
    public bool TtrLate { get; init; }
    /// <summary>Tempo até ser assumido, em horário útil do SLA (0/nulo = ainda não assumido).</summary>
    public long? TakeDelaySec { get; init; }
    public long? SolveDelaySec { get; init; }
    public string? SolutionType { get; init; }
    /// <summary>duplicidade | sem_retorno | solicitante | atendimento | null (não cancelado).</summary>
    public string? Cancel { get; init; }
    /// <summary>Chamado original, quando o texto da solução ou o vínculo "Duplica" o informa.</summary>
    public int? DuplicateOf { get; init; }
    /// <summary>Soluções recusadas (reaberturas) no período e no total.</summary>
    public int ReopenedInPeriod { get; init; }
    public int ReopenedTotal { get; init; }
    public bool InBacklog { get; init; }
    public bool InOpened { get; init; }
    public bool InSolved { get; init; }
}

public sealed record ClientReport
{
    public DateTimeOffset GeneratedAtUtc { get; init; }
    public long DurationMs { get; init; }
    public string From { get; init; } = "";
    public string To { get; init; } = "";
    public int Days { get; init; }
    public List<PersonRef> People { get; init; } = new();
    public List<ClientTicket> Tickets { get; init; } = new();
    public List<string> Warnings { get; init; } = new();
}

public sealed record ClientReportResponse(ClientReport? Report, string? Error, int? ThrottledSeconds = null);

/// <summary>
/// Análise por cliente (entidade): fila atual (status 1–4), tickets abertos e solucionados nos últimos N dias,
/// reaberturas (solução recusada), cancelamentos e duplicidades.
///
/// Cancelamento = tipo de solução com "cancelad" no nome. Classificação:
///   duplicidade : texto da solução diz que é duplicado ("cancelado por duplicidade", "chamado duplicado", "em duplicata")
///                 ou há vínculo "Duplica" entre tickets — vale mesmo com outro tipo de solução
///   sem_retorno : mensagem automática do status "Em Espera" (cliente não respondeu)
///   solicitante : tipo "Cancelado pelo solicitante"
///   atendimento : demais cancelamentos
/// </summary>
public sealed partial class ClientReportService(GlpiClient glpi, TechReportService people, BoardSettings settings, ILogger<ClientReportService> log)
{
    public const int MinDays = 7, MaxDays = 90;
    private const string F_ID = "2", F_NAME = "1", F_STATUS = "12", F_PRIORITY = "3", F_DATE = "15", F_DATEMOD = "19", F_SOLVEDATE = "17", F_CLOSEDATE = "16",
        F_CATEGORY = "7", F_ENTITY = "80", F_TECH = "5", F_REQUESTER = "4", F_TTR_DUE = "18", F_TTO_DUE = "155", F_TTR_LATE = "82", F_TTO_LATE = "159",
        F_TAKE = "150", F_SOLVE = "154", F_SOLTYPE = "23", F_SOLTEXT = "24";
    private static readonly string[] Display = [F_ID, F_NAME, F_STATUS, F_PRIORITY, F_DATE, F_DATEMOD, F_SOLVEDATE, F_CLOSEDATE, F_CATEGORY, F_ENTITY,
        F_TECH, F_REQUESTER, F_TTR_DUE, F_TTO_DUE, F_TTR_LATE, F_TTO_LATE, F_TAKE, F_SOLVE, F_SOLTYPE];
    private const int LINK_RELATED = 1, LINK_DUPLICATE = 2;
    private const int SOLUTION_REFUSED = 4;

    [GeneratedRegex(@"cancelad[oa]s?\s+por\s+duplicidade|chamados?\s+(?:foi\s+|est[áa]\s+)?duplicad|em\s+duplicata|duplicidade\s+de\s+chamado|j[áa]\s+existe\s+(?:um\s+)?chamado", RegexOptions.IgnoreCase)]
    private static partial Regex DupText();
    [GeneratedRegex(@"#?\b(\d{2,7})\b")]
    private static partial Regex Number();
    [GeneratedRegex(@"mensagem\s+autom[áa]tica.{0,80}em\s+espera", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex NoReturnText();
    [GeneratedRegex(@"<[^>]*>")]
    private static partial Regex Tags();

    private readonly SemaphoreSlim _lock = new(1, 1);
    private readonly Dictionary<int, ClientReport> _cache = new();
    private DateTimeOffset _lastAttempt = DateTimeOffset.MinValue;

    public async Task<ClientReportResponse> GetAsync(int days, bool force, CancellationToken ct)
    {
        await _lock.WaitAsync(ct);
        try
        {
            var now = DateTimeOffset.UtcNow;
            _cache.TryGetValue(days, out var cached);
            var fresh = cached is not null && (now - cached.GeneratedAtUtc).TotalSeconds < settings.CacheSeconds;
            var throttled = force && (now - _lastAttempt).TotalSeconds < settings.RefreshMinIntervalSeconds;
            if (cached is not null && (fresh && !force || throttled))
                return new(cached, null, throttled ? settings.RefreshMinIntervalSeconds : null);

            _lastAttempt = now;
            try
            {
                var rep = await BuildAsync(days, force, ct);
                _cache[days] = rep;
                return new(rep, null);
            }
            catch (Exception ex) when (ex is GlpiException or HttpRequestException or TaskCanceledException or JsonException)
            {
                log.LogWarning("Análise por cliente falhou: {Message}", ex.Message);
                return new(cached, ex is TaskCanceledException ? "Tempo esgotado ao consultar o ITSM." : ex.Message);
            }
        }
        finally { _lock.Release(); }
    }

    private async Task<ClientReport> BuildAsync(int days, bool force, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var warnings = new ConcurrentBag<string>();
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, settings.GlpiTimeZone).DateTime);
        var from = today.AddDays(-(days - 1));
        var start = from.ToDateTime(TimeOnly.MinValue);
        var end = today.AddDays(1).ToDateTime(TimeOnly.MinValue);
        var startUtc = new DateTimeOffset(start, settings.GlpiTimeZone.GetUtcOffset(start));

        await using var session = await glpi.OpenSessionAsync(ct);
        var backlogT = glpi.SearchAllParallelAsync(session, "Ticket", Query(Display, ("12", "equals", "notold")), ct);
        var openedT = glpi.SearchAllParallelAsync(session, "Ticket", Range(Display, F_DATE, start, end), ct);
        string[] solvedDisplay = [.. Display, F_SOLTEXT];
        var solvedT = glpi.SearchAllParallelAsync(session, "Ticket", Range(solvedDisplay, F_SOLVEDATE, start, end), ct);
        var closedT = glpi.SearchAllParallelAsync(session, "Ticket", Range(solvedDisplay, F_CLOSEDATE, start, end), ct);
        var refusedT = RefusedAsync(session, warnings, ct);
        var dupLinksT = DuplicateLinksAsync(session, warnings, ct);
        await Task.WhenAll(backlogT, openedT, solvedT, closedT, refusedT, dupLinksT);

        // une os conjuntos por id; a linha da busca de solucionados traz o texto da solução
        var rows = new Dictionary<int, (JsonElement Row, bool Backlog, bool Opened, bool SolvedSearch)>();
        void Add(IEnumerable<JsonElement> list, bool backlog, bool opened, bool solved)
        {
            foreach (var r in list)
            {
                if (Int(r, F_ID) is not { } id) continue;
                if (rows.TryGetValue(id, out var e))
                    rows[id] = (solved && !e.SolvedSearch ? r : e.Row, e.Backlog || backlog, e.Opened || opened, e.SolvedSearch || solved);
                else rows[id] = (r, backlog, opened, solved);
            }
        }
        Add(backlogT.Result, true, false, false);
        Add(openedT.Result, false, true, false);
        Add(solvedT.Result.Concat(closedT.Result), false, false, true);

        var refused = refusedT.Result;
        var dupLinks = dupLinksT.Result;
        var tickets = new List<ClientTicket>(rows.Count);
        foreach (var (id, (r, backlog, openedFlag, solvedSearch)) in rows)
        {
            var status = Int(r, F_STATUS) ?? 0;
            var opened = BoardService.ToUtc(Str(r, F_DATE), settings);
            var solvedAt = BoardService.ToUtc(Str(r, F_SOLVEDATE), settings) ?? BoardService.ToUtc(Str(r, F_CLOSEDATE), settings);
            var isOld = status is 5 or 6;
            var inSolved = solvedSearch && isOld && solvedAt is { } sa && InPeriod(sa, from, today);
            var inOpened = openedFlag && opened is { } oa && InPeriod(oa, from, today);
            var inBacklog = status is >= 1 and <= 4;
            if (!inSolved && !inOpened && !inBacklog) continue;

            var solType = Last(r, F_SOLTYPE);
            var (cancel, dupOf) = isOld ? Classify(id, solType, AllText(r, F_SOLTEXT), dupLinks.Dup, dupLinks.Related) : (null, null);
            refused.TryGetValue(id, out var refs);
            tickets.Add(new ClientTicket
            {
                Id = id,
                Title = Title(r, id),
                Status = status,
                StatusLabel = BoardService.StatusLabels.GetValueOrDefault(status, $"Status {status}"),
                Priority = Int(r, F_PRIORITY),
                Entity = BoardService.CleanDropdown(Str(r, F_ENTITY)),
                Category = BoardService.CleanDropdown(Str(r, F_CATEGORY)),
                Url = $"{settings.GlpiWebBase}/front/ticket.form.php?id={id}",
                TechIds = Ids(r, F_TECH),
                RequesterIds = Ids(r, F_REQUESTER),
                OpenedAtUtc = opened,
                UpdatedAtUtc = BoardService.ToUtc(Str(r, F_DATEMOD), settings),
                SolvedAtUtc = isOld ? solvedAt : null,
                TtoDueUtc = BoardService.ToUtc(Str(r, F_TTO_DUE), settings),
                TtrDueUtc = BoardService.ToUtc(Str(r, F_TTR_DUE), settings),
                TtoLate = Int(r, F_TTO_LATE) == 1,
                TtrLate = Int(r, F_TTR_LATE) == 1,
                TakeDelaySec = Long(r, F_TAKE),
                SolveDelaySec = Long(r, F_SOLVE),
                SolutionType = isOld ? solType : null,
                Cancel = cancel,
                DuplicateOf = dupOf,
                ReopenedInPeriod = refs?.Count(d => d >= startUtc) ?? 0,
                ReopenedTotal = refs?.Count ?? 0,
                InBacklog = inBacklog,
                InOpened = inOpened,
                InSolved = inSolved,
            });
        }

        var names = await people.NamesAsync(session, tickets.SelectMany(t => t.TechIds.Concat(t.RequesterIds)).ToHashSet(), force, warnings, ct);
        return new ClientReport
        {
            GeneratedAtUtc = DateTimeOffset.UtcNow,
            DurationMs = sw.ElapsedMilliseconds,
            From = from.ToString("yyyy-MM-dd"),
            To = today.ToString("yyyy-MM-dd"),
            Days = days,
            People = names.Select(kv => new PersonRef(kv.Key, kv.Value)).OrderBy(p => p.Name).ToList(),
            Tickets = tickets.OrderBy(t => t.OpenedAtUtc).ToList(),
            Warnings = warnings.Distinct().OrderBy(w => w).ToList(),
        };
    }

    private bool InPeriod(DateTimeOffset utc, DateOnly from, DateOnly to)
    {
        var d = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(utc, settings.GlpiTimeZone).DateTime);
        return d >= from && d <= to;
    }

    /// <summary>Tipo de cancelamento e chamado original (quando houver).</summary>
    private static (string? Cancel, int? DupOf) Classify(int id, string? solType, string text, Dictionary<int, int> dupLinks, Dictionary<int, List<int>> related)
    {
        var plain = System.Net.WebUtility.HtmlDecode(Tags().Replace(System.Net.WebUtility.HtmlDecode(text), " "));
        var m = DupText().Match(plain);
        if (m.Success || dupLinks.ContainsKey(id))
        {
            int? orig = dupLinks.TryGetValue(id, out var l) ? l : null;
            if (orig is null && m.Success)
            {
                // primeiro número depois da frase (ou na frase seguinte) que não seja o próprio ticket
                foreach (Match n in Number().Matches(plain[m.Index..Math.Min(plain.Length, m.Index + m.Length + 160)]))
                    if (int.TryParse(n.Groups[1].Value, out var v) && v != id && v > 10) { orig = v; break; }
            }
            // modelo "seguiremos através do chamado relacionado": o original é o ticket vinculado ("Ligado a")
            if (orig is null && related.TryGetValue(id, out var rel)) orig = rel.Where(x => x < id).DefaultIfEmpty(rel.Min()).Max();
            return ("duplicidade", orig);
        }
        var t = solType ?? "";
        if (!t.Contains("cancelad", StringComparison.OrdinalIgnoreCase)) return (null, null);
        if (NoReturnText().IsMatch(plain)) return ("sem_retorno", null);
        if (t.Contains("solicitante", StringComparison.OrdinalIgnoreCase)) return ("solicitante", null);
        return ("atendimento", null);
    }

    /// <summary>Soluções recusadas (= ticket reaberto), com a data da recusa, por ticket.</summary>
    private async Task<Dictionary<int, List<DateTimeOffset>>> RefusedAsync(GlpiClient.Session session, ConcurrentBag<string> warnings, CancellationToken ct)
    {
        var map = new Dictionary<int, List<DateTimeOffset>>();
        try
        {
            for (var start = 0; start < 50000; start += 1000)
            {
                var page = await glpi.GetAsync(session, $"ITILSolution?range={start}-{start + 999}&searchText[status]={SOLUTION_REFUSED}&searchText[itemtype]=Ticket", ct);
                if (page is not { ValueKind: JsonValueKind.Array } arr) break;
                var n = 0;
                foreach (var s in arr.EnumerateArray())
                {
                    n++;
                    if (Int(s, "status") != SOLUTION_REFUSED || Str(s, "itemtype") != "Ticket" || Int(s, "items_id") is not { } tid) continue;
                    var when = BoardService.ToUtc(Str(s, "date_approval") ?? Str(s, "date_mod"), settings);
                    if (when is null) continue;
                    (map.TryGetValue(tid, out var l) ? l : map[tid] = new()).Add(when.Value);
                }
                if (n < 1000) break;
            }
        }
        catch (GlpiException ex) when (ex.StatusCode is 401 or 403)
        {
            warnings.Add("Sem permissão para ler Soluções no ITSM — reaberturas não foram contadas.");
        }
        return map;
    }

    /// <summary>Vínculos entre tickets. Dup: "Duplica" (link 2), duplicado → original (o de id menor). Related: "Ligado a" (link 1), nos dois sentidos.</summary>
    private async Task<(Dictionary<int, int> Dup, Dictionary<int, List<int>> Related)> DuplicateLinksAsync(GlpiClient.Session session, ConcurrentBag<string> warnings, CancellationToken ct)
    {
        var map = new Dictionary<int, int>();
        var related = new Dictionary<int, List<int>>();
        try
        {
            for (var start = 0; start < 50000; start += 1000)
            {
                var page = await glpi.GetAsync(session, $"Ticket_Ticket?range={start}-{start + 999}", ct);
                if (page is not { ValueKind: JsonValueKind.Array } arr) break;
                var n = 0;
                foreach (var l in arr.EnumerateArray())
                {
                    n++;
                    if (Int(l, "tickets_id_1") is not { } a || Int(l, "tickets_id_2") is not { } b) continue;
                    var link = Int(l, "link");
                    if (link == LINK_DUPLICATE) map[Math.Max(a, b)] = Math.Min(a, b);
                    else if (link == LINK_RELATED)
                    {
                        (related.TryGetValue(a, out var la) ? la : related[a] = new()).Add(b);
                        (related.TryGetValue(b, out var lb) ? lb : related[b] = new()).Add(a);
                    }
                }
                if (n < 1000) break;
            }
        }
        catch (GlpiException ex) when (ex.StatusCode is 401 or 403)
        {
            warnings.Add("Sem permissão para ler vínculos entre tickets — só o texto da solução indica duplicidade.");
        }
        return (map, related);
    }

    private static List<KeyValuePair<string, string>> Query(string[] display, params (string Field, string Type, string Value)[] criteria)
    {
        var q = new List<KeyValuePair<string, string>>();
        for (var i = 0; i < criteria.Length; i++)
        {
            if (i > 0) q.Add(new($"criteria[{i}][link]", "AND"));
            q.Add(new($"criteria[{i}][field]", criteria[i].Field));
            q.Add(new($"criteria[{i}][searchtype]", criteria[i].Type));
            q.Add(new($"criteria[{i}][value]", criteria[i].Value));
        }
        for (var i = 0; i < display.Length; i++) q.Add(new($"forcedisplay[{i}]", display[i]));
        return q;
    }

    /// <summary>Campo entre [start, end) (datas locais do ITSM).</summary>
    private static List<KeyValuePair<string, string>> Range(string[] display, string field, DateTime start, DateTime end)
    {
        const string fmt = "yyyy-MM-dd HH:mm:ss";
        return Query(display, (field, "morethan", start.AddSeconds(-1).ToString(fmt, CultureInfo.InvariantCulture)),
            (field, "lessthan", end.ToString(fmt, CultureInfo.InvariantCulture)));
    }

    private static string Title(JsonElement r, int id)
    {
        var t = System.Net.WebUtility.HtmlDecode(Str(r, F_NAME) ?? "").Trim();
        return t.Length > 0 ? t : $"(sem título) #{id}";
    }

    /// <summary>Campos com vários valores (ex.: várias soluções) vêm como array.</summary>
    private static IEnumerable<string> Values(JsonElement r, string field)
    {
        if (!r.TryGetProperty(field, out var v)) return [];
        var items = v.ValueKind == JsonValueKind.Array ? v.EnumerateArray().ToList() : [v];
        return items.Select(GlpiClient.ReadString).Where(s => !string.IsNullOrWhiteSpace(s)).Select(s => s!.Trim());
    }
    private static string? Last(JsonElement r, string field) => BoardService.CleanDropdown(Values(r, field).LastOrDefault());
    private static string AllText(JsonElement r, string field) => string.Join(" \n ", Values(r, field));

    private static List<int> Ids(JsonElement r, string field)
    {
        if (!r.TryGetProperty(field, out var v)) return new();
        var items = v.ValueKind == JsonValueKind.Array ? v.EnumerateArray().ToList() : [v];
        return items.Select(GlpiClient.ReadInt).Where(i => i is > 0).Select(i => i!.Value).Distinct().ToList();
    }

    private static int? Int(JsonElement e, string p) => e.TryGetProperty(p, out var v) ? GlpiClient.ReadInt(v) : null;
    private static long? Long(JsonElement e, string p) => long.TryParse(Str(e, p), out var l) ? l : null;
    private static string? Str(JsonElement e, string p)
    {
        if (!e.TryGetProperty(p, out var v)) return null;
        var s = GlpiClient.ReadString(v);
        return string.IsNullOrWhiteSpace(s) ? null : s.Trim();
    }
}
