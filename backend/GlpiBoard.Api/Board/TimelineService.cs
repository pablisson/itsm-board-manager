using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Text.Json;
using GlpiBoard.Api.Config;
using GlpiBoard.Api.Glpi;

namespace GlpiBoard.Api.Board;

public sealed record StatusSegment(int Status, string Label, DateTimeOffset FromUtc, DateTimeOffset? ToUtc);

/// <summary>kind: status | followup | task | solution | assign | document | update</summary>
public sealed record TimelineEvent(DateTimeOffset AtUtc, string Kind, string Label, string? User, int? FromStatus = null, int? ToStatus = null);

public sealed record TimelineTicket
{
    public int Id { get; init; }
    public string Title { get; init; } = "";
    public string? Entity { get; init; }
    public int Status { get; init; }
    public string StatusLabel { get; init; } = "";
    public string Url { get; init; } = "";
    public DateTimeOffset? OpenedAtUtc { get; init; }
    /// <summary>Fim da barra: quando entrou em Solucionado/Fechado. null = ainda aberto (vai até agora).</summary>
    public DateTimeOffset? EndAtUtc { get; init; }
    public DateTimeOffset? LastUpdateUtc { get; init; }
    public List<StatusSegment> Segments { get; init; } = new();
    public List<TimelineEvent> Events { get; init; } = new();
}

public sealed record TimelineResponse(PersonRef? Technician, DateTimeOffset GeneratedAtUtc, long DurationMs, int DoneDays,
    List<TimelineTicket> Tickets, List<string> Warnings, string? Error = null);

/// <summary>
/// Linha do tempo (Gantt) dos tickets de um técnico, montada a partir do histórico (Ticket/{id}/Log) do GLPI.
///   - mudanças de status: id_search_option 12 (old_value → new_value)
///   - atualizações: acompanhamento (ITILFollowup), tarefa (TicketTask), solução (ITILSolution), documento, atribuição de técnico
/// O log de cada ticket fica em cache e só é relido quando a data de modificação do ticket muda.
/// </summary>
public sealed class TimelineService(GlpiClient glpi, BoardService board, BoardSettings settings, ILogger<TimelineService> log)
{
    private const string SO_STATUS = "12", SO_TECH = "5";
    private const int LINK_ADD = 17, LINK_ADD_RELATION = 15;

    private readonly ConcurrentDictionary<int, (DateTimeOffset? Updated, List<RawLog> Logs)> _logCache = new();

    private sealed record RawLog(DateTimeOffset At, string? SearchOption, string? ItemtypeLink, int LinkedAction, string? User, string? Old, string? New);

    public async Task<TimelineResponse> GetAsync(int techId, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var b = await board.GetAsync(false, ct);
        var snap = b.Snapshot;
        if (snap is null)
            return new(null, DateTimeOffset.UtcNow, 0, settings.DoneDays, new(), new(), b.LastError ?? "Board ainda não sincronizado.");

        var c = snap.Columns;
        var all = c.Unassigned.Concat(c.InProgress.SelectMany(l => l.Tickets)).Concat(c.Blocked).Concat(c.Completed).Concat(c.Cancelled)
            .DistinctBy(t => t.Id).ToList();
        var mine = all.Where(t => t.Technicians.Any(x => x.Id == techId)).ToList();
        var tech = mine.SelectMany(t => t.Technicians).FirstOrDefault(x => x.Id == techId);

        var warnings = new ConcurrentBag<string>();
        var result = new List<TimelineTicket>();
        if (mine.Count > 0)
        {
            await using var session = await glpi.OpenSessionAsync(ct);
            using var gate = new SemaphoreSlim(6);
            var built = await Task.WhenAll(mine.Select(async t =>
            {
                await gate.WaitAsync(ct);
                try { return Build(t, await LogsAsync(session, t, warnings, ct)); }
                finally { gate.Release(); }
            }));
            result = built.OrderBy(t => t.EndAtUtc is null ? 0 : 1).ThenBy(t => t.OpenedAtUtc).ToList();
        }

        return new(tech, DateTimeOffset.UtcNow, sw.ElapsedMilliseconds, settings.DoneDays, result, warnings.Distinct().ToList());
    }

