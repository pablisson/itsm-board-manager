using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using GlpiBoard.Api.Board;
using GlpiBoard.Api.Config;
using GlpiBoard.Api.Glpi;

namespace GlpiBoard.Api.Pm;

/// <summary>
/// Integração da gestão de projetos com o ITSM (GLPI): Project / ProjectTask / ProjectTaskTeam / ProjectTaskLink.
///
/// Sincronização de uma tarefa (por campo de controle, sem relógio entre servidores):
///   • alterada aqui desde a última sincronização  → envia para o ITSM (a versão daqui prevalece);
///   • alterada só no ITSM (date_mod mudou)       → traz do ITSM;
///   • nenhuma das duas                            → nada a fazer.
/// </summary>
public sealed partial class PmGlpi(GlpiClient glpi, BoardService board, PmStore store, BoardSettings settings, ILogger<PmGlpi> log)
{
    private static readonly Dictionary<string, string> StateLabels = new(StringComparer.OrdinalIgnoreCase)
    {
        ["New"] = "Novo", ["Processing"] = "Processando", ["Closed"] = "Fechado",
    };
    private static readonly List<PmState> DefaultStates =
    [
        new(1, "New", "Novo", "#06ff00", false), new(2, "Processing", "Processando", "#ffb800", false), new(3, "Closed", "Fechado", "#ff0000", true),
    ];

    private readonly SemaphoreSlim _metaLock = new(1, 1);
    private readonly SemaphoreSlim _syncLock = new(1, 1);
    private PmMeta? _meta;
    private DateTimeOffset _metaAt;

    // ---------- metadados ----------

    public async Task<PmMeta> MetaAsync(bool force, CancellationToken ct)
    {
        if (!force && _meta is not null && DateTimeOffset.UtcNow - _metaAt < TimeSpan.FromMinutes(10)) return _meta;
        await _metaLock.WaitAsync(ct);
        try
        {
            if (!force && _meta is not null && DateTimeOffset.UtcNow - _metaAt < TimeSpan.FromMinutes(10)) return _meta;
            try
            {
                await using var s = await glpi.OpenSessionAsync(ct);
                var states = Items(await glpi.GetAsync(s, "ProjectState?range=0-200", ct))
                    .Select(e => (Id: Int(e, "id") ?? 0, Name: Str(e, "name") ?? "", Color: Str(e, "color"), Fin: Int(e, "is_finished") == 1))
                    .Where(x => x.Id > 0)
                    .Select(x => new PmState(x.Id, x.Name, StateLabels.GetValueOrDefault(x.Name, x.Name), x.Color, x.Fin)).ToList();
                if (states.Count == 0) states = DefaultStates;

                var entities = Items(await glpi.GetAsync(s, "Entity?range=0-2000", ct))
                    .Select(e => new PmEntity(Int(e, "id") ?? -1, WebUtility.HtmlDecode(Str(e, "completename") ?? Str(e, "name") ?? "")))
                    .Where(e => e.Id >= 0).OrderBy(e => e.Name).ToList();

                // responsáveis: usuários ativos com perfil de interface padrão (técnicos, admins...)
                var profiles = Items(await glpi.GetAsync(s, "Profile?range=0-200", ct))
                    .Where(p => Str(p, "interface") == "central").Select(p => Int(p, "id") ?? 0).Where(id => id > 0).ToList();
                var users = new Dictionary<int, string>();
                foreach (var pid in profiles)
                {
                    var q = new List<KeyValuePair<string, string>>
                    {
                        new("criteria[0][field]", "8"), new("criteria[0][searchtype]", "equals"), new("criteria[0][value]", "1"),
                        new("criteria[1][link]", "AND"), new("criteria[1][field]", "20"), new("criteria[1][searchtype]", "equals"), new("criteria[1][value]", pid.ToString()),
                        new("forcedisplay[0]", "2"), new("forcedisplay[1]", "1"), new("forcedisplay[2]", "9"), new("forcedisplay[3]", "34"),
                    };
                    foreach (var u in await glpi.SearchAllAsync(s, "User", q, ct))
                    {
                        if (Int(u, "2") is not { } id) continue;
                        var full = $"{Str(u, "9")} {Str(u, "34")}".Trim();
                        users[id] = WebUtility.HtmlDecode(full.Length > 0 ? full : Str(u, "1") ?? $"Usuário #{id}");
                    }
                }
                _meta = new PmMeta(states, entities, users.Select(kv => new PmPerson(kv.Key, kv.Value)).OrderBy(p => p.Name).ToList(), null, settings.GlpiWebBase);
                _metaAt = DateTimeOffset.UtcNow;
            }
            catch (Exception ex) when (ex is GlpiException or HttpRequestException or TaskCanceledException or JsonException)
            {
                log.LogWarning("Metadados do ITSM indisponíveis: {Message}", ex.Message);
                if (_meta is not null) return _meta with { Warning = $"ITSM indisponível, usando a última lista carregada: {ex.Message}" };
                return new PmMeta(DefaultStates, new(), new(), $"ITSM indisponível — entidades e técnicos não carregados: {ex.Message}", settings.GlpiWebBase);
            }
            return _meta;
        }
        finally { _metaLock.Release(); }
    }

