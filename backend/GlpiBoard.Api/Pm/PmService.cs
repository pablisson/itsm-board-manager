using System.Text.Json;
using GlpiBoard.Api.Config;

namespace GlpiBoard.Api.Pm;

/// <summary>Regras de negócio da gestão de projetos (validação, outline, status x datas, dependências).</summary>
public sealed class PmService(PmStore store, PmGlpi itsm, BoardSettings settings)
{
    public DateOnly Today() => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, settings.GlpiTimeZone).DateTime);

    public async Task<PmProjectView?> ViewAsync(long projectId, CancellationToken ct, List<string>? messages = null)
    {
        var data = await store.LoadAsync(projectId, ct);
        if (data is null) return null;
        var meta = await itsm.MetaAsync(false, ct);
        return PmCalc.Build(data, meta.States, Today(), messages);
    }

    public async Task<List<PmProjectListItem>> ListAsync(CancellationToken ct)
    {
        var meta = await itsm.MetaAsync(false, ct);
        var today = Today();
        return (await store.LoadAllAsync(ct)).Select(d => { var v = PmCalc.Build(d, meta.States, today); return new PmProjectListItem(v.Project, v.Summary); }).ToList();
    }

    // ---------- projetos ----------

    public sealed record ProjectInput(string? Name, string? Description, int EntityId, string? EntityName, DateOnly? StartDate, DateOnly? EndDate);

    private static (string Name, string? Desc, DateOnly Start, DateOnly End) Check(ProjectInput p)
    {
        var name = Text(p.Name, 200) ?? throw new PmValidationException("Informe o nome do projeto.");
        if (p.EntityId < 0) throw new PmValidationException("Escolha a entidade do projeto.");
        if (p.StartDate is not { } s || p.EndDate is not { } e) throw new PmValidationException("Informe as datas de início e fim do projeto.");
        if (e < s) throw new PmValidationException("A data de fim do projeto é anterior ao início.");
        if (s.Year < 2000 || e.Year > 2100) throw new PmValidationException("Datas do projeto fora do intervalo permitido.");
        return (name, Text(p.Description, 20000), s, e);
    }

    public async Task<long> CreateProjectAsync(ProjectInput p, CancellationToken ct)
    {
        var (name, desc, s, e) = Check(p);
        return await store.CreateProjectAsync(name, desc, p.EntityId, Text(p.EntityName, 300), s, e, ct);
    }

    public async Task UpdateProjectAsync(long id, ProjectInput p, CancellationToken ct)
    {
        var (name, desc, s, e) = Check(p);
        await store.UpdateProjectAsync(id, name, desc, p.EntityId, Text(p.EntityName, 300), s, e, ct);
    }

    // ---------- tarefas ----------

    public async Task<long> AddTaskAsync(long projectId, string? title, long? afterId, CancellationToken ct) =>
        await store.InsertTaskAsync(projectId, Text(title, 300) ?? "Nova tarefa", afterId, ct);

    /// <summary>Atualização parcial: só os campos presentes no JSON (null limpa a data).</summary>
    public async Task<List<string>> PatchTaskAsync(long projectId, long taskId, JsonElement body, CancellationToken ct)
    {
        var msgs = new List<string>();
        var data = await store.LoadAsync(projectId, ct) ?? throw new PmValidationException("Projeto não encontrado.");
        var meta = await itsm.MetaAsync(false, ct);
        var ids = PmCalc.Resolve(meta.States);
        var view = PmCalc.Build(data, meta.States, Today());
        var tv = view.Tasks.FirstOrDefault(t => t.Id == taskId) ?? throw new PmValidationException("Tarefa não encontrada.");
        var t = data.Tasks.First(x => x.Id == taskId);
        bool Has(string p) => body.ValueKind == JsonValueKind.Object && body.TryGetProperty(p, out _);

        string[] computed = ["planStart", "planEnd", "realStart", "realEnd", "statusId", "percent"];
        if (tv.IsSummary && computed.Any(Has))
            throw new PmValidationException("Tarefa-resumo: datas, status e % são calculados a partir das subtarefas.");

        if (Has("title")) t = t with { Title = Text(GetString(body, "title"), 300) ?? throw new PmValidationException("O título não pode ficar vazio.") };
        if (Has("description")) t = t with { Description = Text(GetString(body, "description"), 20000) };
        if (Has("planStart")) t = t with { PlanStart = GetDate(body, "planStart") };
        if (Has("planEnd")) t = t with { PlanEnd = GetDate(body, "planEnd") };
        if (Has("realStart")) t = t with { RealStart = GetDate(body, "realStart") };
        if (Has("percent")) t = t with { Percent = Math.Clamp(body.GetProperty("percent").GetInt32(), 0, 100) };

        var today = Today();
        bool Finished(int s) => ids.FinishedIds.Contains(s);
        if (Has("statusId"))
        {
            var st = body.GetProperty("statusId").GetInt32();
            if (meta.States.All(s => s.Id != st)) throw new PmValidationException("Status inválido.");
            t = t with { StatusId = st };
            if (Finished(st) && t.RealEnd is null && !Has("realEnd")) t = t with { RealEnd = today };
            if (!Finished(st) && t.RealEnd is not null && !Has("realEnd")) { t = t with { RealEnd = null }; msgs.Add("Tarefa reaberta: a data de conclusão foi limpa."); }
        }
        if (Has("realEnd"))
        {
            t = t with { RealEnd = GetDate(body, "realEnd") };
            if (t.RealEnd is not null && !Finished(t.StatusId)) t = t with { StatusId = ids.Finished };
            if (t.RealEnd is null && Finished(t.StatusId)) t = t with { StatusId = ids.Processing };
        }
        if (t.RealStart is not null && t.StatusId == ids.New) t = t with { StatusId = ids.Processing };
        if (t.RealEnd is { } re && t.RealStart is null) t = t with { RealStart = t.PlanStart is { } ps && ps <= re ? ps : re };

        if (t.PlanStart is { } a && t.PlanEnd is { } b && b < a) throw new PmValidationException("O fim planejado é anterior ao início planejado.");
        if (t.RealStart is { } c && t.RealEnd is { } d && d < c) throw new PmValidationException("A conclusão é anterior ao início executado.");
        if (t.RealStart > today || t.RealEnd > today) throw new PmValidationException("Datas executadas não podem estar no futuro.");
        foreach (var x in new[] { t.PlanStart, t.PlanEnd, t.RealStart, t.RealEnd })
            if (x is { } v && (v.Year < 2000 || v.Year > 2100)) throw new PmValidationException("Data fora do intervalo permitido.");

        var wasDone = tv.Done;
        var nowDone = t.RealEnd is not null || Finished(t.StatusId);
        if (nowDone && !wasDone && tv.Checklist.Count(i => !i.Done) is var open and > 0)
            throw new PmValidationException($"Conclua o checklist antes de concluir a tarefa ({open} item(ns) pendente(s)).");

        await store.UpdateTaskAsync(t, ct);

        if (Has("assignees"))
        {
            var people = body.GetProperty("assignees").EnumerateArray()
                .Select(p => new PmPerson(p.GetProperty("id").GetInt32(), Text(p.TryGetProperty("name", out var n) ? n.GetString() : null, 200) ?? ""))
                .Where(p => p.Id > 0).ToList();
            var known = meta.Users.ToDictionary(u => u.Id, u => u.Name);
            people = people.Select(p => p with { Name = known.GetValueOrDefault(p.Id, p.Name.Length > 0 ? p.Name : $"Usuário #{p.Id}") }).ToList();
            await store.SetAssigneesAsync(taskId, people, touch: true, ct);
        }
        return msgs;
    }

    /// <summary>Tab: vira subtarefa da tarefa acima (máx. 3 níveis).</summary>
    public async Task IndentAsync(long projectId, long taskId, int delta, CancellationToken ct)
    {
        var outline = await OutlineAsync(projectId, ct);
        var i = outline.FindIndex(o => o.Id == taskId);
        if (i < 0) throw new PmValidationException("Tarefa não encontrada.");
        var end = SubEnd(outline, i);
        var level = outline[i].Level;
        if (delta > 0)
        {
            if (i == 0 || outline[i - 1].Level < level) throw new PmValidationException("Não há tarefa acima no mesmo nível para virar a tarefa-pai.");
            var deepest = outline.Skip(i).Take(end - i).Max(o => o.Level);
            if (deepest + 1 > PmStore.MaxLevel) throw new PmValidationException("Limite de 3 níveis de hierarquia.");
        }
        else if (level == 0) throw new PmValidationException("A tarefa já está no primeiro nível.");
        for (var k = i; k < end; k++) outline[k] = (outline[k].Id, outline[k].Level + Math.Sign(delta));
        await store.SaveOutlineAsync(outline, ct);
    }

    /// <summary>Move a tarefa (com subtarefas) para cima/baixo entre as irmãs.</summary>
    public async Task MoveAsync(long projectId, long taskId, int dir, CancellationToken ct)
    {
        var o = await OutlineAsync(projectId, ct);
        var i = o.FindIndex(x => x.Id == taskId);
        if (i < 0) throw new PmValidationException("Tarefa não encontrada.");
        var lvl = o[i].Level; var end = SubEnd(o, i);
        List<(long, int)> block = o.GetRange(i, end - i);
        if (dir < 0)
        {
            var j = i - 1;
            while (j >= 0 && o[j].Level > lvl) j--;
            if (j < 0 || o[j].Level != lvl) return;
            o.RemoveRange(i, end - i); o.InsertRange(j, block);
        }
        else
        {
            if (end >= o.Count || o[end].Level != lvl) return;
            var nextEnd = SubEnd(o, end);
            o.RemoveRange(i, end - i); o.InsertRange(i + (nextEnd - end), block);
        }
        await store.SaveOutlineAsync(o, ct);
    }

    public async Task<int> DeleteTaskAsync(long projectId, long taskId, CancellationToken ct)
    {
        var o = await OutlineAsync(projectId, ct);
        var i = o.FindIndex(x => x.Id == taskId);
        if (i < 0) return 0;
        var ids = o.GetRange(i, SubEnd(o, i) - i).Select(x => x.Id).ToList();
        await store.DeleteTasksAsync(projectId, ids, ct);
        return ids.Count;
    }

    /// <summary>Empurra as datas planejadas da tarefa para respeitar as dependências (resumo: move as subtarefas).</summary>
    public async Task<string> AlignAsync(long projectId, long taskId, CancellationToken ct)
    {
        var data = await store.LoadAsync(projectId, ct) ?? throw new PmValidationException("Projeto não encontrado.");
        var meta = await itsm.MetaAsync(false, ct);
        var view = PmCalc.Build(data, meta.States, Today());
        var byId = view.Tasks.ToDictionary(t => t.Id);
        var me = byId.GetValueOrDefault(taskId) ?? throw new PmValidationException("Tarefa não encontrada.");
        var shift = data.Dependencies.Where(d => d.SuccId == taskId && byId.ContainsKey(d.PredId))
            .Select(d => PmCalc.RequiredShift(d, byId[d.PredId].PlanStart, byId[d.PredId].PlanEnd, me.PlanStart, me.PlanEnd))
            .DefaultIfEmpty(0).Max();
        if (shift <= 0) return "As datas já respeitam as dependências.";
        var targets = me.IsSummary ? view.Tasks.Where(t => !t.IsSummary && IsDescendant(byId, t, taskId)).Select(t => t.Id).ToHashSet() : [taskId];
        foreach (var row in data.Tasks.Where(r => targets.Contains(r.Id)))
            await store.UpdateTaskAsync(row with { PlanStart = row.PlanStart?.AddDays(shift), PlanEnd = row.PlanEnd?.AddDays(shift) }, ct);
        return $"Datas planejadas adiadas em {shift} dia(s) para respeitar as dependências.";
    }

    // ---------- dependências ----------

    public async Task AddDependencyAsync(long projectId, long pred, long succ, int type, int lag, CancellationToken ct)
    {
        var data = await store.LoadAsync(projectId, ct) ?? throw new PmValidationException("Projeto não encontrado.");
        if (pred == succ) throw new PmValidationException("Uma tarefa não pode depender dela mesma.");
        var view = PmCalc.Build(data, (await itsm.MetaAsync(false, ct)).States, Today());
        var byId = view.Tasks.ToDictionary(t => t.Id);
        if (!byId.ContainsKey(pred) || !byId.ContainsKey(succ)) throw new PmValidationException("Tarefa de outro projeto.");
        if (IsDescendant(byId, byId[pred], succ) || IsDescendant(byId, byId[succ], pred))
            throw new PmValidationException("Não é possível criar dependência entre uma tarefa e a sua tarefa-pai/subtarefa.");
        CheckType(type, lag);
        // ciclo: a sucessora já leva (direta ou indiretamente) à predecessora?
        var next = data.Dependencies.Where(d => !(d.PredId == pred && d.SuccId == succ)).GroupBy(d => d.PredId).ToDictionary(g => g.Key, g => g.Select(d => d.SuccId).ToList());
        var seen = new HashSet<long>(); var stack = new Stack<long>([succ]);
        while (stack.Count > 0)
        {
            var x = stack.Pop();
            if (x == pred) throw new PmValidationException("Essa dependência criaria um ciclo entre as tarefas.");
            if (seen.Add(x) && next.TryGetValue(x, out var ns)) foreach (var n in ns) stack.Push(n);
        }
        await store.AddDependencyAsync(projectId, pred, succ, type, lag, ct);
    }

    public static void CheckType(int type, int lag)
    {
        if (type is < 0 or > 3) throw new PmValidationException("Tipo de dependência inválido.");
        if (lag is < -365 or > 365) throw new PmValidationException("Defasagem deve estar entre -365 e 365 dias.");
    }

    // ---------- marcos ----------

    public sealed record MilestoneInput(string? Name, string? Objective, DateOnly? DueDate, List<long>? TaskIds);

    public async Task SaveMilestoneAsync(long projectId, long? id, MilestoneInput m, CancellationToken ct)
    {
        var name = Text(m.Name, 200) ?? throw new PmValidationException("Informe o nome do marco.");
        if (m.DueDate is not { } due || due.Year < 2000 || due.Year > 2100) throw new PmValidationException("Informe a data do marco.");
        await store.SaveMilestoneAsync(id, projectId, name, Text(m.Objective, 5000), due, m.TaskIds ?? new(), ct);
    }

    // ---------- helpers ----------

    private async Task<List<(long Id, int Level)>> OutlineAsync(long projectId, CancellationToken ct)
    {
        var data = await store.LoadAsync(projectId, ct) ?? throw new PmValidationException("Projeto não encontrado.");
        return PmCalc.Outline(data.Tasks).Select(x => (x.Task.Id, x.Level)).ToList();
    }

    private static int SubEnd(List<(long Id, int Level)> o, int i)
    {
        var j = i + 1;
        while (j < o.Count && o[j].Level > o[i].Level) j++;
        return j;
    }

    private static bool IsDescendant(Dictionary<long, PmTaskView> byId, PmTaskView t, long ancestorId)
    {
        for (var p = t.ParentId; p is { } pid; p = byId.GetValueOrDefault(pid)?.ParentId)
            if (pid == ancestorId) return true;
        return false;
    }

    public static string? Text(string? s, int max)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        s = s.Trim();
        return s.Length > max ? s[..max] : s;
    }

    private static string? GetString(JsonElement b, string p) => b.GetProperty(p) is { ValueKind: JsonValueKind.String } v ? v.GetString() : null;

    private static DateOnly? GetDate(JsonElement b, string p)
    {
        var v = b.GetProperty(p);
        if (v.ValueKind is JsonValueKind.Null || v.ValueKind == JsonValueKind.String && string.IsNullOrEmpty(v.GetString())) return null;
        if (v.ValueKind == JsonValueKind.String && DateOnly.TryParseExact(v.GetString(), "yyyy-MM-dd", out var d)) return d;
        throw new PmValidationException($"Data inválida em {p} (use AAAA-MM-DD).");
    }
}
