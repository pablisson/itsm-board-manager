using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using GlpiBoard.Api.Config;
using GlpiBoard.Api.Glpi;

namespace GlpiBoard.Api.Board;

public sealed record MonthlyEntityRow(string Entity, int[] Counts, int Total);

public sealed record MonthlyReport
{
    public DateTimeOffset GeneratedAtUtc { get; init; }
    public long DurationMs { get; init; }
    /// <summary>Meses no formato yyyy-MM, do mais antigo ao mais recente (fuso do ITSM).</summary>
    public List<string> Months { get; init; } = new();
    public List<MonthlyEntityRow> Rows { get; init; } = new();
    public int[] MonthTotals { get; init; } = [];
    public int GrandTotal { get; init; }
}

public sealed record MonthlyReportResponse(MonthlyReport? Report, string? Error, int? ThrottledSeconds = null);

/// <summary>
/// Relatório: quantidade de tickets ABERTOS por entidade e mês (pela data de abertura, campo "date").
/// Usa só o motor de busca (sem chamadas por ticket), então é barato mesmo para vários meses.
/// Tickets na lixeira não entram (padrão da busca do GLPI).
/// </summary>
public sealed class ReportService(GlpiClient glpi, BoardSettings settings, ILogger<ReportService> log)
{
    public const int MaxMonths = 24;
    private const string F_ID = "2", F_DATE = "15", F_ENTITY = "80";

    private readonly SemaphoreSlim _lock = new(1, 1);
    private readonly Dictionary<int, MonthlyReport> _cache = new();
    private DateTimeOffset _lastAttempt = DateTimeOffset.MinValue;

    public async Task<MonthlyReportResponse> GetMonthlyAsync(int months, bool force, CancellationToken ct)
    {
        months = Math.Clamp(months, 1, MaxMonths);
        await _lock.WaitAsync(ct);
        try
        {
            var now = DateTimeOffset.UtcNow;
            _cache.TryGetValue(months, out var cached);
            var fresh = cached is not null && (now - cached.GeneratedAtUtc).TotalSeconds < settings.CacheSeconds;
            var throttled = (now - _lastAttempt).TotalSeconds < settings.RefreshMinIntervalSeconds;

            if (cached is not null && (fresh && !force || throttled))
                return new(cached, null, force && throttled ? settings.RefreshMinIntervalSeconds : null);

            _lastAttempt = now;
            try
            {
                var report = await BuildAsync(months, ct);
                _cache[months] = report;
                return new(report, null);
            }
            catch (Exception ex) when (ex is GlpiException or HttpRequestException or TaskCanceledException or JsonException)
            {
                log.LogWarning("Relatório mensal falhou: {Message}", ex.Message);
                var msg = ex is TaskCanceledException ? "Tempo esgotado ao consultar o ITSM." : ex.Message;
                return new(cached, msg);
            }
        }
        finally { _lock.Release(); }
    }

    private async Task<MonthlyReport> BuildAsync(int months, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var nowLocal = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, settings.GlpiTimeZone);
        var firstMonth = new DateTime(nowLocal.Year, nowLocal.Month, 1).AddMonths(-(months - 1));
        var monthKeys = Enumerable.Range(0, months).Select(i => firstMonth.AddMonths(i).ToString("yyyy-MM", CultureInfo.InvariantCulture)).ToList();
        var index = monthKeys.Select((m, i) => (m, i)).ToDictionary(x => x.m, x => x.i);

        var query = new List<KeyValuePair<string, string>>
        {
            new("criteria[0][field]", F_DATE),
            new("criteria[0][searchtype]", "morethan"),
            // "morethan" é estrito: 1 segundo antes do início do primeiro mês
            new("criteria[0][value]", firstMonth.AddSeconds(-1).ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture)),
            new("forcedisplay[0]", F_ID),
            new("forcedisplay[1]", F_DATE),
            new("forcedisplay[2]", F_ENTITY),
        };

        await using var session = await glpi.OpenSessionAsync(ct);
        var rows = await glpi.SearchAllAsync(session, "Ticket", query, ct);

        var byEntity = new Dictionary<string, int[]>();
        var seen = new HashSet<int>();
        foreach (var r in rows)
        {
            if (!r.TryGetProperty(F_ID, out var idEl) || GlpiClient.ReadInt(idEl) is not { } id || !seen.Add(id)) continue;
            var date = r.TryGetProperty(F_DATE, out var d) ? GlpiClient.ReadString(d) : null;
            // datas do GLPI já estão no fuso local do servidor: o mês é o prefixo yyyy-MM
            if (date is null || date.Length < 7 || !index.TryGetValue(date[..7], out var mi)) continue;
            var entity = Clean(r.TryGetProperty(F_ENTITY, out var e) ? GlpiClient.ReadString(e) : null) ?? "(sem entidade)";
            if (!byEntity.TryGetValue(entity, out var counts)) byEntity[entity] = counts = new int[months];
            counts[mi]++;
        }

        var list = byEntity.Select(kv => new MonthlyEntityRow(kv.Key, kv.Value, kv.Value.Sum()))
            .OrderByDescending(x => x.Total).ThenBy(x => x.Entity).ToList();
        var totals = Enumerable.Range(0, months).Select(i => list.Sum(x => x.Counts[i])).ToArray();

        return new MonthlyReport
        {
            GeneratedAtUtc = DateTimeOffset.UtcNow,
            DurationMs = sw.ElapsedMilliseconds,
            Months = monthKeys,
            Rows = list,
            MonthTotals = totals,
            GrandTotal = totals.Sum(),
        };
    }

    private static string? Clean(string? s) =>
        string.IsNullOrWhiteSpace(s) ? null : System.Net.WebUtility.HtmlDecode(s).Replace(' ', ' ').Trim();
}