    // ---------- associar / sincronizar ----------

    /// <summary>Cria a tarefa no ITSM (e antes o projeto e as tarefas-pai que ainda não existirem lá).</summary>
    public async Task<List<string>> LinkTaskAsync(long projectId, long taskId, CancellationToken ct) =>
        await RunAsync(projectId, async (ctx, msgs) =>
        {
            var chain = new List<PmTaskView>();
            for (var t = ctx.View(taskId); t is not null; t = t.ParentId is { } p ? ctx.View(p) : null) chain.Insert(0, t);
            if (chain.Count == 0) throw new PmValidationException("Tarefa não encontrada.");
            if (chain[^1].GlpiTaskId is { } existing) { msgs.Add($"A tarefa já está no ITSM (#{existing})."); return; }
            foreach (var t in chain.Where(t => t.GlpiTaskId is null)) await CreateAsync(ctx, t, msgs);
        }, ct);

    /// <summary>Associa ao ITSM todas as tarefas que ainda não estão lá (na ordem do projeto).</summary>
    public async Task<List<string>> LinkAllAsync(long projectId, CancellationToken ct) =>
        await RunAsync(projectId, async (ctx, msgs) =>
        {
            var n = 0;
            foreach (var t in ctx.Tasks.Where(t => t.GlpiTaskId is null).ToList()) { await CreateAsync(ctx, ctx.View(t.Id)!, null); n++; }
            msgs.Add(n == 0 ? "Todas as tarefas já estavam no ITSM." : $"{n} tarefa(s) criada(s) no ITSM.");
        }, ct);

    public async Task<List<string>> SyncTaskAsync(long projectId, long taskId, CancellationToken ct) =>
        await RunAsync(projectId, async (ctx, msgs) =>
        {
            var t = ctx.View(taskId) ?? throw new PmValidationException("Tarefa não encontrada.");
            if (t.GlpiTaskId is null) throw new PmValidationException("A tarefa ainda não está no ITSM: use “Associar ao ITSM”.");
            await SyncOneAsync(ctx, t, msgs);
        }, ct);

    public async Task<List<string>> SyncProjectAsync(long projectId, CancellationToken ct) =>
        await RunAsync(projectId, async (ctx, msgs) =>
        {
            if (ctx.Data.Project.GlpiProjectId is null && ctx.Tasks.All(t => t.GlpiTaskId is null))
            {
                await EnsureProjectAsync(ctx, msgs);
                msgs.Add("Nenhuma tarefa associada ao ITSM ainda.");
                return;
            }
            await EnsureProjectAsync(ctx, msgs, push: true);
            int sent = 0, pulled = 0, same = 0;
            foreach (var t in ctx.Tasks.Where(t => t.GlpiTaskId is not null).ToList())
            {
                var r = await SyncOneAsync(ctx, ctx.View(t.Id)!, msgs, quiet: true);
                if (r == 1) sent++; else if (r == 2) pulled++; else same++;
            }
            msgs.Add($"Sincronização concluída: {sent} enviada(s) ao ITSM, {pulled} atualizada(s) a partir do ITSM, {same} sem alteração.");
        }, ct);

    /// <summary>Remove o vínculo de dependência no ITSM (melhor esforço).</summary>
    public async Task DeleteLinkAsync(int glpiLinkId, CancellationToken ct)
    {
        try { await using var s = await glpi.OpenSessionAsync(ct); await glpi.DeleteAsync(s, "ProjectTaskLink", glpiLinkId, true, ct); }
        catch (Exception ex) when (ex is GlpiException or HttpRequestException) { log.LogWarning("Falha ao remover dependência no ITSM: {Message}", ex.Message); }
    }

    // ---------- internos ----------

    private sealed class Ctx(GlpiClient.Session s, PmProjectData data, PmProjectView view, List<PmState> states)
    {
        public GlpiClient.Session S { get; } = s;
        public PmProjectData Data { get; set; } = data;
        public PmProjectView ViewData { get; set; } = view;
        public List<PmState> States { get; } = states;
        public List<PmTaskRow> Tasks => Data.Tasks;
        public PmTaskView? View(long id) => ViewData.Tasks.FirstOrDefault(t => t.Id == id);
        public Dictionary<int, string> Uuids { get; } = new();
    }

