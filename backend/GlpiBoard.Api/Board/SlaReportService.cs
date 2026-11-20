using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using GlpiBoard.Api.Config;
using GlpiBoard.Api.Glpi;

namespace GlpiBoard.Api.Board;

/// <summary>Um ticket do período com os dados de SLA e de tempo (durações em segundos).</summary>
public sealed record SlaReportTicket
{
    public int Id { get; init; }
    public string Title { get; init; } = "";
    public int Status { get; init; }
    public string StatusLabel { get; init; } = "";
    public string? Entity { get; init; }
    public string Url { get; init; } = "";
    public List<int> TechIds { get; init; } = new();
    public DateTimeOffset? OpenedAtUtc { get; init; }
    public DateTimeOffset? TakenAtUtc { get; init; }
    public DateTimeOffset? SolvedAtUtc { get; init; }
    public DateTimeOffset? ClosedAtUtc { get; init; }
    public string? TtoName { get; init; }
    public string? TtrName { get; init; }
    public DateTimeOffset? TtoDueUtc { get; init; }
    public DateTimeOffset? TtrDueUtc { get; init; }
    /// <summary>Flags "excedido" calculadas pelo próprio ITSM (campos 159 e 82 da busca).</summary>
    public bool TtoLate { get; init; }
    public bool TtrLate { get; init; }
    /// <summary>Tempo até ser assumido (horário útil do calendário do SLA).</summary>
    public long? TakeDelaySec { get; init; }
    /// <summary>Tempo de solução (horário útil, já sem o tempo pendente).</summary>
    public long? SolveDelaySec { get; init; }
    /// <summary>Tempo em que o ticket ficou Pendente.</summary>
    public long? WaitingSec { get; init; }
    /// <summary>Soma da duração das tarefas lançadas.</summary>
    public long? ActionTimeSec { get; init; }
}

public sealed record SlaReport
{
    public DateTimeOffset GeneratedAtUtc { get; init; }
    public long DurationMs { get; init; }
    public string From { get; init; } = "";
    public string To { get; init; } = "";
    public List<PersonRef> Technicians { get; init; } = new();
    public List<SlaReportTicket> Tickets { get; init; } = new();
    public List<string> Warnings { get; init; } = new();
}

public sealed record SlaReportResponse(SlaReport? Report, string? Error, int? ThrottledSeconds = null);

/// <summary>
/// Relatórios de SLA por técnico: tickets ABERTOS no período (data de abertura, fuso do ITSM).
/// Técnico = usuário atribuído (campo 5 da busca). Usa a busca + getMultipleItems (sem chamadas por ticket).
/// </summary>
public sealed class SlaReportService(GlpiClient glpi, BoardService board, BoardSettings settings, ILogger<SlaReportService> log)
{
    public const int MaxMonths = 12;
    private const string F_ID = "2", F_NAME = "1", F_STATUS = "12", F_DATE = "15", F_SOLVEDATE = "17", F_CLOSEDATE = "16", F_ENTITY = "80", F_TECH = "5",
        F_TTO_DUE = "155", F_TTR_DUE = "18", F_TTO_SLA = "37", F_TTR_SLA = "30", F_TTR_LATE = "82", F_TTO_LATE = "159",
        F_TAKE = "150", F_SOLVE = "154", F_WAIT = "153", F_ACTION = "45";
    private static readonly string[] Display = [F_ID, F_NAME, F_STATUS, F_DATE, F_SOLVEDATE, F_CLOSEDATE, F_ENTITY, F_TECH,
        F_TTO_DUE, F_TTR_DUE, F_TTO_SLA, F_TTR_SLA, F_TTR_LATE, F_TTO_LATE, F_TAKE, F_SOLVE, F_WAIT, F_ACTION];

    private readonly SemaphoreSlim _lock = new(1, 1);
    private readonly Dictionary<string, SlaReport> _cache = new();
    private DateTimeOffset _lastAttempt = DateTimeOffset.MinValue;

    /// <summary>Tickets ABERTOS nos meses from..to.</summary>
    public Task<SlaReportResponse> GetAsync(DateOnly from, DateOnly to, bool force, CancellationToken ct) =>
        CachedAsync($"open_{from:yyyy-MM}_{to:yyyy-MM}", force, () => BuildOpenedAsync(from, to, ct), ct);

