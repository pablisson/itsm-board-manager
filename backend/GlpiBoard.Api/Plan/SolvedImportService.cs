using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using GlpiBoard.Api.Board;
using GlpiBoard.Api.Config;
using GlpiBoard.Api.Glpi;

namespace GlpiBoard.Api.Plan;

public sealed record SolvedItem(DateOnly Day, int TechId, string TechName, int TicketId, string Title, string Url, int Status, string StatusLabel, string? Entity, bool Added);
public sealed record SolvedTicketRef(int TicketId, string Title, string Url, DateOnly Day);
public sealed record SolvedImportResult(DateOnly From, DateOnly To, int Tickets, int Added, int Existing, List<SolvedItem> Items, List<SolvedTicketRef> WithoutTechnician, List<string> Warnings);

/// <summary>
/// Busca no ITSM os tickets solucionados (ou fechados sem data de solução) no período e
/// coloca cada um no planejamento de cada técnico atribuído, no dia da solução.
/// </summary>
public sealed class SolvedImportService(GlpiClient glpi, BoardService board, PlanStore store, BoardSettings settings)
{
    public const int MaxDays = 31;
    private const string F_ID = "2", F_NAME = "1", F_STATUS = "12", F_CLOSEDATE = "16", F_SOLVEDATE = "17", F_ENTITY = "80", F_TECH = "5";
    private static readonly string[] Display = [F_ID, F_NAME, F_STATUS, F_CLOSEDATE, F_SOLVEDATE, F_ENTITY, F_TECH];
    private readonly SemaphoreSlim _lock = new(1, 1);

    public async Task<SolvedImportResult> ImportAsync(DateOnly from, DateOnly to, CancellationToken ct)
    {
        await _lock.WaitAsync(ct);
        try
        {
            var warnings = new ConcurrentBag<string>();
            await using var session = await glpi.OpenSessionAsync(ct);
            // datas do GLPI estão no fuso do ITSM: o dia é a parte AAAA-MM-DD do valor
            var rows = (await glpi.SearchAllAsync(session, "Ticket", Query(F_SOLVEDATE, from, to), ct))
                .Concat(await glpi.SearchAllAsync(session, "Ticket", Query(F_CLOSEDATE, from, to), ct));

            var tickets = new Dictionary<int, (string Title, int Status, string? Entity, DateOnly Day, List<int> Techs)>();
            foreach (var r in rows)
            {
                if (Int(r, F_ID) is not { } id || tickets.ContainsKey(id)) continue;
                var status = Int(r, F_STATUS) ?? 0;
                if (status is not (5 or 6)) continue; // reaberto depois de solucionar
                // dia da solução; sem solução registrada, o dia do fechamento
                var day = Day(Str(r, F_SOLVEDATE)) ?? Day(Str(r, F_CLOSEDATE));
                if (day is not { } d || d < from || d > to) continue; // fechado no período mas solucionado antes
                tickets[id] = (System.Net.WebUtility.HtmlDecode(Str(r, F_NAME) ?? $"(sem título) #{id}"), status, BoardService.CleanDropdown(Str(r, F_ENTITY)), d, TechIds(r));
            }

            var names = new ConcurrentDictionary<int, string>();
            using var gate = new SemaphoreSlim(6);
            await Task.WhenAll(tickets.Values.SelectMany(t => t.Techs).Distinct().Select(async uid =>
            {
                await gate.WaitAsync(ct);
                try { names[uid] = await board.ResolveUserAsync(session, uid, warnings, ct); }
                finally { gate.Release(); }
            }));

            var url = (int id) => $"{settings.GlpiWebBase}/front/ticket.form.php?id={id}";
            var creates = tickets.SelectMany(kv => kv.Value.Techs.Select(tech => new PlanCreate(tech, names.GetValueOrDefault(tech), kv.Key, kv.Value.Title, kv.Value.Day)))
                .OrderBy(c => c.Day).ThenBy(c => c.TicketId).ToList();
            var added = await store.ImportAsync(creates, ct);

            var items = creates.Select(c =>
            {
                var t = tickets[c.TicketId];
                return new SolvedItem(c.Day, c.TechId, c.TechName ?? $"Técnico #{c.TechId}", c.TicketId, t.Title, url(c.TicketId), t.Status,
                    BoardService.StatusLabels.GetValueOrDefault(t.Status, $"Status {t.Status}"), t.Entity, added.Contains((c.TechId, c.TicketId, c.Day)));
            }).ToList();
            var orphan = tickets.Where(kv => kv.Value.Techs.Count == 0)
                .Select(kv => new SolvedTicketRef(kv.Key, kv.Value.Title, url(kv.Key), kv.Value.Day)).OrderBy(x => x.Day).ThenBy(x => x.TicketId).ToList();
            return new(from, to, tickets.Count, added.Count, items.Count - added.Count, items, orphan, warnings.Distinct().OrderBy(w => w).ToList());
        }
        finally { _lock.Release(); }
    }

    private static List<KeyValuePair<string, string>> Query(string field, DateOnly from, DateOnly to)
    {
        const string fmt = "yyyy-MM-dd HH:mm:ss";
        var q = new List<KeyValuePair<string, string>>
        {
            new("criteria[0][field]", field), new("criteria[0][searchtype]", "morethan"),
            new("criteria[0][value]", from.ToDateTime(TimeOnly.MinValue).AddSeconds(-1).ToString(fmt, CultureInfo.InvariantCulture)),
            new("criteria[1][link]", "AND"),
            new("criteria[1][field]", field), new("criteria[1][searchtype]", "lessthan"),
            new("criteria[1][value]", to.AddDays(1).ToDateTime(TimeOnly.MinValue).ToString(fmt, CultureInfo.InvariantCulture)),
        };
        for (var i = 0; i < Display.Length; i++) q.Add(new($"forcedisplay[{i}]", Display[i]));
        return q;
    }

    private static DateOnly? Day(string? s) =>
        s is { Length: >= 10 } && DateOnly.TryParseExact(s[..10], "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) ? d : null;

    private static List<int> TechIds(JsonElement r)
    {
        if (!r.TryGetProperty(F_TECH, out var v)) return new();
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

public sealed record SolvedImportRequest(DateOnly From, DateOnly To);
