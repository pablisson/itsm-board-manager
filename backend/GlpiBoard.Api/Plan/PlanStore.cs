using GlpiBoard.Api.Config;
using Npgsql;

namespace GlpiBoard.Api.Plan;

/// <summary>Um ticket planejado para um técnico em um dia.</summary>
public sealed record PlanItem(long Id, int TechId, string? TechName, int TicketId, string? Title, DateOnly Day, int Position, DateTimeOffset UpdatedAtUtc);

public sealed record PlanCreate(int TechId, string? TechName, int TicketId, string? Title, DateOnly Day);
public sealed record PlanMove(DateOnly Day, int? Position);

public sealed class PlanUnavailableException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>
/// Planejamento por técnico/dia guardado no PostgreSQL (volume Docker persistente).
/// O esquema é criado/atualizado na primeira utilização.
/// </summary>
public sealed class PlanStore(BoardSettings settings, ILogger<PlanStore> log) : IAsyncDisposable
{
    private readonly SemaphoreSlim _init = new(1, 1);
    private NpgsqlDataSource? _ds;
    private bool _ready;

    private const string Schema = """
        CREATE TABLE IF NOT EXISTS plan_item (
            id          BIGSERIAL PRIMARY KEY,
            tech_id     INT          NOT NULL,
            tech_name   TEXT         NULL,
            ticket_id   INT          NOT NULL,
            title       TEXT         NULL,
            day         DATE         NOT NULL,
            position    INT          NOT NULL DEFAULT 0,
            created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
            updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
            CONSTRAINT plan_item_unique UNIQUE (tech_id, ticket_id, day)
        );
        CREATE INDEX IF NOT EXISTS plan_item_day ON plan_item (day);
        """;

    public bool Configured => settings.PlanDbConfigured;

    private async Task<NpgsqlDataSource> DataSourceAsync(CancellationToken ct)
    {
        if (!Configured) throw new PlanUnavailableException("Banco do planejamento não configurado (PLAN_DB_HOST / PLAN_DB_PASSWORD).");
        if (_ready) return _ds!;
        await _init.WaitAsync(ct);
        try
        {
            if (_ready) return _ds!;
            _ds ??= new NpgsqlDataSourceBuilder(new NpgsqlConnectionStringBuilder
            {
                Host = settings.PlanDbHost, Port = settings.PlanDbPort, Database = settings.PlanDbName,
                Username = settings.PlanDbUser, Password = settings.PlanDbPassword, Timeout = 5,
            }.ConnectionString).Build();
            await using var cmd = _ds.CreateCommand(Schema);
            await cmd.ExecuteNonQueryAsync(ct);
            _ready = true;
            log.LogInformation("Banco do planejamento pronto ({Host}:{Port}/{Db}).", settings.PlanDbHost, settings.PlanDbPort, settings.PlanDbName);
            return _ds;
        }
        catch (Exception ex) when (ex is NpgsqlException or TimeoutException or System.Net.Sockets.SocketException)
        {
            log.LogWarning(ex, "Banco do planejamento indisponível.");
            throw new PlanUnavailableException("Banco do planejamento indisponível. Verifique se o container está no ar (docker compose up -d db).", ex);
        }
        finally { _init.Release(); }
    }

    private const string Cols = "id, tech_id, tech_name, ticket_id, title, day, position, updated_at";
    private static PlanItem Read(NpgsqlDataReader r) => new(
        r.GetInt64(0), r.GetInt32(1), r.IsDBNull(2) ? null : r.GetString(2), r.GetInt32(3), r.IsDBNull(4) ? null : r.GetString(4),
        r.GetFieldValue<DateOnly>(5), r.GetInt32(6), r.GetFieldValue<DateTimeOffset>(7));

    public async Task<List<PlanItem>> ListAsync(DateOnly from, DateOnly to, CancellationToken ct)
    {
        var ds = await DataSourceAsync(ct);
        await using var cmd = ds.CreateCommand($"SELECT {Cols} FROM plan_item WHERE day BETWEEN $1 AND $2 ORDER BY day, tech_id, position, id");
        cmd.Parameters.AddWithValue(from); cmd.Parameters.AddWithValue(to);
        return await ReadAllAsync(cmd, ct);
    }