    public const int MaxSolvedDays = 366;

    /// <summary>
    /// Tickets SOLUCIONADOS/FECHADOS nos dias from..to (fuso do ITSM). Dia = data da solução; sem solução, a do fechamento.
    /// Ticket reaberto (status diferente de Solucionado/Fechado) não entra.
    /// </summary>
    public Task<SlaReportResponse> GetSolvedAsync(DateOnly from, DateOnly to, bool force, CancellationToken ct) =>
        CachedAsync($"solved_{from:yyyy-MM-dd}_{to:yyyy-MM-dd}", force, () => BuildSolvedAsync(from, to, ct), ct);

    private async Task<SlaReportResponse> CachedAsync(string key, bool force, Func<Task<SlaReport>> build, CancellationToken ct)
    {
        await _lock.WaitAsync(ct);
        try
        {
            var now = DateTimeOffset.UtcNow;
            _cache.TryGetValue(key, out var cached);
            var fresh = cached is not null && (now - cached.GeneratedAtUtc).TotalSeconds < settings.CacheSeconds;
            var throttled = force && (now - _lastAttempt).TotalSeconds < settings.RefreshMinIntervalSeconds;
            if (cached is not null && (fresh && !force || throttled))
                return new(cached, null, throttled ? settings.RefreshMinIntervalSeconds : null);

            _lastAttempt = now;
            try
            {
                var rep = await build();
                _cache[key] = rep;
                return new(rep, null);
            }
            catch (Exception ex) when (ex is GlpiException or HttpRequestException or TaskCanceledException or JsonException)
            {
                log.LogWarning("Relatório de SLA falhou: {Message}", ex.Message);
                return new(cached, ex is TaskCanceledException ? "Tempo esgotado ao consultar o ITSM." : ex.Message);
            }
        }
        finally { _lock.Release(); }
    }

    /// <summary>Critério "campo entre [start, end)" (datas locais do ITSM) + colunas do relatório.</summary>
    private static List<KeyValuePair<string, string>> Range(string field, DateTime start, DateTime end)
    {
        const string fmt = "yyyy-MM-dd HH:mm:ss";
        var q = new List<KeyValuePair<string, string>>
        {
            new("criteria[0][field]", field), new("criteria[0][searchtype]", "morethan"),
            new("criteria[0][value]", start.AddSeconds(-1).ToString(fmt, CultureInfo.InvariantCulture)),
            new("criteria[1][link]", "AND"),
            new("criteria[1][field]", field), new("criteria[1][searchtype]", "lessthan"),
            new("criteria[1][value]", end.ToString(fmt, CultureInfo.InvariantCulture)),
        };
        for (var i = 0; i < Display.Length; i++) q.Add(new($"forcedisplay[{i}]", Display[i]));
        return q;
    }

    private async Task<SlaReport> BuildOpenedAsync(DateOnly from, DateOnly to, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        await using var session = await glpi.OpenSessionAsync(ct);
        var rows = await glpi.SearchAllAsync(session, "Ticket",
            Range(F_DATE, from.ToDateTime(TimeOnly.MinValue), to.AddMonths(1).ToDateTime(TimeOnly.MinValue)), ct);
        var rep = await BuildAsync(session, rows, _ => true, ct);
        return rep with { DurationMs = sw.ElapsedMilliseconds, From = from.ToString("yyyy-MM"), To = to.ToString("yyyy-MM") };
    }

