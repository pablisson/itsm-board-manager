using GlpiBoard.Api.Data;
using MySqlConnector;
using static GlpiBoard.Api.Data.AppDb;

namespace GlpiBoard.Api.Plan;

/// <summary>Um ticket planejado para um técnico em um dia.</summary>
public sealed record PlanItem(long Id, int TechId, string? TechName, int TicketId, string? Title, DateOnly Day, int Position, DateTimeOffset UpdatedAtUtc);

public sealed record PlanCreate(int TechId, string? TechName, int TicketId, string? Title, DateOnly Day);
public sealed record PlanMove(DateOnly Day, int? Position);

public sealed class PlanUnavailableException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>Planejamento por técnico/dia guardado no MySQL (tabela plan_item).</summary>
public sealed class PlanStore(AppDb db)
{
    public bool Configured => db.Configured;

    private const string Cols = "id, tech_id, tech_name, ticket_id, title, day, position, updated_at";
    private static PlanItem Read(MySqlDataReader r) => new(
        r.GetInt64(0), r.GetInt32(1), r.IsDBNull(2) ? null : r.GetString(2), r.GetInt32(3), r.IsDBNull(4) ? null : r.GetString(4),
        r.GetFieldValue<DateOnly>(5), r.GetInt32(6), Utc(r, 7));

    internal static DateTimeOffset Utc(MySqlDataReader r, int i) => new(DateTime.SpecifyKind(r.GetDateTime(i), DateTimeKind.Utc));

    public async Task<List<PlanItem>> ListAsync(DateOnly from, DateOnly to, CancellationToken ct)
    {
        await using var conn = await db.OpenAsync(ct);
        await using var cmd = Cmd(conn, $"SELECT {Cols} FROM plan_item WHERE day BETWEEN $1 AND $2 ORDER BY day, tech_id, position, id", from, to);
        return await ReadAllAsync(cmd, ct);
    }

