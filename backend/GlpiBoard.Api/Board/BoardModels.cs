namespace GlpiBoard.Api.Board;

public sealed record PersonRef(int Id, string Name);

/// <summary>SLA do chamado como calculado pelo ITSM (os prazos já consideram o calendário da SLA).
/// OwnedAtUtc = quando foi assumido (abertura + tempo de atribuição); null = ainda não assumido.</summary>
public sealed record BoardSla(string? TtoName, string? TtrName, DateTimeOffset? TtoDueUtc, DateTimeOffset? TtrDueUtc, DateTimeOffset? OwnedAtUtc);

public sealed record BoardTicket
{
    public int Id { get; init; }
    public string Title { get; init; } = "";
    public int Status { get; init; }
    public string StatusLabel { get; init; } = "";
    public int? Priority { get; init; }
    public string? PriorityLabel { get; init; }
    public string? Category { get; init; }
    public string? Entity { get; init; }
    public DateTimeOffset? OpenedAtUtc { get; init; }
    public DateTimeOffset? UpdatedAtUtc { get; init; }
    public DateTimeOffset? SolvedAtUtc { get; init; }
    public DateTimeOffset? ClosedAtUtc { get; init; }
    /// <summary>Somente técnicos atribuídos (Ticket_User.type = 2). Observadores (type 3) são ignorados.</summary>
    public List<PersonRef> Technicians { get; init; } = new();
    /// <summary>Grupos atribuídos (Group_Ticket.type = 2).</summary>
    public List<string> AssignedGroups { get; init; } = new();
    public int? SolutionTypeId { get; init; }
    public string? SolutionType { get; init; }
    public string Url { get; init; } = "";
    /// <summary>Alertas de qualidade de dado deste ticket (ex.: status Novo com técnico).</summary>
    public List<string> Flags { get; init; } = new();
    public BoardSla? Sla { get; init; }
}

public sealed record TechnicianLane(int Id, string Name, List<BoardTicket> Tickets);

public sealed record BoardColumns
{
    public List<BoardTicket> Unassigned { get; init; } = new();
    public List<TechnicianLane> InProgress { get; init; } = new();
    public List<BoardTicket> Blocked { get; init; } = new();
    public List<BoardTicket> Completed { get; init; } = new();
    public List<BoardTicket> Cancelled { get; init; } = new();
}

public sealed record BoardSnapshot
{
    public DateTimeOffset SyncedAtUtc { get; init; }
    public long DurationMs { get; init; }
    public string GlpiHost { get; init; } = "";
    public int DoneDays { get; init; }
    public bool CancelledConfigured { get; init; }
    public int AgeWarnHours { get; init; }
    public int AgeCriticalHours { get; init; }
    public BoardColumns Columns { get; init; } = new();
    public Dictionary<string, int> Totals { get; init; } = new();
    public List<string> Warnings { get; init; } = new();
}

public sealed record BoardResponse(BoardSnapshot? Snapshot, string? LastError, DateTimeOffset? LastErrorAtUtc, bool Stale, int? ThrottledSeconds = null);
