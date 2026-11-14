using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using GlpiBoard.Api.Config;
using GlpiBoard.Api.Glpi;

namespace GlpiBoard.Api.Board;

/// <summary>
/// Monta o snapshot do board a partir do GLPI e mantém cache em memória.
///
/// Mapeamento (GLPI 9.5/10.x):
///   status 1 Novo | 2 Em atendimento (atribuído) | 3 Em atendimento (planejado) | 4 Pendente | 5 Solucionado | 6 Fechado
///   Ticket_User.type 1 Requerente | 2 Técnico atribuído | 3 Observador
///
/// Regras das colunas:
///   Sem atribuição : status 1–3 e NENHUM técnico (usuário) atribuído (mesmo que haja grupo atribuído)
///   Em andamento   : status 1–3 com ≥1 técnico atribuído, agrupado por técnico
///   Bloqueados     : status 4 (Pendente)
///   Completos      : status 5/6 solucionados nos últimos BOARD_DONE_DAYS dias, exceto cancelados
///   Cancelados     : status 5/6 cujo tipo de solução está em BOARD_CANCELLED_SOLUTIONTYPE_IDS
/// </summary>
public sealed class BoardService(GlpiClient glpi, BoardSettings settings, ILogger<BoardService> log)
{
    private const int TYPE_ASSIGNED = 2;
    private const int GROUP_TYPE_ASSIGNED = 2;
    private const int SOLUTION_REFUSED = 4;

    internal static readonly Dictionary<int, string> StatusLabels = new()
    {
        [1] = "Novo", [2] = "Em atendimento (atribuído)", [3] = "Em atendimento (planejado)",
        [4] = "Pendente", [5] = "Solucionado", [6] = "Fechado",
    };
    private static readonly Dictionary<int, string> PriorityLabels = new()
    {
        [1] = "Muito baixa", [2] = "Baixa", [3] = "Média", [4] = "Alta", [5] = "Muito alta", [6] = "Urgente",
    };

    // IDs de campos do motor de busca do GLPI (Ticket)
    private const string F_ID = "2", F_NAME = "1", F_STATUS = "12", F_DATE = "15", F_DATEMOD = "19",
        F_PRIORITY = "3", F_CATEGORY = "7", F_ENTITY = "80", F_SOLVEDATE = "17", F_CLOSEDATE = "16",
        F_TTO_DUE = "155", F_TTR_DUE = "18", F_TTO_SLA = "37", F_TTR_SLA = "30", F_TTO_DELAY = "150";
    private static readonly string[] DisplayFields = [F_ID, F_NAME, F_STATUS, F_DATE, F_DATEMOD, F_PRIORITY, F_CATEGORY, F_ENTITY, F_SOLVEDATE, F_CLOSEDATE,
        F_TTO_DUE, F_TTR_DUE, F_TTO_SLA, F_TTR_SLA, F_TTO_DELAY];

    private readonly SemaphoreSlim _syncLock = new(1, 1);
    private BoardSnapshot? _snapshot;
    private string? _lastError;
    private DateTimeOffset? _lastErrorAt;
    private DateTimeOffset _lastAttempt = DateTimeOffset.MinValue;

    public DateTimeOffset LastAttemptUtc => _lastAttempt;

    public async Task<BoardResponse> GetAsync(bool force, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var fresh = _snapshot is not null && (now - _snapshot.SyncedAtUtc).TotalSeconds < settings.CacheSeconds;
        var throttled = (now - _lastAttempt).TotalSeconds < settings.RefreshMinIntervalSeconds;

        var shouldSync = (force || !fresh) && !throttled;
        if (shouldSync && !force && _snapshot is not null)
        {
            // Cache expirado, mas há snapshot: responde na hora e atualiza em segundo plano
            // (a leitura completa no GLPI leva dezenas de segundos).
            _ = Task.Run(() => SyncAsync(waitForLock: false, CancellationToken.None));
        }
        else if (shouldSync)
        {
            // sem CancellationToken da requisição: se o navegador desistir, a leitura termina e fica em cache
            await SyncAsync(waitForLock: true, CancellationToken.None);
        }

        var stale = _snapshot is null || (DateTimeOffset.UtcNow - _snapshot.SyncedAtUtc).TotalSeconds >= settings.CacheSeconds || _lastError is not null;
        return new BoardResponse(_snapshot, _lastError, _lastErrorAt, stale, force && throttled ? settings.RefreshMinIntervalSeconds : null);
    }

