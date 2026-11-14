using GlpiBoard.Api.Config;
using GlpiBoard.Api.Plan;
using Npgsql;
using NpgsqlTypes;

namespace GlpiBoard.Api.Pm;

/// <summary>
/// Gestão de projetos no PostgreSQL (mesmo banco/volume do Planejamento).
/// Hierarquia por "outline": cada tarefa tem seq (ordem no projeto) e level (0..2);
/// o pai é a tarefa anterior mais próxima com level - 1 (como no MS Project).
/// </summary>
public sealed class PmStore(BoardSettings settings, ILogger<PmStore> log) : IAsyncDisposable
{
    public const int MaxLevel = 2;
    public const int MaxAttachmentBytes = 20 * 1024 * 1024;

    private readonly SemaphoreSlim _init = new(1, 1);
    private NpgsqlDataSource? _ds;
    private bool _ready;

    private const string Schema = """
        CREATE TABLE IF NOT EXISTS pm_project (
            id BIGSERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NULL,
            entity_id INT NOT NULL,
            entity_name TEXT NULL,
            start_date DATE NOT NULL,
            end_date DATE NOT NULL,
            glpi_project_id INT NULL,
            glpi_synced_at TIMESTAMPTZ NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS pm_task (
            id BIGSERIAL PRIMARY KEY,
            project_id BIGINT NOT NULL REFERENCES pm_project(id) ON DELETE CASCADE,
            seq INT NOT NULL,
            level SMALLINT NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 2),
            title TEXT NOT NULL,
            description TEXT NULL,
            plan_start DATE NULL, plan_end DATE NULL,
            real_start DATE NULL, real_end DATE NULL,
            status_id INT NOT NULL DEFAULT 1,
            percent INT NOT NULL DEFAULT 0 CHECK (percent BETWEEN 0 AND 100),
            glpi_task_id INT NULL,
            glpi_date_mod TEXT NULL,
            glpi_synced_at TIMESTAMPTZ NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS pm_task_project ON pm_task (project_id, seq);
        CREATE TABLE IF NOT EXISTS pm_task_user (
            task_id BIGINT NOT NULL REFERENCES pm_task(id) ON DELETE CASCADE,
            user_id INT NOT NULL,
            user_name TEXT NULL,
            PRIMARY KEY (task_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS pm_dependency (
            id BIGSERIAL PRIMARY KEY,
            project_id BIGINT NOT NULL REFERENCES pm_project(id) ON DELETE CASCADE,
            pred_id BIGINT NOT NULL REFERENCES pm_task(id) ON DELETE CASCADE,
            succ_id BIGINT NOT NULL REFERENCES pm_task(id) ON DELETE CASCADE,
            type SMALLINT NOT NULL DEFAULT 0 CHECK (type BETWEEN 0 AND 3),
            lag_days INT NOT NULL DEFAULT 0,
            glpi_link_id INT NULL,
            CONSTRAINT pm_dependency_unique UNIQUE (pred_id, succ_id),
            CHECK (pred_id <> succ_id)
        );
        CREATE TABLE IF NOT EXISTS pm_checklist (
            id BIGSERIAL PRIMARY KEY,
            task_id BIGINT NOT NULL REFERENCES pm_task(id) ON DELETE CASCADE,
            text TEXT NOT NULL,
            done BOOLEAN NOT NULL DEFAULT false,
            position INT NOT NULL DEFAULT 0,
            done_at TIMESTAMPTZ NULL
        );
        CREATE INDEX IF NOT EXISTS pm_checklist_task ON pm_checklist (task_id);
        CREATE TABLE IF NOT EXISTS pm_attachment (
            id BIGSERIAL PRIMARY KEY,
            task_id BIGINT NOT NULL REFERENCES pm_task(id) ON DELETE CASCADE,
            file_name TEXT NOT NULL,
            content_type TEXT NULL,
            size INT NOT NULL,
            data BYTEA NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS pm_attachment_task ON pm_attachment (task_id);
        CREATE TABLE IF NOT EXISTS pm_milestone (
            id BIGSERIAL PRIMARY KEY,
            project_id BIGINT NOT NULL REFERENCES pm_project(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            objective TEXT NULL,
            due_date DATE NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS pm_milestone_task (
            milestone_id BIGINT NOT NULL REFERENCES pm_milestone(id) ON DELETE CASCADE,
            task_id BIGINT NOT NULL REFERENCES pm_task(id) ON DELETE CASCADE,
            PRIMARY KEY (milestone_id, task_id)
        );
        """;

