namespace GlpiBoard.Api.Pm;

/// <summary>
/// Cálculos do projeto (sem I/O):
///  • hierarquia (pai pelo outline), numeração WBS;
///  • tarefa-resumo: datas/status/progresso agregados das subtarefas;
///  • planejado x realizado: % previsto para hoje (linear entre início e fim planejados) x % realizado,
///    ponderados pela duração planejada das tarefas-folha;
///  • conflitos de dependência e situação dos marcos.
/// </summary>
public static class PmCalc
{
    /// <summary>Tipos de dependência (mesmos códigos do Gantt do GLPI / MS Project).</summary>
    public const int FS = 0, SS = 1, FF = 2, SF = 3;

    public sealed record StateIds(int New, int Processing, int Finished, HashSet<int> FinishedIds);

    public static StateIds Resolve(List<PmState> states)
    {
        var fin = states.Where(s => s.IsFinished).Select(s => s.Id).ToHashSet();
        var open = states.Where(s => !s.IsFinished).ToList();
        int Pick(string name, int fallbackIndex) =>
            open.FirstOrDefault(s => s.Name.Equals(name, StringComparison.OrdinalIgnoreCase))?.Id
            ?? (open.Count > fallbackIndex ? open[fallbackIndex].Id : open.FirstOrDefault()?.Id ?? 1);
        var finished = states.FirstOrDefault(s => s.IsFinished && s.Name.Equals("Closed", StringComparison.OrdinalIgnoreCase))?.Id ?? fin.FirstOrDefault(3);
        if (fin.Count == 0) fin.Add(finished);
        return new StateIds(Pick("New", 0), Pick("Processing", 1), finished, fin);
    }

    /// <summary>Normaliza o outline: 1ª tarefa no nível 0; nenhuma tarefa mais de 1 nível abaixo da anterior; máx. 2.</summary>
    public static List<(PmTaskRow Task, int Level)> Outline(List<PmTaskRow> tasks)
    {
        var list = new List<(PmTaskRow, int)>();
        var prev = -1;
        foreach (var t in tasks.OrderBy(t => t.Seq).ThenBy(t => t.Id))
        {
            var lvl = Math.Clamp(t.Level, 0, Math.Min(PmStore.MaxLevel, prev + 1));
            list.Add((t, lvl)); prev = lvl;
        }
        return list;
    }

    private sealed class Node
    {
        public required PmTaskRow Row;
        public int Level; public string Wbs = ""; public Node? Parent; public List<Node> Children = new();
        public DateOnly? PS, PE, RS, RE; public int Status; public bool Done;
        public double Progress; public double? Expected; public double Weight;
    }