    private async Task SyncAsync(bool waitForLock, CancellationToken ct)
    {
        if (waitForLock) await _syncLock.WaitAsync(ct);
        else if (!await _syncLock.WaitAsync(0, ct)) return; // já há uma sincronização em andamento
        try
        {
            // outra requisição pode ter sincronizado enquanto aguardávamos
            if ((DateTimeOffset.UtcNow - _lastAttempt).TotalSeconds < settings.RefreshMinIntervalSeconds) return;
            _lastAttempt = DateTimeOffset.UtcNow;
            try
            {
                _snapshot = await BuildSnapshotAsync(ct);
                _lastError = null; _lastErrorAt = null;
            }
            catch (Exception ex) when (ex is GlpiException or HttpRequestException or TaskCanceledException or JsonException)
            {
                log.LogWarning("Sincronização com GLPI falhou: {Message}", ex.Message);
                _lastError = ex is TaskCanceledException ? "Tempo esgotado ao consultar o ITSM." : ex.Message;
                _lastErrorAt = DateTimeOffset.UtcNow;
            }
        }
        finally { _syncLock.Release(); }
    }

    private async Task<BoardSnapshot> BuildSnapshotAsync(CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var warnings = new ConcurrentBag<string>();
        await using var session = await glpi.OpenSessionAsync(ct);

        // 1) Tickets abertos (notold = status 1..4)
        var openQuery = Criteria(("12", "equals", "notold", null));
        var openRows = await glpi.SearchAllAsync(session, "Ticket", openQuery, ct);

        // 2) Tickets solucionados/fechados recentes (old = 5,6) com data de solução no período
        var sinceLocal = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow.AddDays(-settings.DoneDays), settings.GlpiTimeZone);
        var doneQuery = Criteria(("12", "equals", "old", null), (F_SOLVEDATE, "morethan", sinceLocal.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture), "AND"));
        var doneRows = await glpi.SearchAllAsync(session, "Ticket", doneQuery, ct);

        var rows = openRows.Concat(doneRows)
            .Select(ParseRow).Where(r => r is not null).Select(r => r!)
            .GroupBy(r => r.Id).Select(g => g.First()).ToList();

        // 2b) Data em que o chamado foi assumido (takeintoaccountdate não existe na busca) — em lotes
        var ownedAt = await TakeIntoAccountDatesAsync(session, rows.Where(r => r.TtoDelaySeconds is > 0).Select(r => r.Id).ToList(), warnings, ct);
        rows = rows.Select(r => ownedAt.TryGetValue(r.Id, out var d) ? r with { TakenIntoAccountAt = d } : r).ToList();

        // 3) Atores (técnicos/grupos) e soluções — chamadas em paralelo com limite
        var userCache = new ConcurrentDictionary<int, Task<string>>();
        var solutionTypeCache = new ConcurrentDictionary<int, Task<string?>>();
        using var gate = new SemaphoreSlim(6);
        var cancelConfigured = settings.CancelledSolutionTypeIds.Count > 0;

        var tickets = await Task.WhenAll(rows.Select(async r =>
        {
            await gate.WaitAsync(ct);
            try
            {
                var techs = new List<PersonRef>();
                var tu = await glpi.GetAsync(session, $"Ticket/{r.Id}/Ticket_User", ct);
                foreach (var a in Items(tu))
                {
                    if (Int(a, "type") != TYPE_ASSIGNED) continue; // ignora requerente(1) e observador(3)
                    var uid = Int(a, "users_id") ?? 0;
                    if (uid <= 0) continue; // atribuição por e-mail alternativo, sem usuário
                    var name = await userCache.GetOrAdd(uid, id => ResolveUserAsync(session, id, warnings, ct));
                    techs.Add(new PersonRef(uid, name));
                }

                var groups = new List<string>();
                var gt = await glpi.GetAsync(session, $"Ticket/{r.Id}/Group_Ticket?expand_dropdowns=true", ct);
                foreach (var g in Items(gt))
                    if (Int(g, "type") == GROUP_TYPE_ASSIGNED && Str(g, "groups_id") is { } gname) groups.Add(gname);

                int? solTypeId = null; string? solType = null;
                if (r.Status is 5 or 6 && cancelConfigured)
                {
                    var sols = await glpi.GetAsync(session, $"Ticket/{r.Id}/ITILSolution", ct);
                    var latest = Items(sols)
                        .Where(sx => Int(sx, "status") != SOLUTION_REFUSED)
                        .OrderByDescending(sx => Str(sx, "date_creation") ?? "")
                        .FirstOrDefault();
                    if (latest.ValueKind == JsonValueKind.Object)
                    {
                        solTypeId = Int(latest, "solutiontypes_id");
                        if (solTypeId is > 0)
                            solType = await solutionTypeCache.GetOrAdd(solTypeId.Value, id => ResolveSolutionTypeAsync(session, id, ct));
                    }
                }

                var flags = new List<string>();
                if (r.Status == 1 && techs.Count > 0) flags.Add("Status 'Novo' com técnico atribuído");
                if (r.Status is 2 or 3 && techs.Count == 0) flags.Add(groups.Count > 0 ? "Atribuído só a grupo" : "Em atendimento sem técnico");
                if (r.Status == 4 && techs.Count == 0) flags.Add("Pendente sem técnico");
                if (r.OpenedAt is null) flags.Add("Data de abertura ausente");

                return r.ToTicket(settings, techs, groups, solTypeId, solType, flags);
            }
            finally { gate.Release(); }
        }));

        // 4) Classificação
        var cols = new BoardColumns();
        var lanes = new Dictionary<int, TechnicianLane>();
        foreach (var t in tickets.OrderBy(t => t.OpenedAtUtc ?? DateTimeOffset.MaxValue))
        {
            switch (t.Status)
            {
                case 1 or 2 or 3 when t.Technicians.Count == 0:
                    cols.Unassigned.Add(t); break;
                case 1 or 2 or 3:
                    foreach (var tech in t.Technicians)
                    {
                        if (!lanes.TryGetValue(tech.Id, out var lane)) lanes[tech.Id] = lane = new TechnicianLane(tech.Id, tech.Name, new());
                        lane.Tickets.Add(t);
                    }
                    break;
                case 4:
                    cols.Blocked.Add(t); break;
                case 5 or 6 when t.SolutionTypeId is { } st && settings.CancelledSolutionTypeIds.Contains(st):
                    cols.Cancelled.Add(t); break;
                case 5 or 6:
                    cols.Completed.Add(t); break;
                default:
                    warnings.Add($"Ticket #{t.Id} com status desconhecido ({t.Status}) — não exibido.");
                    break;
            }
        }
        cols = cols with
        {
            InProgress = lanes.Values.OrderByDescending(l => l.Tickets.Count).ThenBy(l => l.Name).ToList(),
            Completed = cols.Completed.OrderByDescending(t => t.SolvedAtUtc ?? t.ClosedAtUtc).ToList(),
            Cancelled = cols.Cancelled.OrderByDescending(t => t.SolvedAtUtc ?? t.ClosedAtUtc).ToList(),
        };

        if (!cancelConfigured)
            warnings.Add("Coluna 'Cancelados' sem regra: o ITSM não tem status nativo de cancelamento. Defina BOARD_CANCELLED_SOLUTIONTYPE_IDS com o(s) ID(s) do Tipo de solução usado para cancelar.");

        var inProgressUnique = cols.InProgress.SelectMany(l => l.Tickets).Select(t => t.Id).Distinct().Count();
        return new BoardSnapshot
        {
            SyncedAtUtc = DateTimeOffset.UtcNow,
            DurationMs = sw.ElapsedMilliseconds,
            GlpiHost = Uri.TryCreate(settings.GlpiUrl, UriKind.Absolute, out var u) ? u.Host : "",
            DoneDays = settings.DoneDays,
            CancelledConfigured = cancelConfigured,
            AgeWarnHours = settings.AgeWarnHours,
            AgeCriticalHours = settings.AgeCriticalHours,
            Columns = cols,
            Totals = new()
            {
                ["unassigned"] = cols.Unassigned.Count,
                ["inProgress"] = inProgressUnique,
                ["blocked"] = cols.Blocked.Count,
                ["completed"] = cols.Completed.Count,
                ["cancelled"] = cols.Cancelled.Count,
            },
            Warnings = warnings.Distinct().OrderBy(w => w).ToList(),
        };
    }

    internal async Task<string> ResolveUserAsync(GlpiClient.Session s, int id, ConcurrentBag<string> warnings, CancellationToken ct)
    {
        try
        {
            var u = await glpi.GetAsync(s, $"User/{id}", ct);
            if (u is { ValueKind: JsonValueKind.Object } e)
            {
                var full = $"{Str(e, "firstname")} {Str(e, "realname")}".Trim();
                return full.Length > 0 ? full : Str(e, "name") ?? $"Usuário #{id}";
            }
        }
        catch (GlpiException ex) when (ex.StatusCode is 401 or 403)
        {
            warnings.Add("Sem permissão para ler Usuários no ITSM — técnicos exibidos pelo ID. Conceda leitura de Usuários ao perfil da API.");
        }
        return $"Usuário #{id}";
    }

    internal async Task<Dictionary<int, string>> TakeIntoAccountDatesAsync(GlpiClient.Session s, List<int> ids, ConcurrentBag<string> warnings, CancellationToken ct)
    {
        var result = new ConcurrentDictionary<int, string>();
        using var gate = new SemaphoreSlim(4);
        await Task.WhenAll(ids.Chunk(50).Select(async chunk =>
        {
            await gate.WaitAsync(ct);
            try
            {
                var q = string.Join('&', chunk.Select((id, i) => $"items[{i}][itemtype]=Ticket&items[{i}][items_id]={id}"));
                var json = await glpi.GetAsync(s, $"getMultipleItems?{q}", ct);
                foreach (var e in Items(json))
                    if (Int(e, "id") is { } id && Str(e, "takeintoaccountdate") is { } d) result[id] = d;
            }
            catch (GlpiException ex)
            {
                log.LogWarning("Falha ao ler data de atribuição dos chamados: {Status}", ex.StatusCode);
                warnings.Add("Não foi possível ler a data em que os chamados foram assumidos — SLA de atendimento dos já assumidos pode aparecer como “no prazo”.");
            }
            finally { gate.Release(); }
        }));
        return new(result);
    }

    private async Task<string?> ResolveSolutionTypeAsync(GlpiClient.Session s, int id, CancellationToken ct)
    {
        try
        {
            var e = await glpi.GetAsync(s, $"SolutionType/{id}", ct);
            return e is { ValueKind: JsonValueKind.Object } o ? Str(o, "name") : null;
        }
        catch (GlpiException) { return null; }
    }

    // ---------- helpers ----------

    private static List<KeyValuePair<string, string>> Criteria(params (string field, string type, string value, string? link)[] c)
    {
        var q = new List<KeyValuePair<string, string>>();
        for (var i = 0; i < c.Length; i++)
        {
            if (c[i].link is { } l) q.Add(new($"criteria[{i}][link]", l));
            q.Add(new($"criteria[{i}][field]", c[i].field));
            q.Add(new($"criteria[{i}][searchtype]", c[i].type));
            q.Add(new($"criteria[{i}][value]", c[i].value));
        }
        for (var i = 0; i < DisplayFields.Length; i++) q.Add(new($"forcedisplay[{i}]", DisplayFields[i]));
        return q;
    }

    private static IEnumerable<JsonElement> Items(JsonElement? e) =>
        e is { ValueKind: JsonValueKind.Array } a ? a.EnumerateArray() : Enumerable.Empty<JsonElement>();

    private static int? Int(JsonElement e, string prop) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(prop, out var v) ? GlpiClient.ReadInt(v) : null;

    private static string? Str(JsonElement e, string prop)
    {
        if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(prop, out var v)) return null;
        var s = GlpiClient.ReadString(v);
        return string.IsNullOrWhiteSpace(s) ? null : s.Trim();
    }

    private sealed record Row(int Id, string Title, int Status, int? Priority, string? Category, string? Entity,
        string? OpenedAt, string? UpdatedAt, string? SolvedAt, string? ClosedAt,
        string? TtoSla, string? TtrSla, string? TtoDue, string? TtrDue, long? TtoDelaySeconds, string? TakenIntoAccountAt = null)
    {
        private BoardSla? Sla(BoardSettings st)
        {
            var tto = ToUtc(TtoDue, st); var ttr = ToUtc(TtrDue, st);
            if (tto is null && ttr is null && TtoSla is null && TtrSla is null) return null;
            // takeintoaccount_delay_stat > 0 = já assumido; a data exata vem de takeintoaccountdate (mesma regra do "excedido" do ITSM).
            // Se a data não pôde ser lida, considera assumido sem atraso conhecido (no prazo).
            DateTimeOffset? owned = TtoDelaySeconds is > 0 ? ToUtc(TakenIntoAccountAt, st) ?? (tto is { } d && ToUtc(OpenedAt, st) is { } o && o < d ? o : tto) : null;
            return new BoardSla(TtoSla, TtrSla, tto, ttr, owned);
        }

        public BoardTicket ToTicket(BoardSettings st, List<PersonRef> techs, List<string> groups, int? solTypeId, string? solType, List<string> flags) => new()
        {
            Id = Id,
            Title = System.Net.WebUtility.HtmlDecode(Title),
            Status = Status,
            StatusLabel = StatusLabels.GetValueOrDefault(Status, $"Status {Status}"),
            Priority = Priority,
            PriorityLabel = Priority is { } p ? PriorityLabels.GetValueOrDefault(p) : null,
            Category = Category, Entity = Entity,
            OpenedAtUtc = ToUtc(OpenedAt, st), UpdatedAtUtc = ToUtc(UpdatedAt, st),
            SolvedAtUtc = ToUtc(SolvedAt, st), ClosedAtUtc = ToUtc(ClosedAt, st),
            Technicians = techs.DistinctBy(x => x.Id).OrderBy(x => x.Name).ToList(),
            AssignedGroups = groups.Distinct().ToList(),
            SolutionTypeId = solTypeId, SolutionType = solType,
            Url = $"{st.GlpiWebBase}/front/ticket.form.php?id={Id}",
            Flags = flags,
            Sla = Sla(st),
        };
    }

    private static Row? ParseRow(JsonElement e)
    {
        var id = Int(e, F_ID);
        var status = Int(e, F_STATUS);
        if (id is null || status is null) return null;
        return new Row(id.Value, Str(e, F_NAME) ?? $"(sem título) #{id}", status.Value, Int(e, F_PRIORITY),
            CleanDropdown(Str(e, F_CATEGORY)), CleanDropdown(Str(e, F_ENTITY)),
            Str(e, F_DATE), Str(e, F_DATEMOD), Str(e, F_SOLVEDATE), Str(e, F_CLOSEDATE),
            CleanDropdown(Str(e, F_TTO_SLA)), CleanDropdown(Str(e, F_TTR_SLA)), Str(e, F_TTO_DUE), Str(e, F_TTR_DUE),
            long.TryParse(Str(e, F_TTO_DELAY), out var delay) ? delay : null);
    }

    /// <summary>A busca do GLPI pode devolver "&#62;" como separador de hierarquia (ex.: "TI &#62; Rede").</summary>
    internal static string? CleanDropdown(string? s) => s is null ? null : System.Net.WebUtility.HtmlDecode(s).Replace(' ', ' ').Trim();

    internal static DateTimeOffset? ToUtc(string? glpiLocal, BoardSettings st)
    {
        if (string.IsNullOrWhiteSpace(glpiLocal)) return null;
        if (!DateTime.TryParseExact(glpiLocal, ["yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm", "yyyy-MM-dd"],
                CultureInfo.InvariantCulture, DateTimeStyles.None, out var local)) return null;
        var offset = st.GlpiTimeZone.GetUtcOffset(DateTime.SpecifyKind(local, DateTimeKind.Unspecified));
        return new DateTimeOffset(local, offset).ToUniversalTime();
    }
}