    public async Task<NpgsqlDataSource> DbAsync(CancellationToken ct)
    {
        if (!settings.PlanDbConfigured) throw new PlanUnavailableException("Banco não configurado (PLAN_DB_HOST / PLAN_DB_PASSWORD).");
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
            log.LogInformation("Banco da gestão de projetos pronto.");
            return _ds;
        }
        catch (Exception ex) when (ex is NpgsqlException or TimeoutException or System.Net.Sockets.SocketException)
        {
            log.LogWarning(ex, "Banco da gestão de projetos indisponível.");
            throw new PlanUnavailableException("Banco de dados indisponível. Verifique se o container está no ar (docker compose up -d db).", ex);
        }
        finally { _init.Release(); }
    }

    // ---------- leitura ----------

    private const string ProjectCols = "id, name, description, entity_id, entity_name, start_date, end_date, glpi_project_id, glpi_synced_at, updated_at";
    private static PmProject ReadProject(NpgsqlDataReader r) => new(
        r.GetInt64(0), r.GetString(1), N(r, 2), r.GetInt32(3), N(r, 4), r.GetFieldValue<DateOnly>(5), r.GetFieldValue<DateOnly>(6),
        r.IsDBNull(7) ? null : r.GetInt32(7), r.IsDBNull(8) ? null : r.GetFieldValue<DateTimeOffset>(8), r.GetFieldValue<DateTimeOffset>(9));

    private const string TaskCols = "id, project_id, seq, level, title, description, plan_start, plan_end, real_start, real_end, status_id, percent, glpi_task_id, glpi_date_mod, glpi_synced_at, updated_at";
    private static PmTaskRow ReadTask(NpgsqlDataReader r) => new(
        r.GetInt64(0), r.GetInt64(1), r.GetInt32(2), r.GetInt16(3), r.GetString(4), N(r, 5),
        D(r, 6), D(r, 7), D(r, 8), D(r, 9), r.GetInt32(10), r.GetInt32(11),
        r.IsDBNull(12) ? null : r.GetInt32(12), N(r, 13), r.IsDBNull(14) ? null : r.GetFieldValue<DateTimeOffset>(14), r.GetFieldValue<DateTimeOffset>(15));

    public async Task<List<PmProject>> ListProjectsAsync(CancellationToken ct)
    {
        var ds = await DbAsync(ct);
        await using var cmd = ds.CreateCommand($"SELECT {ProjectCols} FROM pm_project ORDER BY start_date DESC, name");
        return await ReadList(cmd, ReadProject, ct);
    }

    public async Task<PmProjectData?> LoadAsync(long projectId, CancellationToken ct)
    {
        var ds = await DbAsync(ct);
        await using var conn = await ds.OpenConnectionAsync(ct);
        PmProject? p;
        await using (var c = new NpgsqlCommand($"SELECT {ProjectCols} FROM pm_project WHERE id = $1", conn))
        { c.Parameters.AddWithValue(projectId); p = (await ReadList(c, ReadProject, ct)).FirstOrDefault(); }
        if (p is null) return null;

        List<PmTaskRow> tasks;
        await using (var c = new NpgsqlCommand($"SELECT {TaskCols} FROM pm_task WHERE project_id = $1 ORDER BY seq, id", conn))
        { c.Parameters.AddWithValue(projectId); tasks = await ReadList(c, ReadTask, ct); }

        var assignees = new Dictionary<long, List<PmPerson>>();
        await using (var c = new NpgsqlCommand("SELECT u.task_id, u.user_id, COALESCE(u.user_name, 'Usuário #' || u.user_id) FROM pm_task_user u JOIN pm_task t ON t.id = u.task_id WHERE t.project_id = $1 ORDER BY 3", conn))
        {
            c.Parameters.AddWithValue(projectId);
            await using var r = await c.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct))
            {
                if (!assignees.TryGetValue(r.GetInt64(0), out var l)) assignees[r.GetInt64(0)] = l = new();
                l.Add(new PmPerson(r.GetInt32(1), r.GetString(2)));
            }
        }

        List<PmDependency> deps;
        await using (var c = new NpgsqlCommand("SELECT id, pred_id, succ_id, type, lag_days, glpi_link_id FROM pm_dependency WHERE project_id = $1 ORDER BY id", conn))
        {
            c.Parameters.AddWithValue(projectId);
            deps = await ReadList(c, r => new PmDependency(r.GetInt64(0), r.GetInt64(1), r.GetInt64(2), r.GetInt16(3), r.GetInt32(4), r.IsDBNull(5) ? null : r.GetInt32(5)), ct);
        }

        List<PmChecklistItem> checklist;
        await using (var c = new NpgsqlCommand("SELECT c.id, c.task_id, c.text, c.done, c.position FROM pm_checklist c JOIN pm_task t ON t.id = c.task_id WHERE t.project_id = $1 ORDER BY c.position, c.id", conn))
        {
            c.Parameters.AddWithValue(projectId);
            checklist = await ReadList(c, r => new PmChecklistItem(r.GetInt64(0), r.GetInt64(1), r.GetString(2), r.GetBoolean(3), r.GetInt32(4)), ct);
        }

        List<PmAttachment> files;
        await using (var c = new NpgsqlCommand("SELECT a.id, a.task_id, a.file_name, a.content_type, a.size, a.created_at FROM pm_attachment a JOIN pm_task t ON t.id = a.task_id WHERE t.project_id = $1 ORDER BY a.created_at", conn))
        {
            c.Parameters.AddWithValue(projectId);
            files = await ReadList(c, r => new PmAttachment(r.GetInt64(0), r.GetInt64(1), r.GetString(2), N(r, 3), r.GetInt32(4), r.GetFieldValue<DateTimeOffset>(5)), ct);
        }

        List<PmMilestoneRow> milestones;
        await using (var c = new NpgsqlCommand("""
            SELECT m.id, m.name, m.objective, m.due_date, COALESCE(array_agg(mt.task_id) FILTER (WHERE mt.task_id IS NOT NULL), '{}')
            FROM pm_milestone m LEFT JOIN pm_milestone_task mt ON mt.milestone_id = m.id
            WHERE m.project_id = $1 GROUP BY m.id ORDER BY m.due_date, m.id
            """, conn))
        {
            c.Parameters.AddWithValue(projectId);
            milestones = await ReadList(c, r => new PmMilestoneRow(r.GetInt64(0), r.GetString(1), N(r, 2), r.GetFieldValue<DateOnly>(3), r.GetFieldValue<long[]>(4).ToList()), ct);
        }

        return new PmProjectData(p, tasks, assignees, deps, checklist, files, milestones);
    }

    /// <summary>Projeto e tarefas de todos os projetos (para a lista com o resumo).</summary>
    public async Task<List<PmProjectData>> LoadAllAsync(CancellationToken ct)
    {
        var list = new List<PmProjectData>();
        foreach (var p in await ListProjectsAsync(ct))
            if (await LoadAsync(p.Id, ct) is { } d) list.Add(d);
        return list;
    }

    public async Task<long?> ProjectOfTaskAsync(long taskId, CancellationToken ct) =>
        await ScalarAsync<long?>("SELECT project_id FROM pm_task WHERE id = $1", ct, taskId);

    public async Task<long?> ProjectOfAsync(string table, long id, CancellationToken ct) => table switch
    {
        "dependency" => await ScalarAsync<long?>("SELECT project_id FROM pm_dependency WHERE id = $1", ct, id),
        "milestone" => await ScalarAsync<long?>("SELECT project_id FROM pm_milestone WHERE id = $1", ct, id),
        "checklist" => await ScalarAsync<long?>("SELECT t.project_id FROM pm_checklist c JOIN pm_task t ON t.id = c.task_id WHERE c.id = $1", ct, id),
        "attachment" => await ScalarAsync<long?>("SELECT t.project_id FROM pm_attachment a JOIN pm_task t ON t.id = a.task_id WHERE a.id = $1", ct, id),
        _ => throw new ArgumentOutOfRangeException(nameof(table)),
    };

    // ---------- projetos ----------

    public async Task<long> CreateProjectAsync(string name, string? description, int entityId, string? entityName, DateOnly start, DateOnly end, CancellationToken ct) =>
        (await ScalarAsync<long?>("INSERT INTO pm_project (name, description, entity_id, entity_name, start_date, end_date) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
            ct, name, (object?)description ?? DBNull.Value, entityId, (object?)entityName ?? DBNull.Value, start, end))!.Value;

    public Task UpdateProjectAsync(long id, string name, string? description, int entityId, string? entityName, DateOnly start, DateOnly end, CancellationToken ct) =>
        ExecAsync("UPDATE pm_project SET name=$2, description=$3, entity_id=$4, entity_name=$5, start_date=$6, end_date=$7, updated_at=now() WHERE id=$1",
            ct, id, name, (object?)description ?? DBNull.Value, entityId, (object?)entityName ?? DBNull.Value, start, end);

    public async Task<bool> DeleteProjectAsync(long id, CancellationToken ct) => await ExecAsync("DELETE FROM pm_project WHERE id = $1", ct, id) > 0;

    public Task SetProjectGlpiAsync(long id, int glpiId, CancellationToken ct) =>
        ExecAsync("UPDATE pm_project SET glpi_project_id = $2, glpi_synced_at = now() WHERE id = $1", ct, id, glpiId);

    public Task ClearProjectGlpiAsync(long id, CancellationToken ct) =>
        ExecAsync("UPDATE pm_project SET glpi_project_id = NULL, glpi_synced_at = NULL WHERE id = $1", ct, id);

    // ---------- tarefas ----------

    /// <summary>Insere depois da subárvore de afterId (mesmo nível), ou no fim do projeto.</summary>
    public async Task<long> InsertTaskAsync(long projectId, string title, long? afterId, CancellationToken ct)
    {
        var data = await LoadAsync(projectId, ct) ?? throw new PmValidationException("Projeto não encontrado.");
        var order = data.Tasks.ToList();
        int index = order.Count, level = 0;
        if (afterId is { } a)
        {
            var i = order.FindIndex(t => t.Id == a);
            if (i < 0) throw new PmValidationException("Tarefa de referência não encontrada.");
            level = order[i].Level;
            index = SubtreeEnd(order, i);
        }
        var ds = await DbAsync(ct);
        await using var conn = await ds.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await using (var shift = new NpgsqlCommand("UPDATE pm_task SET seq = seq + 1 WHERE project_id = $1 AND seq >= $2", conn, tx))
        { shift.Parameters.AddWithValue(projectId); shift.Parameters.AddWithValue(index); await shift.ExecuteNonQueryAsync(ct); }
        long id;
        await using (var ins = new NpgsqlCommand("INSERT INTO pm_task (project_id, seq, level, title) VALUES ($1, $2, $3, $4) RETURNING id", conn, tx))
        {
            ins.Parameters.AddWithValue(projectId); ins.Parameters.AddWithValue(index); ins.Parameters.AddWithValue((short)level); ins.Parameters.AddWithValue(title);
            id = (long)(await ins.ExecuteScalarAsync(ct))!;
        }
        await tx.CommitAsync(ct);
        await RenumberAsync(projectId, ct);
        return id;
    }

    /// <summary>Índice logo após a subárvore da tarefa i (tarefas seguintes com nível maior).</summary>
    public static int SubtreeEnd(List<PmTaskRow> order, int i)
    {
        var j = i + 1;
        while (j < order.Count && order[j].Level > order[i].Level) j++;
        return j;
    }

    /// <summary>Grava ordem e níveis de uma vez (seq = posição na lista).</summary>
    public async Task SaveOutlineAsync(List<(long Id, int Level)> outline, CancellationToken ct)
    {
        if (outline.Count == 0) return;
        var ds = await DbAsync(ct);
        await using var cmd = ds.CreateCommand("""
            UPDATE pm_task t SET seq = x.seq, level = x.lvl,
              updated_at = CASE WHEN t.level <> x.lvl THEN now() ELSE t.updated_at END
            FROM unnest($1::bigint[], $2::int[], $3::smallint[]) AS x(id, seq, lvl) WHERE t.id = x.id
            """);
        cmd.Parameters.AddWithValue(outline.Select(o => o.Id).ToArray());
        cmd.Parameters.AddWithValue(Enumerable.Range(0, outline.Count).ToArray());
        cmd.Parameters.AddWithValue(outline.Select(o => (short)o.Level).ToArray());
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private Task RenumberAsync(long projectId, CancellationToken ct) => ExecAsync("""
        UPDATE pm_task t SET seq = x.rn - 1 FROM (SELECT id, row_number() OVER (ORDER BY seq, id) AS rn FROM pm_task WHERE project_id = $1) x
        WHERE t.id = x.id AND t.seq <> x.rn - 1
        """, ct, projectId);

    public async Task DeleteTasksAsync(long projectId, IEnumerable<long> ids, CancellationToken ct)
    {
        await ExecAsync("DELETE FROM pm_task WHERE id = ANY($1)", ct, ids.ToArray());
        await RenumberAsync(projectId, ct);
    }

    /// <summary>Atualiza os campos editáveis da tarefa (valores finais já validados).</summary>
    public Task UpdateTaskAsync(PmTaskRow t, CancellationToken ct) => ExecAsync("""
        UPDATE pm_task SET title=$2, description=$3, plan_start=$4, plan_end=$5, real_start=$6, real_end=$7, status_id=$8, percent=$9, updated_at=now()
        WHERE id=$1
        """, ct, t.Id, t.Title, (object?)t.Description ?? DBNull.Value, DV(t.PlanStart), DV(t.PlanEnd), DV(t.RealStart), DV(t.RealEnd), t.StatusId, t.Percent);

    /// <summary>Gravação vinda do ITSM: atualiza e marca como sincronizada no mesmo instante.</summary>
    public Task SaveFromGlpiAsync(PmTaskRow t, string? dateMod, CancellationToken ct) => ExecAsync("""
        UPDATE pm_task SET title=$2, description=$3, plan_start=$4, plan_end=$5, real_start=$6, real_end=$7, status_id=$8, percent=$9,
          glpi_date_mod=$10, updated_at=now(), glpi_synced_at=now()
        WHERE id=$1
        """, ct, t.Id, t.Title, (object?)t.Description ?? DBNull.Value, DV(t.PlanStart), DV(t.PlanEnd), DV(t.RealStart), DV(t.RealEnd), t.StatusId, t.Percent,
        (object?)dateMod ?? DBNull.Value);

    public Task MarkTaskSyncedAsync(long id, int glpiId, string? dateMod, CancellationToken ct) => ExecAsync(
        "UPDATE pm_task SET glpi_task_id=$2, glpi_date_mod=$3, glpi_synced_at=greatest(now(), updated_at) WHERE id=$1",
        ct, id, glpiId, (object?)dateMod ?? DBNull.Value);

    public Task ClearTaskGlpiAsync(long id, CancellationToken ct) =>
        ExecAsync("UPDATE pm_task SET glpi_task_id=NULL, glpi_date_mod=NULL, glpi_synced_at=NULL WHERE id=$1", ct, id);

    public Task TouchTasksAsync(IEnumerable<long> ids, CancellationToken ct) =>
        ExecAsync("UPDATE pm_task SET updated_at = now() WHERE id = ANY($1)", ct, ids.ToArray());

    public async Task SetAssigneesAsync(long taskId, IReadOnlyList<PmPerson> people, bool touch, CancellationToken ct)
    {
        var ds = await DbAsync(ct);
        await using var conn = await ds.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await using (var del = new NpgsqlCommand("DELETE FROM pm_task_user WHERE task_id = $1", conn, tx))
        { del.Parameters.AddWithValue(taskId); await del.ExecuteNonQueryAsync(ct); }
        foreach (var p in people.DistinctBy(p => p.Id))
        {
            await using var ins = new NpgsqlCommand("INSERT INTO pm_task_user (task_id, user_id, user_name) VALUES ($1,$2,$3)", conn, tx);
            ins.Parameters.AddWithValue(taskId); ins.Parameters.AddWithValue(p.Id); ins.Parameters.AddWithValue(p.Name);
            await ins.ExecuteNonQueryAsync(ct);
        }
        if (touch)
        {
            await using var t = new NpgsqlCommand("UPDATE pm_task SET updated_at = now() WHERE id = $1", conn, tx);
            t.Parameters.AddWithValue(taskId); await t.ExecuteNonQueryAsync(ct);
        }
        await tx.CommitAsync(ct);
    }

    // ---------- dependências ----------

    public async Task<long> AddDependencyAsync(long projectId, long pred, long succ, int type, int lag, CancellationToken ct)
    {
        var id = await ScalarAsync<long?>("""
            INSERT INTO pm_dependency (project_id, pred_id, succ_id, type, lag_days) VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (pred_id, succ_id) DO UPDATE SET type = EXCLUDED.type, lag_days = EXCLUDED.lag_days RETURNING id
            """, ct, projectId, pred, succ, (short)type, lag);
        await TouchTasksAsync([succ], ct);
        return id!.Value;
    }

    public async Task UpdateDependencyAsync(long id, int type, int lag, CancellationToken ct)
    {
        await ExecAsync("UPDATE pm_dependency SET type=$2, lag_days=$3 WHERE id=$1", ct, id, (short)type, lag);
        await ExecAsync("UPDATE pm_task SET updated_at = now() WHERE id = (SELECT succ_id FROM pm_dependency WHERE id = $1)", ct, id);
    }

    public async Task DeleteDependencyAsync(long id, CancellationToken ct)
    {
        await ExecAsync("UPDATE pm_task SET updated_at = now() WHERE id = (SELECT succ_id FROM pm_dependency WHERE id = $1)", ct, id);
        await ExecAsync("DELETE FROM pm_dependency WHERE id = $1", ct, id);
    }

    public Task SetDependencyGlpiAsync(long id, int? linkId, CancellationToken ct) =>
        ExecAsync("UPDATE pm_dependency SET glpi_link_id = $2 WHERE id = $1", ct, id, (object?)linkId ?? DBNull.Value);

    // ---------- checklist ----------

    public async Task AddChecklistAsync(long taskId, string text, CancellationToken ct)
    {
        await ExecAsync("INSERT INTO pm_checklist (task_id, text, position) VALUES ($1, $2, COALESCE((SELECT max(position) + 1 FROM pm_checklist WHERE task_id = $1), 0))", ct, taskId, text);
        await TouchTasksAsync([taskId], ct);
    }

    public async Task UpdateChecklistAsync(long id, string? text, bool? done, CancellationToken ct)
    {
        await ExecAsync("""
            UPDATE pm_checklist SET text = COALESCE($2, text), done = COALESCE($3, done),
              done_at = CASE WHEN $3 IS NULL THEN done_at WHEN $3 THEN now() ELSE NULL END
            WHERE id = $1
            """, ct, id, (object?)text ?? DBNull.Value, done is null ? DBNull.Value : done.Value);
        await ExecAsync("UPDATE pm_task SET updated_at = now() WHERE id = (SELECT task_id FROM pm_checklist WHERE id = $1)", ct, id);
    }

    public async Task DeleteChecklistAsync(long id, CancellationToken ct)
    {
        await ExecAsync("UPDATE pm_task SET updated_at = now() WHERE id = (SELECT task_id FROM pm_checklist WHERE id = $1)", ct, id);
        await ExecAsync("DELETE FROM pm_checklist WHERE id = $1", ct, id);
    }

    // ---------- anexos ----------

    public Task AddAttachmentAsync(long taskId, string fileName, string? contentType, byte[] data, CancellationToken ct) =>
        ExecAsync("INSERT INTO pm_attachment (task_id, file_name, content_type, size, data) VALUES ($1,$2,$3,$4,$5)",
            ct, taskId, fileName, (object?)contentType ?? DBNull.Value, data.Length, data);

    public async Task<(string Name, string? Type, byte[] Data)?> GetAttachmentAsync(long id, CancellationToken ct)
    {
        var ds = await DbAsync(ct);
        await using var cmd = ds.CreateCommand("SELECT file_name, content_type, data FROM pm_attachment WHERE id = $1");
        cmd.Parameters.AddWithValue(id);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) return null;
        return (r.GetString(0), N(r, 1), r.GetFieldValue<byte[]>(2));
    }

    public Task DeleteAttachmentAsync(long id, CancellationToken ct) => ExecAsync("DELETE FROM pm_attachment WHERE id = $1", ct, id);

    // ---------- marcos ----------

    public async Task<long> SaveMilestoneAsync(long? id, long projectId, string name, string? objective, DateOnly due, IReadOnlyList<long> taskIds, CancellationToken ct)
    {
        var ds = await DbAsync(ct);
        await using var conn = await ds.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        long mid;
        if (id is { } existing)
        {
            await using var up = new NpgsqlCommand("UPDATE pm_milestone SET name=$2, objective=$3, due_date=$4, updated_at=now() WHERE id=$1", conn, tx);
            up.Parameters.AddWithValue(existing); up.Parameters.AddWithValue(name); up.Parameters.AddWithValue((object?)objective ?? DBNull.Value); up.Parameters.AddWithValue(due);
            await up.ExecuteNonQueryAsync(ct);
            await using var del = new NpgsqlCommand("DELETE FROM pm_milestone_task WHERE milestone_id = $1", conn, tx);
            del.Parameters.AddWithValue(existing); await del.ExecuteNonQueryAsync(ct);
            mid = existing;
        }
        else
        {
            await using var ins = new NpgsqlCommand("INSERT INTO pm_milestone (project_id, name, objective, due_date) VALUES ($1,$2,$3,$4) RETURNING id", conn, tx);
            ins.Parameters.AddWithValue(projectId); ins.Parameters.AddWithValue(name); ins.Parameters.AddWithValue((object?)objective ?? DBNull.Value); ins.Parameters.AddWithValue(due);
            mid = (long)(await ins.ExecuteScalarAsync(ct))!;
        }
        await using (var link = new NpgsqlCommand("""
            INSERT INTO pm_milestone_task (milestone_id, task_id)
            SELECT $1, t.id FROM pm_task t WHERE t.id = ANY($2) AND t.project_id = $3 ON CONFLICT DO NOTHING
            """, conn, tx))
        {
            link.Parameters.AddWithValue(mid); link.Parameters.AddWithValue(taskIds.ToArray()); link.Parameters.AddWithValue(projectId);
            await link.ExecuteNonQueryAsync(ct);
        }
        await tx.CommitAsync(ct);
        return mid;
    }

    public Task DeleteMilestoneAsync(long id, CancellationToken ct) => ExecAsync("DELETE FROM pm_milestone WHERE id = $1", ct, id);

    // ---------- helpers ----------

    private static string? N(NpgsqlDataReader r, int i) => r.IsDBNull(i) ? null : r.GetString(i);
    private static DateOnly? D(NpgsqlDataReader r, int i) => r.IsDBNull(i) ? null : r.GetFieldValue<DateOnly>(i);
    private static object DV(DateOnly? d) => d is { } v ? v : DBNull.Value;

    private static async Task<List<T>> ReadList<T>(NpgsqlCommand cmd, Func<NpgsqlDataReader, T> read, CancellationToken ct)
    {
        var list = new List<T>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct)) list.Add(read(r));
        return list;
    }

    private async Task<int> ExecAsync(string sql, CancellationToken ct, params object[] args)
    {
        var ds = await DbAsync(ct);
        await using var cmd = ds.CreateCommand(sql);
        foreach (var a in args) AddParam(cmd, a);
        return await cmd.ExecuteNonQueryAsync(ct);
    }

    private async Task<T?> ScalarAsync<T>(string sql, CancellationToken ct, params object[] args)
    {
        var ds = await DbAsync(ct);
        await using var cmd = ds.CreateCommand(sql);
        foreach (var a in args) AddParam(cmd, a);
        var v = await cmd.ExecuteScalarAsync(ct);
        return v is null or DBNull ? default : (T)Convert.ChangeType(v, Nullable.GetUnderlyingType(typeof(T)) ?? typeof(T));
    }

    /// <summary>DBNull sem tipo quebra o Npgsql em parâmetros posicionais usados em CASE/COALESCE: tipa como texto/boolean.</summary>
    private static void AddParam(NpgsqlCommand cmd, object a)
    {
        if (a is DBNull) { cmd.Parameters.Add(new NpgsqlParameter { Value = DBNull.Value, NpgsqlDbType = NpgsqlDbType.Unknown }); return; }
        cmd.Parameters.AddWithValue(a);
    }

    public async ValueTask DisposeAsync() { if (_ds is not null) await _ds.DisposeAsync(); }
}