    public static PmProjectView Build(PmProjectData d, List<PmState> states, DateOnly today, List<string>? messages = null)
    {
        var ids = Resolve(states);
        var nodes = new List<Node>();
        var stack = new List<Node>();
        var counters = new int[PmStore.MaxLevel + 2];
        foreach (var (row, lvl) in Outline(d.Tasks))
        {
            while (stack.Count > lvl) stack.RemoveAt(stack.Count - 1);
            var n = new Node { Row = row, Level = lvl, Parent = stack.LastOrDefault() };
            n.Parent?.Children.Add(n);
            counters[lvl]++;
            for (var k = lvl + 1; k < counters.Length; k++) counters[k] = 0;
            n.Wbs = string.Join('.', counters.Take(lvl + 1));
            nodes.Add(n); stack.Add(n);
        }

        var checklist = d.Checklist.GroupBy(c => c.TaskId).ToDictionary(g => g.Key, g => g.ToList());

        // de baixo para cima: folhas primeiro, depois os resumos
        for (var i = nodes.Count - 1; i >= 0; i--)
        {
            var n = nodes[i]; var r = n.Row;
            if (n.Children.Count == 0)
            {
                n.PS = r.PlanStart; n.PE = r.PlanEnd; n.RS = r.RealStart; n.RE = r.RealEnd;
                n.Done = r.RealEnd is not null || ids.FinishedIds.Contains(r.StatusId);
                n.Status = n.Done ? (ids.FinishedIds.Contains(r.StatusId) ? r.StatusId : ids.Finished) : r.StatusId;
                var items = checklist.GetValueOrDefault(r.Id);
                n.Progress = n.Done ? 100 : items is { Count: > 0 } ? 100.0 * items.Count(c => c.Done) / items.Count : r.Percent;
                n.Expected = Expected(n.PS, n.PE, today);
                n.Weight = Days(n.PS, n.PE) ?? 1;
            }
            else
            {
                var ch = n.Children;
                n.PS = Min(ch.Select(c => c.PS)); n.PE = Max(ch.Select(c => c.PE));
                n.RS = Min(ch.Select(c => c.RS));
                n.Done = ch.All(c => c.Done);
                n.RE = n.Done ? Max(ch.Select(c => c.RE)) : null;
                n.Status = n.Done ? ids.Finished : ch.Any(c => c.Done || c.RS is not null || c.Status != ids.New) ? ids.Processing : ids.New;
                n.Weight = ch.Sum(c => c.Weight);
                n.Progress = n.Weight > 0 ? ch.Sum(c => c.Weight * c.Progress) / n.Weight : 0;
                var withExp = ch.Where(c => c.Expected is not null).ToList();
                var we = withExp.Sum(c => c.Weight);
                n.Expected = we > 0 ? withExp.Sum(c => c.Weight * c.Expected!.Value) / we : null;
            }
        }

        var byId = nodes.ToDictionary(n => n.Row.Id);
        var files = d.Attachments.GroupBy(a => a.TaskId).ToDictionary(g => g.Key, g => g.ToList());
        var views = nodes.Select(n => new PmTaskView
        {
            Id = n.Row.Id, Seq = n.Row.Seq, Level = n.Level, Wbs = n.Wbs, ParentId = n.Parent?.Row.Id, IsSummary = n.Children.Count > 0,
            Title = n.Row.Title, Description = n.Row.Description,
            PlanStart = n.PS, PlanEnd = n.PE, RealStart = n.RS, RealEnd = n.RE,
            StatusId = n.Status, Done = n.Done, Percent = n.Row.Percent,
            Progress = Math.Round(n.Progress, 1), Expected = n.Expected is { } e ? Math.Round(e, 1) : null,
            StartVarDays = n.RS is { } rs && n.PS is { } ps ? rs.DayNumber - ps.DayNumber : null,
            EndVarDays = n.RE is { } re && n.PE is { } pe ? re.DayNumber - pe.DayNumber
                : !n.Done && n.PE is { } pe2 && pe2 < today ? today.DayNumber - pe2.DayNumber : null,
            Late = !n.Done && n.PE is { } pe3 && pe3 < today,
            OutOfProject = n.PS < d.Project.StartDate || n.PE > d.Project.EndDate,
            Assignees = d.Assignees.GetValueOrDefault(n.Row.Id) ?? new(),
            Checklist = checklist.GetValueOrDefault(n.Row.Id) ?? new(),
            Attachments = files.GetValueOrDefault(n.Row.Id) ?? new(),
            GlpiTaskId = n.Row.GlpiTaskId, GlpiSyncedAt = n.Row.GlpiSyncedAt,
            GlpiPending = n.Row.GlpiTaskId is not null && (n.Row.GlpiSyncedAt is null || n.Row.UpdatedAt > n.Row.GlpiSyncedAt),
        }).ToList();

        var deps = d.Dependencies.Where(x => byId.ContainsKey(x.PredId) && byId.ContainsKey(x.SuccId))
            .Select(x => new PmDependencyView(x.Id, x.PredId, x.SuccId, x.Type, x.LagDays, RequiredShift(x, byId[x.PredId].PS, byId[x.PredId].PE, byId[x.SuccId].PS, byId[x.SuccId].PE) > 0, x.GlpiLinkId))
            .ToList();

        var milestones = d.Milestones.Select(m =>
        {
            var linked = m.TaskIds.Where(byId.ContainsKey).Select(id => byId[id]).ToList();
            var done = linked.Count > 0 && linked.All(n => n.Done);
            var doneDate = done ? Max(linked.Select(n => n.RE)) : null;
            var forecast = Max(linked.Select(n => n.Done ? n.RE : n.PE));
            var w = linked.Sum(n => n.Weight);
            var progress = w > 0 ? linked.Sum(n => n.Weight * n.Progress) / w : 0;
            var state = done ? (doneDate > m.DueDate ? "doneLate" : "done")
                : m.DueDate < today ? "late"
                : forecast > m.DueDate ? "risk" : "open";
            return new PmMilestoneView(m.Id, m.Name, m.Objective, m.DueDate, m.TaskIds.Where(byId.ContainsKey).ToList(), state, forecast, doneDate, Math.Round(progress, 1));
        }).ToList();

        var roots = nodes.Where(n => n.Parent is null).ToList();
        var leaves = nodes.Where(n => n.Children.Count == 0).ToList();
        var rw = roots.Sum(n => n.Weight);
        var rootsExp = roots.Where(n => n.Expected is not null).ToList();
        var rwe = rootsExp.Sum(n => n.Weight);
        var summary = new PmSummary(
            rw > 0 ? Math.Round(roots.Sum(n => n.Weight * n.Progress) / rw, 1) : 0,
            rwe > 0 ? Math.Round(rootsExp.Sum(n => n.Weight * n.Expected!.Value) / rwe, 1) : null,
            leaves.Count, leaves.Count(n => n.Done), leaves.Count(n => !n.Done && n.PE < today),
            leaves.Count(n => !n.Done && (n.RS is not null || n.Status != ids.New)),
            Min(roots.Select(n => n.PS)), Max(roots.Select(n => n.PE)),
            Min(roots.Select(n => n.RS)), roots.Count > 0 && roots.All(n => n.Done) ? Max(roots.Select(n => n.RE)) : null,
            Max(leaves.Select(n => n.Done ? n.RE : n.PE is { } pe && pe < today ? today : n.PE)),
            milestones.Count, milestones.Count(m => m.State.StartsWith("done")));

        return new PmProjectView(d.Project, summary, views, deps, milestones, today, messages ?? new());
    }