    /// <summary>Quantos dias planejados cada ticket tem (todas as datas), por técnico.</summary>
    public async Task<List<(int TechId, int TicketId, int Days, DateOnly Next)>> CountsAsync(DateOnly today, CancellationToken ct)
    {
        var ds = await DataSourceAsync(ct);
        await using var cmd = ds.CreateCommand(
            "SELECT tech_id, ticket_id, count(*)::int, COALESCE(min(day) FILTER (WHERE day >= $1), max(day)) FROM plan_item GROUP BY tech_id, ticket_id");
        cmd.Parameters.AddWithValue(today);
        var list = new List<(int, int, int, DateOnly)>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct)) list.Add((r.GetInt32(0), r.GetInt32(1), r.GetInt32(2), r.GetFieldValue<DateOnly>(3)));
        return list;
    }

    /// <summary>Planeja o ticket no dia (no fim da célula). Se já existir no mesmo dia/técnico, devolve o existente.</summary>
    public async Task<PlanItem> AddAsync(PlanCreate c, CancellationToken ct)
    {
        var ds = await DataSourceAsync(ct);
        await using var cmd = ds.CreateCommand($"""
            INSERT INTO plan_item (tech_id, tech_name, ticket_id, title, day, position)
            VALUES ($1, $2, $3, $4, $5, COALESCE((SELECT max(position) + 1 FROM plan_item WHERE tech_id = $1 AND day = $5), 0))
            ON CONFLICT (tech_id, ticket_id, day) DO UPDATE SET title = COALESCE(EXCLUDED.title, plan_item.title), updated_at = now()
            RETURNING {Cols}
            """);
        cmd.Parameters.AddWithValue(c.TechId); cmd.Parameters.AddWithValue((object?)Trim(c.TechName) ?? DBNull.Value);
        cmd.Parameters.AddWithValue(c.TicketId); cmd.Parameters.AddWithValue((object?)Trim(c.Title) ?? DBNull.Value);
        cmd.Parameters.AddWithValue(c.Day);
        return (await ReadAllAsync(cmd, ct))[0];
    }

    /// <summary>Insere vários itens de uma vez; os que já existem (técnico+ticket+dia) ficam como estão. Devolve as chaves inseridas.</summary>
    public async Task<HashSet<(int TechId, int TicketId, DateOnly Day)>> ImportAsync(IReadOnlyList<PlanCreate> items, CancellationToken ct)
    {
        var added = new HashSet<(int, int, DateOnly)>();
        if (items.Count == 0) return added;
        var ds = await DataSourceAsync(ct);
        await using var conn = await ds.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        foreach (var c in items)
        {
            await using var cmd = new NpgsqlCommand("""
                INSERT INTO plan_item (tech_id, tech_name, ticket_id, title, day, position)
                VALUES ($1, $2, $3, $4, $5, COALESCE((SELECT max(position) + 1 FROM plan_item WHERE tech_id = $1 AND day = $5), 0))
                ON CONFLICT (tech_id, ticket_id, day) DO NOTHING
                """, conn, tx);
            cmd.Parameters.AddWithValue(c.TechId); cmd.Parameters.AddWithValue((object?)Trim(c.TechName) ?? DBNull.Value);
            cmd.Parameters.AddWithValue(c.TicketId); cmd.Parameters.AddWithValue((object?)Trim(c.Title) ?? DBNull.Value);
            cmd.Parameters.AddWithValue(c.Day);
            if (await cmd.ExecuteNonQueryAsync(ct) > 0) added.Add((c.TechId, c.TicketId, c.Day));
        }
        await tx.CommitAsync(ct);
        return added;
    }

    /// <summary>Move para outro dia (mesmo técnico). Se o ticket já estiver no dia de destino, apenas remove a origem.</summary>
    public async Task<PlanItem?> MoveAsync(long id, PlanMove m, CancellationToken ct)
    {
        var ds = await DataSourceAsync(ct);
        await using var conn = await ds.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        PlanItem? cur;
        await using (var get = new NpgsqlCommand($"SELECT {Cols} FROM plan_item WHERE id = $1 FOR UPDATE", conn, tx))
        {
            get.Parameters.AddWithValue(id);
            cur = (await ReadAllAsync(get, ct)).FirstOrDefault();
        }
        if (cur is null) return null;

        PlanItem? dup;
        await using (var q = new NpgsqlCommand($"SELECT {Cols} FROM plan_item WHERE tech_id = $1 AND ticket_id = $2 AND day = $3 AND id <> $4", conn, tx))
        {
            q.Parameters.AddWithValue(cur.TechId); q.Parameters.AddWithValue(cur.TicketId); q.Parameters.AddWithValue(m.Day); q.Parameters.AddWithValue(id);
            dup = (await ReadAllAsync(q, ct)).FirstOrDefault();
        }
        if (dup is not null)
        {
            await using var del = new NpgsqlCommand("DELETE FROM plan_item WHERE id = $1", conn, tx);
            del.Parameters.AddWithValue(id); await del.ExecuteNonQueryAsync(ct);
            await tx.CommitAsync(ct);
            return dup;
        }

        PlanItem moved;
        await using (var up = new NpgsqlCommand($"""
            UPDATE plan_item SET day = $2, updated_at = now(),
              position = COALESCE($3, (SELECT COALESCE(max(position) + 1, 0) FROM plan_item WHERE tech_id = $4 AND day = $2 AND id <> $1))
            WHERE id = $1 RETURNING {Cols}
            """, conn, tx))
        {
            up.Parameters.AddWithValue(id); up.Parameters.AddWithValue(m.Day);
            up.Parameters.AddWithValue((object?)m.Position ?? DBNull.Value).NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Integer;
            up.Parameters.AddWithValue(cur.TechId);
            moved = (await ReadAllAsync(up, ct))[0];
        }
        await tx.CommitAsync(ct);
        return moved;
    }

    public async Task<bool> DeleteAsync(long id, CancellationToken ct)
    {
        var ds = await DataSourceAsync(ct);
        await using var cmd = ds.CreateCommand("DELETE FROM plan_item WHERE id = $1");
        cmd.Parameters.AddWithValue(id);
        return await cmd.ExecuteNonQueryAsync(ct) > 0;
    }

    public async Task<bool> PingAsync(CancellationToken ct)
    {
        try { var ds = await DataSourceAsync(ct); await using var c = ds.CreateCommand("SELECT 1"); await c.ExecuteScalarAsync(ct); return true; }
        catch (PlanUnavailableException) { return false; }
    }

    private static async Task<List<PlanItem>> ReadAllAsync(NpgsqlCommand cmd, CancellationToken ct)
    {
        var list = new List<PlanItem>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct)) list.Add(Read(r));
        return list;
    }

    private static string? Trim(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim()[..Math.Min(s.Trim().Length, 500)];

    public async ValueTask DisposeAsync() { if (_ds is not null) await _ds.DisposeAsync(); }
}