    private async Task<SlaReport> BuildSolvedAsync(DateOnly from, DateOnly to, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var start = from.ToDateTime(TimeOnly.MinValue);
        var end = to.AddDays(1).ToDateTime(TimeOnly.MinValue);
        await using var session = await glpi.OpenSessionAsync(ct);
        // duas buscas (solução / fechamento no período): fechado sem data de solução também entra
        var rows = (await glpi.SearchAllAsync(session, "Ticket", Range(F_SOLVEDATE, start, end), ct))
            .Concat(await glpi.SearchAllAsync(session, "Ticket", Range(F_CLOSEDATE, start, end), ct)).ToList();
        var rep = await BuildAsync(session, rows, t =>
        {
            if (t.Status is not (5 or 6)) return false;    // reaberto depois
            var endAt = t.SolvedAtUtc ?? t.ClosedAtUtc;
            if (endAt is null) return false;
            var day = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(endAt.Value, settings.GlpiTimeZone).DateTime);
            return day >= from && day <= to;                // solucionado antes e só fechado no período: fica de fora
        }, ct);
        return rep with { DurationMs = sw.ElapsedMilliseconds, From = from.ToString("yyyy-MM-dd"), To = to.ToString("yyyy-MM-dd") };
    }

    private async Task<SlaReport> BuildAsync(GlpiClient.Session session, IEnumerable<JsonElement> rows, Func<SlaReportTicket, bool> keep, CancellationToken ct)
    {
        var warnings = new ConcurrentBag<string>();
        var parsed = new List<(JsonElement Row, int Id, List<int> Techs)>();
        var seen = new HashSet<int>();
        foreach (var r in rows)
        {
            if (Int(r, F_ID) is not { } id || !seen.Add(id)) continue;
            parsed.Add((r, id, TechIds(r)));
        }

        var taken = await board.TakeIntoAccountDatesAsync(session, parsed.Where(p => Long(p.Row, F_TAKE) is > 0).Select(p => p.Id).ToList(), warnings, ct);

        var names = new ConcurrentDictionary<int, string>();
        using var gate = new SemaphoreSlim(6);
        await Task.WhenAll(parsed.SelectMany(p => p.Techs).Distinct().Select(async uid =>
        {
            await gate.WaitAsync(ct);
            try { names[uid] = await board.ResolveUserAsync(session, uid, warnings, ct); }
            finally { gate.Release(); }
        }));

        var tickets = parsed.Select(p =>
        {
            var r = p.Row;
            var status = Int(r, F_STATUS) ?? 0;
            return new SlaReportTicket
            {
                Id = p.Id,
                Title = System.Net.WebUtility.HtmlDecode(Str(r, F_NAME) ?? $"(sem título) #{p.Id}"),
                Status = status,
                StatusLabel = BoardService.StatusLabels.GetValueOrDefault(status, $"Status {status}"),
                Entity = BoardService.CleanDropdown(Str(r, F_ENTITY)),
                Url = $"{settings.GlpiWebBase}/front/ticket.form.php?id={p.Id}",
                TechIds = p.Techs,
                OpenedAtUtc = BoardService.ToUtc(Str(r, F_DATE), settings),
                TakenAtUtc = taken.TryGetValue(p.Id, out var tk) ? BoardService.ToUtc(tk, settings) : null,
                SolvedAtUtc = BoardService.ToUtc(Str(r, F_SOLVEDATE), settings),
                ClosedAtUtc = BoardService.ToUtc(Str(r, F_CLOSEDATE), settings),
                TtoName = BoardService.CleanDropdown(Str(r, F_TTO_SLA)),
                TtrName = BoardService.CleanDropdown(Str(r, F_TTR_SLA)),
                TtoDueUtc = BoardService.ToUtc(Str(r, F_TTO_DUE), settings),
                TtrDueUtc = BoardService.ToUtc(Str(r, F_TTR_DUE), settings),
                TtoLate = Int(r, F_TTO_LATE) == 1,
                TtrLate = Int(r, F_TTR_LATE) == 1,
                TakeDelaySec = Long(r, F_TAKE),
                SolveDelaySec = Long(r, F_SOLVE),
                WaitingSec = Long(r, F_WAIT),
                ActionTimeSec = Long(r, F_ACTION),
            };
        }).Where(keep).OrderBy(t => t.OpenedAtUtc).ToList();

        return new SlaReport
        {
            GeneratedAtUtc = DateTimeOffset.UtcNow,
            Technicians = names.Select(kv => new PersonRef(kv.Key, kv.Value)).OrderBy(x => x.Name).ToList(),
            Tickets = tickets,
            Warnings = warnings.Distinct().OrderBy(w => w).ToList(),
        };
    }

    /// <summary>O campo 5 vem como "251" ou ["251","572"].</summary>
    private static List<int> TechIds(JsonElement r)
    {
        if (!r.TryGetProperty(F_TECH, out var v)) return new();
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