    private async Task<List<RawLog>> LogsAsync(GlpiClient.Session s, BoardTicket t, ConcurrentBag<string> warnings, CancellationToken ct)
    {
        if (_logCache.TryGetValue(t.Id, out var cached) && cached.Updated == t.UpdatedAtUtc) return cached.Logs;
        try
        {
            var json = await glpi.GetAsync(s, $"Ticket/{t.Id}/Log?range=0-1999", ct);
            var logs = new List<RawLog>();
            if (json is { ValueKind: JsonValueKind.Array } arr)
                foreach (var e in arr.EnumerateArray())
                {
                    var at = BoardService.ToUtc(Str(e, "date_mod"), settings);
                    if (at is null) continue;
                    logs.Add(new RawLog(at.Value, Str(e, "id_search_option"), Str(e, "itemtype_link"),
                        Str(e, "linked_action") is { } la && int.TryParse(la, out var l) ? l : 0,
                        StripId(Clean(Str(e, "user_name"))), Clean(Str(e, "old_value")), Clean(Str(e, "new_value"))));
                }
            logs.Sort((a, b) => a.At.CompareTo(b.At));
            _logCache[t.Id] = (t.UpdatedAtUtc, logs);
            return logs;
        }
        catch (GlpiException ex) when (ex.StatusCode is 401 or 403)
        {
            warnings.Add("Sem permissão para ler o Histórico dos chamados no ITSM — exibindo só abertura e estado atual.");
            return new();
        }
    }

    private static TimelineTicket Build(BoardTicket t, List<RawLog> logs)
    {
        var events = new List<TimelineEvent>();
        var statusChanges = new List<(DateTimeOffset At, int From, int To, string? User)>();

        foreach (var g in logs)
        {
            var link = g.ItemtypeLink ?? "";
            if (g.SearchOption == SO_STATUS && link.Length == 0 && g.LinkedAction == 0)
            {
                if (int.TryParse(g.Old, out var from) && int.TryParse(g.New, out var to) && from != to)
                {
                    statusChanges.Add((g.At, from, to, g.User));
                    events.Add(new(g.At, "status", $"{Label(from)} → {Label(to)}", g.User, from, to));
                }
                continue;
            }
            var ev = (link, g.LinkedAction, g.SearchOption) switch
            {
                ("ITILFollowup", LINK_ADD, _) => ("followup", "Acompanhamento adicionado"),
                ("TicketTask", LINK_ADD, _) => ("task", "Tarefa adicionada"),
                ("ITILSolution", LINK_ADD, _) => ("solution", "Solução adicionada"),
                ("Document", LINK_ADD_RELATION, _) => ("document", $"Documento anexado{Suffix(g.New)}"),
                ("User", LINK_ADD_RELATION, SO_TECH) => ("assign", $"Técnico atribuído: {StripId(g.New)}"),
                ("Group", LINK_ADD_RELATION, "8") => ("assign", $"Grupo atribuído: {StripId(g.New)}"),
                _ => default((string, string)?),
            };
            if (ev is { } e) events.Add(new(g.At, e.Item1, e.Item2, g.User));
        }

        // Segmentos de status: abertura → mudanças → estado atual
        var opened = t.OpenedAtUtc ?? logs.FirstOrDefault()?.At ?? DateTimeOffset.UtcNow;
        var segments = new List<StatusSegment>();
        var cursor = opened;
        var current = statusChanges.Count > 0 ? statusChanges[0].From : t.Status;
        foreach (var (at, from, to, _) in statusChanges)
        {
            var when = at < cursor ? cursor : at;
            if (when > cursor) segments.Add(new(current, Label(current), cursor, when));
            cursor = when; current = to;
        }
        DateTimeOffset? end = null;
        if (t.Status is 5 or 6)
        {
            if (statusChanges.Count > 0) end = cursor; // entrou em Solucionado/Fechado: a barra termina aqui
            else
            {
                // sem histórico de status: um único trecho neutro da abertura até a solução
                end = t.SolvedAtUtc ?? t.ClosedAtUtc ?? opened;
                segments.Add(new(0, "Sem histórico de status", opened, end));
            }
        }
        else segments.Add(new(t.Status, Label(t.Status), cursor, null)); // aberto: vai até agora

        events.Sort((a, b) => a.AtUtc.CompareTo(b.AtUtc));
        var lastUpdate = events.Count > 0 ? events[^1].AtUtc : t.UpdatedAtUtc;

        return new TimelineTicket
        {
            Id = t.Id, Title = t.Title, Entity = t.Entity, Status = t.Status, StatusLabel = t.StatusLabel, Url = t.Url,
            OpenedAtUtc = opened, EndAtUtc = end, LastUpdateUtc = lastUpdate,
            Segments = segments, Events = events,
        };
    }

    private static string Label(int s) => BoardService.StatusLabels.GetValueOrDefault(s, $"Status {s}");
    private static string? StripId(string? v) => v is null ? null : System.Text.RegularExpressions.Regex.Replace(v, @"\s*\(\d+\)\s*$", "");
    private static string Suffix(string? v) => StripId(v) is { Length: > 0 } s ? $": {s}" : "";
    private static string? Clean(string? s) => string.IsNullOrWhiteSpace(s) ? null : WebUtility.HtmlDecode(s).Replace(' ', ' ').Trim();

    private static string? Str(JsonElement e, string prop) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(prop, out var v) ? GlpiClient.ReadString(v) : null;
}