    /// <summary>Quantos dias a sucessora precisa andar para respeitar a dependência (≤ 0 = ok).</summary>
    public static int RequiredShift(PmDependency x, DateOnly? ps, DateOnly? pe, DateOnly? ss, DateOnly? se)
    {
        int? need = x.Type switch
        {
            FS when pe is { } a && ss is { } b => a.DayNumber + 1 + x.LagDays - b.DayNumber,
            SS when ps is { } a && ss is { } b => a.DayNumber + x.LagDays - b.DayNumber,
            FF when pe is { } a && se is { } b => a.DayNumber + x.LagDays - b.DayNumber,
            SF when ps is { } a && se is { } b => a.DayNumber + x.LagDays - b.DayNumber,
            _ => null,
        };
        return need ?? 0;
    }

    public static int? Days(DateOnly? a, DateOnly? b) => a is { } x && b is { } y ? Math.Max(1, y.DayNumber - x.DayNumber + 1) : null;

    private static double? Expected(DateOnly? ps, DateOnly? pe, DateOnly today)
    {
        if (ps is not { } s || pe is not { } e) return null;
        if (today < s) return 0;
        if (today >= e) return 100;
        return 100.0 * (today.DayNumber - s.DayNumber + 1) / (e.DayNumber - s.DayNumber + 1);
    }

    private static DateOnly? Min(IEnumerable<DateOnly?> xs) { DateOnly? m = null; foreach (var x in xs) if (x is { } v && (m is null || v < m)) m = v; return m; }
    private static DateOnly? Max(IEnumerable<DateOnly?> xs) { DateOnly? m = null; foreach (var x in xs) if (x is { } v && (m is null || v > m)) m = v; return m; }
}
