using GlpiBoard.Api.Data;
using GlpiBoard.Api.Plan;
using MySqlConnector;
using static GlpiBoard.Api.Data.AppDb;

namespace GlpiBoard.Api.Pm;

/// <summary>
/// Gestão de projetos no MySQL (mesmo banco do Planejamento; esquema em AppDb).
/// Hierarquia por "outline": cada tarefa tem seq (ordem no projeto) e level (0..2);
/// o pai é a tarefa anterior mais próxima com level - 1 (como no MS Project).
/// </summary>
public sealed class PmStore(AppDb db)
{
    public const int MaxLevel = 2;
    public const int MaxAttachmentBytes = 20 * 1024 * 1024;

    // ---------- leitura ----------

    private const string ProjectCols = "id, name, description, entity_id, entity_name, start_date, end_date, glpi_project_id, glpi_synced_at, updated_at";
    private static PmProject ReadProject(MySqlDataReader r) => new(
        r.GetInt64(0), r.GetString(1), N(r, 2), r.GetInt32(3), N(r, 4), r.GetFieldValue<DateOnly>(5), r.GetFieldValue<DateOnly>(6),
        r.IsDBNull(7) ? null : r.GetInt32(7), r.IsDBNull(8) ? null : PlanStore.Utc(r, 8), PlanStore.Utc(r, 9));

    private const string TaskCols = "id, project_id, seq, level, title, description, plan_start, plan_end, real_start, real_end, status_id, percent, glpi_task_id, glpi_date_mod, glpi_synced_at, updated_at";
    private static PmTaskRow ReadTask(MySqlDataReader r) => new(
        r.GetInt64(0), r.GetInt64(1), r.GetInt32(2), r.GetInt16(3), r.GetString(4), N(r, 5),
        D(r, 6), D(r, 7), D(r, 8), D(r, 9), r.GetInt32(10), r.GetInt32(11),
        r.IsDBNull(12) ? null : r.GetInt32(12), N(r, 13), r.IsDBNull(14) ? null : PlanStore.Utc(r, 14), PlanStore.Utc(r, 15));

    public async Task<List<PmProject>> ListProjectsAsync(CancellationToken ct)
    {
        await using var conn = await db.OpenAsync(ct);
        await using var cmd = Cmd(conn, $"SELECT {ProjectCols} FROM pm_project ORDER BY start_date DESC, name");
        return await ReadList(cmd, ReadProject, ct);
    }