    private async Task<List<string>> RunAsync(long projectId, Func<Ctx, List<string>, Task> action, CancellationToken ct)
    {
        await _syncLock.WaitAsync(ct);
        try
        {
            var meta = await MetaAsync(false, ct);
            var data = await store.LoadAsync(projectId, ct) ?? throw new PmValidationException("Projeto não encontrado.");
            await using var s = await glpi.OpenSessionAsync(ct);
            var ctx = new Ctx(s, data, PmCalc.Build(data, meta.States, Today()), meta.States);
            var msgs = new List<string>();
            await action(ctx, msgs);
            return msgs;
        }
        finally { _syncLock.Release(); }
    }

    private async Task ReloadAsync(Ctx ctx, CancellationToken ct = default)
    {
        ctx.Data = await store.LoadAsync(ctx.Data.Project.Id, ct) ?? ctx.Data;
        ctx.ViewData = PmCalc.Build(ctx.Data, ctx.States, Today());
    }

    private async Task<int> EnsureProjectAsync(Ctx ctx, List<string>? msgs, bool push = false)
    {
        var p = ctx.Data.Project; var sum = ctx.ViewData.Summary;
        var input = new Dictionary<string, object?>
        {
            ["name"] = p.Name, ["content"] = Html(p.Description), ["entities_id"] = p.EntityId,
            ["plan_start_date"] = Dt(p.StartDate, false), ["plan_end_date"] = Dt(p.EndDate, true),
            ["real_start_date"] = Dt(sum.RealStart, false), ["real_end_date"] = Dt(sum.RealEnd, true),
            ["percent_done"] = Pct(sum.Progress),
        };
        if (p.GlpiProjectId is { } gid)
        {
            if (await glpi.GetAsync(ctx.S, $"Project/{gid}", default) is not null)
            {
                if (push) await glpi.UpdateAsync(ctx.S, "Project", gid, input, default);
                return gid;
            }
            msgs?.Add($"O projeto #{gid} não existe mais no ITSM: foi criado de novo.");
        }
        var id = await glpi.CreateAsync(ctx.S, "Project", input, default);
        await store.SetProjectGlpiAsync(p.Id, id, default);
        msgs?.Add($"Projeto criado no ITSM (#{id}).");
        await ReloadAsync(ctx);
        return id;
    }

    private Dictionary<string, object?> TaskInput(Ctx ctx, PmTaskView t, int glpiProjectId)
    {
        var parent = t.ParentId is { } pid ? ctx.View(pid)?.GlpiTaskId : null;
        return new Dictionary<string, object?>
        {
            ["name"] = t.Title, ["content"] = Html(t.Description),
            ["projects_id"] = glpiProjectId, ["projecttasks_id"] = parent ?? 0, ["entities_id"] = ctx.Data.Project.EntityId,
            ["plan_start_date"] = Dt(t.PlanStart, false), ["plan_end_date"] = Dt(t.PlanEnd, true),
            ["real_start_date"] = Dt(t.RealStart, false), ["real_end_date"] = Dt(t.RealEnd, true),
            ["projectstates_id"] = t.StatusId, ["percent_done"] = Pct(t.Progress), ["is_milestone"] = 0,
        };
    }

    private async Task CreateAsync(Ctx ctx, PmTaskView t, List<string>? msgs)
    {
        var gp = await EnsureProjectAsync(ctx, msgs);
        t = ctx.View(t.Id)!;
        var id = await glpi.CreateAsync(ctx.S, "ProjectTask", TaskInput(ctx, t, gp), default);
        await store.MarkTaskSyncedAsync(t.Id, id, null, default);
        await ReloadAsync(ctx);
        t = ctx.View(t.Id)!;
        await PushTeamAsync(ctx, t, id);
        await PushLinksAsync(ctx, t);
        await store.MarkTaskSyncedAsync(t.Id, id, await DateModAsync(ctx, id), default);
        await ReloadAsync(ctx);
        msgs?.Add($"Tarefa {t.Wbs} “{t.Title}” criada no ITSM (#{id}).");
    }

