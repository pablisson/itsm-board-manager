namespace GlpiBoard.Api.Pm;

// ---------- Linhas do banco ----------

public sealed record PmProject(long Id, string Name, string? Description, int EntityId, string? EntityName,
    DateOnly StartDate, DateOnly EndDate, int? GlpiProjectId, DateTimeOffset? GlpiSyncedAt, DateTimeOffset UpdatedAt);

public sealed record PmTaskRow(long Id, long ProjectId, int Seq, int Level, string Title, string? Description,
    DateOnly? PlanStart, DateOnly? PlanEnd, DateOnly? RealStart, DateOnly? RealEnd, int StatusId, int Percent,
    int? GlpiTaskId, string? GlpiDateMod, DateTimeOffset? GlpiSyncedAt, DateTimeOffset UpdatedAt);

public sealed record PmPerson(int Id, string Name);
public sealed record PmDependency(long Id, long PredId, long SuccId, int Type, int LagDays, int? GlpiLinkId);
public sealed record PmChecklistItem(long Id, long TaskId, string Text, bool Done, int Position);
public sealed record PmAttachment(long Id, long TaskId, string FileName, string? ContentType, int Size, DateTimeOffset CreatedAt);
public sealed record PmMilestoneRow(long Id, string Name, string? Objective, DateOnly DueDate, List<long> TaskIds);

/// <summary>Tudo de um projeto, como está no banco.</summary>
public sealed record PmProjectData(PmProject Project, List<PmTaskRow> Tasks, Dictionary<long, List<PmPerson>> Assignees,
    List<PmDependency> Dependencies, List<PmChecklistItem> Checklist, List<PmAttachment> Attachments, List<PmMilestoneRow> Milestones);

// ---------- Metadados do ITSM ----------

/// <summary>Estado de projeto/tarefa do GLPI (ProjectState).</summary>
public sealed record PmState(int Id, string Name, string Label, string? Color, bool IsFinished);
public sealed record PmEntity(int Id, string Name);
public sealed record PmMeta(List<PmState> States, List<PmEntity> Entities, List<PmPerson> Users, string? Warning, string? ItsmUrl = null);

// ---------- Visões calculadas (o que o front recebe) ----------

public sealed record PmTaskView
{
    public long Id { get; init; }
    public int Seq { get; init; }
    public int Level { get; init; }
    public string Wbs { get; init; } = "";
    public long? ParentId { get; init; }
    public bool IsSummary { get; init; }
    public string Title { get; init; } = "";
    public string? Description { get; init; }
    /// <summary>Datas efetivas (tarefa-resumo: calculadas a partir das subtarefas).</summary>
    public DateOnly? PlanStart { get; init; }
    public DateOnly? PlanEnd { get; init; }
    public DateOnly? RealStart { get; init; }
    public DateOnly? RealEnd { get; init; }
    public int StatusId { get; init; }
    public bool Done { get; init; }
    /// <summary>% informado manualmente (sem checklist).</summary>
    public int Percent { get; init; }
    /// <summary>% realizado (0–100).</summary>
    public double Progress { get; init; }
    /// <summary>% que deveria estar feito hoje pelo planejado (null = sem datas).</summary>
    public double? Expected { get; init; }
    public int? StartVarDays { get; init; }
    public int? EndVarDays { get; init; }
    /// <summary>Fim planejado vencido e não concluída.</summary>
    public bool Late { get; init; }
    public bool OutOfProject { get; init; }
    public List<PmPerson> Assignees { get; init; } = new();
    public List<PmChecklistItem> Checklist { get; init; } = new();
    public List<PmAttachment> Attachments { get; init; } = new();
    public int? GlpiTaskId { get; init; }
    public DateTimeOffset? GlpiSyncedAt { get; init; }
    /// <summary>Alterada aqui depois da última sincronização com o ITSM.</summary>
    public bool GlpiPending { get; init; }
}

public sealed record PmDependencyView(long Id, long PredId, long SuccId, int Type, int LagDays, bool Violated, int? GlpiLinkId);

public sealed record PmMilestoneView(long Id, string Name, string? Objective, DateOnly DueDate, List<long> TaskIds,
    string State, DateOnly? Forecast, DateOnly? DoneDate, double Progress);

public sealed record PmSummary(double Progress, double? Expected, int Tasks, int Done, int Late, int InProgress,
    DateOnly? PlanStart, DateOnly? PlanEnd, DateOnly? RealStart, DateOnly? RealEnd, DateOnly? Forecast, int Milestones, int MilestonesDone);

public sealed record PmProjectView(PmProject Project, PmSummary Summary, List<PmTaskView> Tasks,
    List<PmDependencyView> Dependencies, List<PmMilestoneView> Milestones, DateOnly Today, List<string> Messages);

public sealed record PmProjectListItem(PmProject Project, PmSummary Summary);

public sealed class PmValidationException(string message) : Exception(message);