    public async Task<PmProjectData?> LoadAsync(long projectId, CancellationToken ct)
    {
        await using var conn = await db.OpenAsync(ct);
        PmProject? p;
        await using (var c = Cmd(conn, $"SELECT {ProjectCols} FROM pm_project WHERE id = $1", projectId))
            p = (await ReadList(c, ReadProject, ct)).FirstOrDefault();
        if (p is null) return null;

        List<PmTaskRow> tasks;
        await using (var c = Cmd(conn, $"SELECT {TaskCols} FROM pm_task WHERE project_id = $1 ORDER BY seq, id", projectId))
            tasks = await ReadList(c, ReadTask, ct);

        var assignees = new Dictionary<long, List<PmPerson>>();
        await using (var c = Cmd(conn, "SELECT u.task_id, u.user_id, COALESCE(u.user_name, CONCAT('Usuário #', u.user_id)) AS nm FROM pm_task_user u JOIN pm_task t ON t.id = u.task_id WHERE t.project_id = $1 ORDER BY nm", projectId))
        {
            await using var r = await c.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct))
            {
                if (!assignees.TryGetValue(r.GetInt64(0), out var l)) assignees[r.GetInt64(0)] = l = new();
                l.Add(new PmPerson(r.GetInt32(1), r.GetString(2)));
            }
        }

        List<PmDependency> deps;
        await using (var c = Cmd(conn, "SELECT id, pred_id, succ_id, type, lag_days, glpi_link_id FROM pm_dependency WHERE project_id = $1 ORDER BY id", projectId))
            deps = await ReadList(c, r => new PmDependency(r.GetInt64(0), r.GetInt64(1), r.GetInt64(2), r.GetInt16(3), r.GetInt32(4), r.IsDBNull(5) ? null : r.GetInt32(5)), ct);

        List<PmChecklistItem> checklist;
        await using (var c = Cmd(conn, "SELECT c.id, c.task_id, c.text, c.done, c.position FROM pm_checklist c JOIN pm_task t ON t.id = c.task_id WHERE t.project_id = $1 ORDER BY c.position, c.id", projectId))
            checklist = await ReadList(c, r => new PmChecklistItem(r.GetInt64(0), r.GetInt64(1), r.GetString(2), r.GetBoolean(3), r.GetInt32(4)), ct);

        List<PmAttachment> files;
        await using (var c = Cmd(conn, "SELECT a.id, a.task_id, a.file_name, a.content_type, a.size, a.created_at FROM pm_attachment a JOIN pm_task t ON t.id = a.task_id WHERE t.project_id = $1 ORDER BY a.created_at, a.id", projectId))
            files = await ReadList(c, r => new PmAttachment(r.GetInt64(0), r.GetInt64(1), r.GetString(2), N(r, 3), r.GetInt32(4), PlanStore.Utc(r, 5)), ct);

        List<PmMilestoneRow> milestones;
        await using (var c = Cmd(conn, """
            SELECT m.id, m.name, m.objective, m.due_date, GROUP_CONCAT(mt.task_id ORDER BY mt.task_id SEPARATOR ',')
            FROM pm_milestone m LEFT JOIN pm_milestone_task mt ON mt.milestone_id = m.id
            WHERE m.project_id = $1 GROUP BY m.id, m.name, m.objective, m.due_date ORDER BY m.due_date, m.id
            """, projectId))
        {
            milestones = await ReadList(c, r => new PmMilestoneRow(r.GetInt64(0), r.GetString(1), N(r, 2), r.GetFieldValue<DateOnly>(3),
                r.IsDBNull(4) ? new List<long>() : r.GetString(4).Split(',', StringSplitOptions.RemoveEmptyEntries).Select(long.Parse).ToList()), ct);
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

    public Task<long> CreateProjectAsync(string name, string? description, int entityId, string? entityName, DateOnly start, DateOnly end, CancellationToken ct) =>
        InsertAsync("INSERT INTO pm_project (name, description, entity_id, entity_name, start_date, end_date) VALUES ($1,$2,$3,$4,$5,$6)",
            ct, name, description, entityId, entityName, start, end);

    public Task UpdateProjectAsync(long id, string name, string? description, int entityId, string? entityName, DateOnly start, DateOnly end, CancellationToken ct) =>
        ExecAsync("UPDATE pm_project SET name=$2, description=$3, entity_id=$4, entity_name=$5, start_date=$6, end_date=$7, updated_at=UTC_TIMESTAMP(6) WHERE id=$1",
            ct, id, name, description, entityId, entityName, start, end);

    public async Task<bool> DeleteProjectAsync(long id, CancellationToken ct) => await ExecAsync("DELETE FROM pm_project WHERE id = $1", ct, id) > 0;

    public Task SetProjectGlpiAsync(long id, int glpiId, CancellationToken ct) =>
        ExecAsync("UPDATE pm_project SET glpi_project_id = $2, glpi_synced_at = UTC_TIMESTAMP(6) WHERE id = $1", ct, id, glpiId);

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
        await using var conn = await db.OpenAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await using (var shift = Cmd(conn, tx, "UPDATE pm_task SET seq = seq + 1 WHERE project_id = $1 AND seq >= $2", projectId, index))
            await shift.ExecuteNonQueryAsync(ct);
        long id;
        await using (var ins = Cmd(conn, tx, "INSERT INTO pm_task (project_id, seq, level, title) VALUES ($1, $2, $3, $4)", projectId, index, (short)level, title))
        {
            await ins.ExecuteNonQueryAsync(ct);
            id = ins.LastInsertedId;
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
        await using var conn = await db.OpenAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        for (var i = 0; i < outline.Count; i++)
        {
            // MySQL avalia as atribuições da esquerda para a direita: updated_at compara com o level ANTES da troca
            await using var cmd = Cmd(conn, tx, """
                UPDATE pm_task SET updated_at = CASE WHEN level <> $3 THEN UTC_TIMESTAMP(6) ELSE updated_at END, seq = $2, level = $3
                WHERE id = $1
                """, outline[i].Id, i, (short)outline[i].Level);
            await cmd.ExecuteNonQueryAsync(ct);
        }
        await tx.CommitAsync(ct);
    }

    private Task RenumberAsync(long projectId, CancellationToken ct) => ExecAsync("""
        UPDATE pm_task t JOIN (SELECT id, ROW_NUMBER() OVER (ORDER BY seq, id) AS rn FROM pm_task WHERE project_id = $1) x ON t.id = x.id
        SET t.seq = x.rn - 1 WHERE t.seq <> x.rn - 1
        """, ct, projectId);

    public async Task DeleteTasksAsync(long projectId, IEnumerable<long> ids, CancellationToken ct)
    {
        await ExecAsync("DELETE FROM pm_task WHERE id IN ($1)", ct, ids.ToArray());
        await RenumberAsync(projectId, ct);
    }

    /// <summary>Atualiza os campos editáveis da tarefa (valores finais já validados).</summary>
    public Task UpdateTaskAsync(PmTaskRow t, CancellationToken ct) => ExecAsync("""
        UPDATE pm_task SET title=$2, description=$3, plan_start=$4, plan_end=$5, real_start=$6, real_end=$7, status_id=$8, percent=$9, updated_at=UTC_TIMESTAMP(6)
        WHERE id=$1
        """, ct, t.Id, t.Title, t.Description, t.PlanStart, t.PlanEnd, t.RealStart, t.RealEnd, t.StatusId, t.Percent);

    /// <summary>Gravação vinda do ITSM: atualiza e marca como sincronizada no mesmo instante.</summary>
    public Task SaveFromGlpiAsync(PmTaskRow t, string? dateMod, CancellationToken ct) => ExecAsync("""
        UPDATE pm_task SET title=$2, description=$3, plan_start=$4, plan_end=$5, real_start=$6, real_end=$7, status_id=$8, percent=$9,
          glpi_date_mod=$10, updated_at=UTC_TIMESTAMP(6), glpi_synced_at=UTC_TIMESTAMP(6)
        WHERE id=$1
        """, ct, t.Id, t.Title, t.Description, t.PlanStart, t.PlanEnd, t.RealStart, t.RealEnd, t.StatusId, t.Percent, dateMod);

    public Task MarkTaskSyncedAsync(long id, int glpiId, string? dateMod, CancellationToken ct) => ExecAsync(
        "UPDATE pm_task SET glpi_task_id=$2, glpi_date_mod=$3, glpi_synced_at=GREATEST(UTC_TIMESTAMP(6), updated_at) WHERE id=$1",
        ct, id, glpiId, dateMod);

    public Task ClearTaskGlpiAsync(long id, CancellationToken ct) =>
        ExecAsync("UPDATE pm_task SET glpi_task_id=NULL, glpi_date_mod=NULL, glpi_synced_at=NULL WHERE id=$1", ct, id);

    public Task TouchTasksAsync(IEnumerable<long> ids, CancellationToken ct) =>
        ExecAsync("UPDATE pm_task SET updated_at = UTC_TIMESTAMP(6) WHERE id IN ($1)", ct, ids.ToArray());

    public async Task SetAssigneesAsync(long taskId, IReadOnlyList<PmPerson> people, bool touch, CancellationToken ct)
    {
        await using var conn = await db.OpenAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await using (var del = Cmd(conn, tx, "DELETE FROM pm_task_user WHERE task_id = $1", taskId))
            await del.ExecuteNonQueryAsync(ct);
        foreach (var p in people.DistinctBy(p => p.Id))
        {
            await using var ins = Cmd(conn, tx, "INSERT INTO pm_task_user (task_id, user_id, user_name) VALUES ($1,$2,$3)", taskId, p.Id, p.Name);
            await ins.ExecuteNonQueryAsync(ct);
        }
        if (touch)
        {
            await using var t = Cmd(conn, tx, "UPDATE pm_task SET updated_at = UTC_TIMESTAMP(6) WHERE id = $1", taskId);
            await t.ExecuteNonQueryAsync(ct);
        }
        await tx.CommitAsync(ct);
    }

    // ---------- dependências ----------

    public async Task<long> AddDependencyAsync(long projectId, long pred, long succ, int type, int lag, CancellationToken ct)
    {
        // LAST_INSERT_ID(id): devolve o id também quando a dependência já existia (atualização)
        var id = await InsertAsync("""
            INSERT INTO pm_dependency (project_id, pred_id, succ_id, type, lag_days) VALUES ($1,$2,$3,$4,$5)
            ON DUPLICATE KEY UPDATE type = VALUES(type), lag_days = VALUES(lag_days), id = LAST_INSERT_ID(id)
            """, ct, projectId, pred, succ, (short)type, lag);
        await TouchTasksAsync([succ], ct);
        return id;
    }

    public async Task UpdateDependencyAsync(long id, int type, int lag, CancellationToken ct)
    {
        await ExecAsync("UPDATE pm_dependency SET type=$2, lag_days=$3 WHERE id=$1", ct, id, (short)type, lag);
        await ExecAsync("UPDATE pm_task SET updated_at = UTC_TIMESTAMP(6) WHERE id = (SELECT succ_id FROM pm_dependency WHERE id = $1)", ct, id);
    }

    public async Task DeleteDependencyAsync(long id, CancellationToken ct)
    {
        await ExecAsync("UPDATE pm_task SET updated_at = UTC_TIMESTAMP(6) WHERE id = (SELECT succ_id FROM pm_dependency WHERE id = $1)", ct, id);
        await ExecAsync("DELETE FROM pm_dependency WHERE id = $1", ct, id);
    }

    public Task SetDependencyGlpiAsync(long id, int? linkId, CancellationToken ct) =>
        ExecAsync("UPDATE pm_dependency SET glpi_link_id = $2 WHERE id = $1", ct, id, linkId);

    // ---------- checklist ----------

    public async Task AddChecklistAsync(long taskId, string text, CancellationToken ct)
    {
        await ExecAsync("INSERT INTO pm_checklist (task_id, text, position) SELECT $1, $2, COALESCE(MAX(position) + 1, 0) FROM pm_checklist WHERE task_id = $1", ct, taskId, text);
        await TouchTasksAsync([taskId], ct);
    }

    public async Task UpdateChecklistAsync(long id, string? text, bool? done, CancellationToken ct)
    {
        // done_at antes de done (atribuições da esquerda para a direita)
        await ExecAsync("""
            UPDATE pm_checklist SET text = COALESCE($2, text),
              done_at = CASE WHEN $3 IS NULL THEN done_at WHEN $3 THEN UTC_TIMESTAMP(6) ELSE NULL END,
              done = COALESCE($3, done)
            WHERE id = $1
            """, ct, id, text, done);
        await ExecAsync("UPDATE pm_task SET updated_at = UTC_TIMESTAMP(6) WHERE id = (SELECT task_id FROM pm_checklist WHERE id = $1)", ct, id);
    }

    public async Task DeleteChecklistAsync(long id, CancellationToken ct)
    {
        await ExecAsync("UPDATE pm_task SET updated_at = UTC_TIMESTAMP(6) WHERE id = (SELECT task_id FROM pm_checklist WHERE id = $1)", ct, id);
        await ExecAsync("DELETE FROM pm_checklist WHERE id = $1", ct, id);
    }

    // ---------- anexos ----------

    public Task AddAttachmentAsync(long taskId, string fileName, string? contentType, byte[] data, CancellationToken ct) =>
        ExecAsync("INSERT INTO pm_attachment (task_id, file_name, content_type, size, data) VALUES ($1,$2,$3,$4,$5)",
            ct, taskId, fileName, contentType, data.Length, data);

    public async Task<(string Name, string? Type, byte[] Data)?> GetAttachmentAsync(long id, CancellationToken ct)
    {
        await using var conn = await db.OpenAsync(ct);
        await using var cmd = Cmd(conn, "SELECT file_name, content_type, data FROM pm_attachment WHERE id = $1", id);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) return null;
        return (r.GetString(0), N(r, 1), r.GetFieldValue<byte[]>(2));
    }

    public Task DeleteAttachmentAsync(long id, CancellationToken ct) => ExecAsync("DELETE FROM pm_attachment WHERE id = $1", ct, id);

    // ---------- marcos ----------

    public async Task<long> SaveMilestoneAsync(long? id, long projectId, string name, string? objective, DateOnly due, IReadOnlyList<long> taskIds, CancellationToken ct)
    {
        await using var conn = await db.OpenAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        long mid;
        if (id is { } existing)
        {
            await using (var up = Cmd(conn, tx, "UPDATE pm_milestone SET name=$2, objective=$3, due_date=$4, updated_at=UTC_TIMESTAMP(6) WHERE id=$1", existing, name, objective, due))
                await up.ExecuteNonQueryAsync(ct);
            await using (var del = Cmd(conn, tx, "DELETE FROM pm_milestone_task WHERE milestone_id = $1", existing))
                await del.ExecuteNonQueryAsync(ct);
            mid = existing;
        }
        else
        {
            await using var ins = Cmd(conn, tx, "INSERT INTO pm_milestone (project_id, name, objective, due_date) VALUES ($1,$2,$3,$4)", projectId, name, objective, due);
            await ins.ExecuteNonQueryAsync(ct);
            mid = ins.LastInsertedId;
        }
        if (taskIds.Count > 0)
        {
            await using var link = Cmd(conn, tx, """
                INSERT INTO pm_milestone_task (milestone_id, task_id)
                SELECT $1, t.id FROM pm_task t WHERE t.id IN ($2) AND t.project_id = $3
                ON DUPLICATE KEY UPDATE task_id = pm_milestone_task.task_id
                """, mid, taskIds.ToArray(), projectId);
            await link.ExecuteNonQueryAsync(ct);
        }
        await tx.CommitAsync(ct);
        return mid;
    }

    public Task DeleteMilestoneAsync(long id, CancellationToken ct) => ExecAsync("DELETE FROM pm_milestone WHERE id = $1", ct, id);

    // ---------- helpers ----------

    private static string? N(MySqlDataReader r, int i) => r.IsDBNull(i) ? null : r.GetString(i);
    private static DateOnly? D(MySqlDataReader r, int i) => r.IsDBNull(i) ? null : r.GetFieldValue<DateOnly>(i);

    private static async Task<List<T>> ReadList<T>(MySqlCommand cmd, Func<MySqlDataReader, T> read, CancellationToken ct)
    {
        var list = new List<T>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct)) list.Add(read(r));
        return list;
    }

    private async Task<int> ExecAsync(string sql, CancellationToken ct, params object?[] args)
    {
        if (args.Any(a => a is System.Collections.ICollection { Count: 0 } and not byte[])) return 0; // IN () vazio
        await using var conn = await db.OpenAsync(ct);
        await using var cmd = Cmd(conn, sql, args);
        return await cmd.ExecuteNonQueryAsync(ct);
    }

    private async Task<long> InsertAsync(string sql, CancellationToken ct, params object?[] args)
    {
        await using var conn = await db.OpenAsync(ct);
        await using var cmd = Cmd(conn, sql, args);
        await cmd.ExecuteNonQueryAsync(ct);
        return cmd.LastInsertedId;
    }

    private async Task<T?> ScalarAsync<T>(string sql, CancellationToken ct, params object?[] args)
    {
        await using var conn = await db.OpenAsync(ct);
        await using var cmd = Cmd(conn, sql, args);
        var v = await cmd.ExecuteScalarAsync(ct);
        return v is null or DBNull ? default : (T)Convert.ChangeType(v, Nullable.GetUnderlyingType(typeof(T)) ?? typeof(T));
    }
}