    /// <summary>0 = nada, 1 = enviada, 2 = trazida do ITSM.</summary>
    private async Task<int> SyncOneAsync(Ctx ctx, PmTaskView t, List<string> msgs, bool quiet = false)
    {
        var row = ctx.Tasks.First(x => x.Id == t.Id);
        var gid = row.GlpiTaskId!.Value;
        var remote = await glpi.GetAsync(ctx.S, $"ProjectTask/{gid}", default);
        if (remote is not { ValueKind: JsonValueKind.Object } g)
        {
            await store.ClearTaskGlpiAsync(t.Id, default);
            await ReloadAsync(ctx);
            msgs.Add($"Tarefa {t.Wbs}: o item #{gid} não existe mais no ITSM — vínculo removido. Use “Associar ao ITSM” para criar de novo.");
            return 0;
        }
        var dateMod = Str(g, "date_mod");
        var remoteDirty = dateMod != row.GlpiDateMod;
        var localDirty = row.GlpiSyncedAt is null || row.UpdatedAt > row.GlpiSyncedAt;

        if (localDirty)
        {
            var gp = await EnsureProjectAsync(ctx, msgs);
            await glpi.UpdateAsync(ctx.S, "ProjectTask", gid, TaskInput(ctx, ctx.View(t.Id)!, gp), default);
            await PushTeamAsync(ctx, t, gid);
            await PushLinksAsync(ctx, t);
            await store.MarkTaskSyncedAsync(t.Id, gid, await DateModAsync(ctx, gid), default);
            await ReloadAsync(ctx);
            if (!quiet || remoteDirty)
                msgs.Add(remoteDirty
                    ? $"Tarefa {t.Wbs}: alterada aqui e no ITSM — a versão daqui foi enviada e prevaleceu."
                    : $"Tarefa {t.Wbs}: alterações enviadas ao ITSM (#{gid}).");
            return 1;
        }
        if (remoteDirty)
        {
            var changes = await PullAsync(ctx, row, g);
            await store.SaveFromGlpiAsync(changes, dateMod, default);
            await ReloadAsync(ctx);
            if (!quiet) msgs.Add($"Tarefa {t.Wbs}: atualizada com os dados do ITSM (#{gid}).");
            return 2;
        }
        await PushLinksAsync(ctx, t);
        if (!quiet) msgs.Add($"Tarefa {t.Wbs}: já estava sincronizada com o ITSM (#{gid}).");
        return 0;
    }

    private async Task<PmTaskRow> PullAsync(Ctx ctx, PmTaskRow row, JsonElement g)
    {
        var isSummary = ctx.View(row.Id)?.IsSummary == true;
        var state = Int(g, "projectstates_id");
        var hasChecklist = ctx.Data.Checklist.Any(c => c.TaskId == row.Id);
        var pulled = row with
        {
            Title = Clip(WebUtility.HtmlDecode(Str(g, "name") ?? row.Title), 300),
            Description = HtmlToText(Str(g, "content")),
            PlanStart = isSummary ? row.PlanStart : Date(Str(g, "plan_start_date")),
            PlanEnd = isSummary ? row.PlanEnd : Date(Str(g, "plan_end_date")),
            RealStart = isSummary ? row.RealStart : Date(Str(g, "real_start_date")),
            RealEnd = isSummary ? row.RealEnd : Date(Str(g, "real_end_date")),
            StatusId = !isSummary && state is { } st && ctx.States.Any(s => s.Id == st) ? st : row.StatusId,
            Percent = !isSummary && !hasChecklist && Int(g, "percent_done") is { } pc ? Math.Clamp(pc, 0, 100) : row.Percent,
        };
        // equipe
        var people = new List<PmPerson>();
        var warnings = new ConcurrentBag<string>();
        foreach (var m in Items(await glpi.GetAsync(ctx.S, $"ProjectTask/{row.GlpiTaskId}/ProjectTaskTeam", default)))
            if (Str(m, "itemtype") == "User" && Int(m, "items_id") is { } uid and > 0)
                people.Add(new PmPerson(uid, await board.ResolveUserAsync(ctx.S, uid, warnings, default)));
        await store.SetAssigneesAsync(row.Id, people, touch: false, default);
        return pulled;
    }

    private async Task PushTeamAsync(Ctx ctx, PmTaskView t, int gid)
    {
        var want = t.Assignees.Select(a => a.Id).ToHashSet();
        var have = Items(await glpi.GetAsync(ctx.S, $"ProjectTask/{gid}/ProjectTaskTeam", default))
            .Where(m => Str(m, "itemtype") == "User")
            .Select(m => (TeamId: Int(m, "id") ?? 0, User: Int(m, "items_id") ?? 0)).ToList();
        foreach (var uid in want.Except(have.Select(h => h.User)))
            await glpi.CreateAsync(ctx.S, "ProjectTaskTeam", new { projecttasks_id = gid, itemtype = "User", items_id = uid }, default);
        foreach (var h in have.Where(h => !want.Contains(h.User) && h.TeamId > 0))
            await glpi.DeleteAsync(ctx.S, "ProjectTaskTeam", h.TeamId, true, default);
    }