    /// <summary>Quantos dias planejados cada ticket tem (todas as datas), por técnico.</summary>
    public async Task<List<(int TechId, int TicketId, int Days, DateOnly Next)>> CountsAsync(DateOnly today, CancellationToken ct)
    {
        await using var conn = await db.OpenAsync(ct);
        await using var cmd = Cmd(conn,
            "SELECT tech_id, ticket_id, COUNT(*), COALESCE(MIN(CASE WHEN day >= $1 THEN day END), MAX(day)) FROM plan_item GROUP BY tech_id, ticket_id ORDER BY tech_id, ticket_id", today);
        var list = new List<(int, int, int, DateOnly)>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct)) list.Add((r.GetInt32(0), r.GetInt32(1), Convert.ToInt32(r.GetValue(2)), r.GetFieldValue<DateOnly>(3)));
        return list;
    }

    /// <summary>Planeja o ticket no dia (no fim da célula). Se já existir no mesmo dia/técnico, devolve o existente.</summary>
    public async Task<PlanItem> AddAsync(PlanCreate c, CancellationToken ct)
    {
        await using var conn = await db.OpenAsync(ct);
        await using (var ins = Cmd(conn, """
            INSERT INTO plan_item (tech_id, tech_name, ticket_id, title, day, position)
            SELECT $1, $2, $3, $4, $5, COALESCE(MAX(position) + 1, 0) FROM plan_item WHERE tech_id = $1 AND day = $5
            ON DUPLICATE KEY UPDATE title = COALESCE(VALUES(title), title), updated_at = UTC_TIMESTAMP(6)
            """, c.TechId, Trim(c.TechName), c.TicketId, Trim(c.Title), c.Day))
            await ins.ExecuteNonQueryAsync(ct);
        await using var get = Cmd(conn, $"SELECT {Cols} FROM plan_item WHERE tech_id = $1 AND ticket_id = $2 AND day = $3", c.TechId, c.TicketId, c.Day);
        return (await ReadAllAsync(get, ct))[0];
    }

    /// <summary>Insere vários itens de uma vez; os que já existem (técnico+ticket+dia) ficam como estão. Devolve as chaves inseridas.</summary>
    public async Task<HashSet<(int TechId, int TicketId, DateOnly Day)>> ImportAsync(IReadOnlyList<PlanCreate> items, CancellationToken ct)
    {
        var added = new HashSet<(int, int, DateOnly)>();
        if (items.Count == 0) return added;
        await using var conn = await db.OpenAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        foreach (var c in items)
        {
            // "id = id" = não faz nada se já existir (UseAffectedRows: 1 = inserido, 0 = já existia)
            await using var cmd = Cmd(conn, tx, """
                INSERT INTO plan_item (tech_id, tech_name, ticket_id, title, day, position)
                SELECT $1, $2, $3, $4, $5, COALESCE(MAX(position) + 1, 0) FROM plan_item WHERE tech_id = $1 AND day = $5
                ON DUPLICATE KEY UPDATE id = id
                """, c.TechId, Trim(c.TechName), c.TicketId, Trim(c.Title), c.Day);
            if (await cmd.ExecuteNonQueryAsync(ct) == 1) added.Add((c.TechId, c.TicketId, c.Day));
        }
        await tx.CommitAsync(ct);
        return added;
    }

    /// <summary>Move para outro dia (mesmo técnico). Se o ticket já estiver no dia de destino, apenas remove a origem.</summary>
    public async Task<PlanItem?> MoveAsync(long id, PlanMove m, CancellationToken ct)
    {
        await using var conn = await db.OpenAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        PlanItem? cur;
        await using (var get = Cmd(conn, tx, $"SELECT {Cols} FROM plan_item WHERE id = $1 FOR UPDATE", id))
            cur = (await ReadAllAsync(get, ct)).FirstOrDefault();
        if (cur is null) return null;

        PlanItem? dup;
        await using (var q = Cmd(conn, tx, $"SELECT {Cols} FROM plan_item WHERE tech_id = $1 AND ticket_id = $2 AND day = $3 AND id <> $4", cur.TechId, cur.TicketId, m.Day, id))
            dup = (await ReadAllAsync(q, ct)).FirstOrDefault();
        if (dup is not null)
        {
            await using var del = Cmd(conn, tx, "DELETE FROM plan_item WHERE id = $1", id);
            await del.ExecuteNonQueryAsync(ct);
            await tx.CommitAsync(ct);
            return dup;
        }

        var position = m.Position;
        if (position is null)
        {
            await using var mx = Cmd(conn, tx, "SELECT COALESCE(MAX(position) + 1, 0) FROM plan_item WHERE tech_id = $1 AND day = $2 AND id <> $3", cur.TechId, m.Day, id);
            position = Convert.ToInt32(await mx.ExecuteScalarAsync(ct));
        }
        await using (var up = Cmd(conn, tx, "UPDATE plan_item SET day = $2, position = $3, updated_at = UTC_TIMESTAMP(6) WHERE id = $1", id, m.Day, position.Value))
            await up.ExecuteNonQueryAsync(ct);
        PlanItem moved;
        await using (var get = Cmd(conn, tx, $"SELECT {Cols} FROM plan_item WHERE id = $1", id))
            moved = (await ReadAllAsync(get, ct))[0];
        await tx.CommitAsync(ct);
        return moved;
    }

    public async Task<bool> DeleteAsync(long id, CancellationToken ct)
    {
        await using var conn = await db.OpenAsync(ct);
        await using var cmd = Cmd(conn, "DELETE FROM plan_item WHERE id = $1", id);
        return await cmd.ExecuteNonQueryAsync(ct) > 0;
    }

    public async Task<bool> PingAsync(CancellationToken ct)
    {
        try { await using var conn = await db.OpenAsync(ct); await using var c = Cmd(conn, "SELECT 1"); await c.ExecuteScalarAsync(ct); return true; }
        catch (PlanUnavailableException) { return false; }
    }

    private static async Task<List<PlanItem>> ReadAllAsync(MySqlCommand cmd, CancellationToken ct)
    {
        var list = new List<PlanItem>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct)) list.Add(Read(r));
        return list;
    }

    private static string? Trim(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim()[..Math.Min(s.Trim().Length, 500)];
}