    /// <summary>Cria/atualiza no ITSM as dependências desta tarefa cujas duas pontas já estão lá.</summary>
    private async Task PushLinksAsync(Ctx ctx, PmTaskView t)
    {
        foreach (var d in ctx.Data.Dependencies.Where(d => d.PredId == t.Id || d.SuccId == t.Id).ToList())
        {
            var src = ctx.View(d.PredId)?.GlpiTaskId; var dst = ctx.View(d.SuccId)?.GlpiTaskId;
            if (src is null || dst is null) continue;
            var input = new Dictionary<string, object?>
            {
                ["projecttasks_id_source"] = src, ["source_uuid"] = await UuidAsync(ctx, src.Value),
                ["projecttasks_id_target"] = dst, ["target_uuid"] = await UuidAsync(ctx, dst.Value),
                ["type"] = d.Type, ["lag"] = d.LagDays,
            };
            if (d.GlpiLinkId is { } lid && await glpi.GetAsync(ctx.S, $"ProjectTaskLink/{lid}", default) is not null)
                await glpi.UpdateAsync(ctx.S, "ProjectTaskLink", lid, input, default);
            else
                await store.SetDependencyGlpiAsync(d.Id, await glpi.CreateAsync(ctx.S, "ProjectTaskLink", input, default), default);
        }
        await ReloadAsync(ctx);
    }

    private async Task<string?> UuidAsync(Ctx ctx, int gid)
    {
        if (ctx.Uuids.TryGetValue(gid, out var u)) return u;
        var e = await glpi.GetAsync(ctx.S, $"ProjectTask/{gid}", default);
        u = e is { ValueKind: JsonValueKind.Object } o ? Str(o, "uuid") : null;
        if (u is not null) ctx.Uuids[gid] = u;
        return u;
    }

    private async Task<string?> DateModAsync(Ctx ctx, int gid) =>
        await glpi.GetAsync(ctx.S, $"ProjectTask/{gid}", default) is { ValueKind: JsonValueKind.Object } o ? Str(o, "date_mod") : null;

    // ---------- conversões ----------

    private DateOnly Today() => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, settings.GlpiTimeZone).DateTime);

    private static string Dt(DateOnly? d, bool end) => d is { } v ? v.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) + (end ? " 23:59:59" : " 00:00:00") : "NULL";
    private static int Pct(double p) => (int)Math.Clamp(Math.Round(p / 5) * 5, 0, 100);
    private static DateOnly? Date(string? s) => s is { Length: >= 10 } && DateOnly.TryParseExact(s[..10], "yyyy-MM-dd", out var d) ? d : null;
    private static string Clip(string s, int max) => s.Length > max ? s[..max] : s;

    private static string Html(string? text) => string.IsNullOrWhiteSpace(text) ? "" :
        string.Concat(text.Replace("\r", "").Split("\n\n").Select(p => "<p>" + string.Join("<br>", p.Split('\n').Select(WebUtility.HtmlEncode)) + "</p>"));

    internal static string? HtmlToText(string? html)
    {
        if (string.IsNullOrWhiteSpace(html)) return null;
        var s = WebUtility.HtmlDecode(html);
        s = BreakRx().Replace(s, "\n");
        s = TagRx().Replace(s, "");
        s = WebUtility.HtmlDecode(s).Replace(' ', ' ');
        s = BlankRx().Replace(s.Replace("\r", ""), "\n\n").Trim();
        return s.Length == 0 ? null : s;
    }

    [GeneratedRegex(@"<br\s*/?>|</p>|</div>|</li>", RegexOptions.IgnoreCase)] private static partial Regex BreakRx();
    [GeneratedRegex(@"<[^>]+>")] private static partial Regex TagRx();
    [GeneratedRegex(@"\n{3,}")] private static partial Regex BlankRx();

    private static IEnumerable<JsonElement> Items(JsonElement? e) =>
        e is { ValueKind: JsonValueKind.Array } a ? a.EnumerateArray() : Enumerable.Empty<JsonElement>();
    private static int? Int(JsonElement e, string p) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(p, out var v) ? GlpiClient.ReadInt(v) : null;
    private static string? Str(JsonElement e, string p)
    {
        if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(p, out var v)) return null;
        var s = GlpiClient.ReadString(v);
        return string.IsNullOrWhiteSpace(s) ? null : s.Trim();
    }
}
