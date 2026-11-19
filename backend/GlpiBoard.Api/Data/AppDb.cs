using System.Text.RegularExpressions;
using GlpiBoard.Api.Config;
using GlpiBoard.Api.Plan;
using MySqlConnector;

namespace GlpiBoard.Api.Data;

/// <summary>
/// Banco do sistema (MySQL 8): Planejamento + Gestão de Projetos.
/// O esquema é criado na primeira utilização. Datas/horas são gravadas em UTC (DATETIME(6), sessão em +00:00).
/// </summary>
public sealed partial class AppDb(BoardSettings settings, ILogger<AppDb> log) : IAsyncDisposable
{
    private readonly SemaphoreSlim _init = new(1, 1);
    private MySqlDataSource? _ds;
    private bool _ready;

    /// <summary>Tabelas na ordem das chaves estrangeiras (pais antes dos filhos).</summary>
    public static readonly string[] Tables =
        ["plan_item", "pm_project", "pm_task", "pm_task_user", "pm_dependency", "pm_checklist", "pm_attachment", "pm_milestone", "pm_milestone_task"];

    private const string Opts = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci";

    // Observação: o MySQL não aceita CHECK em colunas usadas por FK com ON DELETE CASCADE,
    // por isso "pred_id <> succ_id" (pm_dependency) é garantido só pela aplicação (PmService).
    private static readonly string[] Schema =
    [
        $"""
        CREATE TABLE IF NOT EXISTS plan_item (
            id          BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
            tech_id     INT          NOT NULL,
            tech_name   TEXT         NULL,
            ticket_id   INT          NOT NULL,
            title       TEXT         NULL,
            day         DATE         NOT NULL,
            position    INT          NOT NULL DEFAULT 0,
            created_at  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
            updated_at  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
            CONSTRAINT plan_item_unique UNIQUE (tech_id, ticket_id, day),
            INDEX plan_item_day (day)
        ) {Opts}
        """,
        $"""
        CREATE TABLE IF NOT EXISTS pm_project (
            id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            name TEXT NOT NULL,
            description MEDIUMTEXT NULL,
            entity_id INT NOT NULL,
            entity_name TEXT NULL,
            start_date DATE NOT NULL,
            end_date DATE NOT NULL,
            glpi_project_id INT NULL,
            glpi_synced_at DATETIME(6) NULL,
            created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
            updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ) {Opts}
        """,
        $"""
        CREATE TABLE IF NOT EXISTS pm_task (
            id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            project_id BIGINT NOT NULL,
            seq INT NOT NULL,
            level SMALLINT NOT NULL DEFAULT 0,
            title TEXT NOT NULL,
            description MEDIUMTEXT NULL,
            plan_start DATE NULL, plan_end DATE NULL,
            real_start DATE NULL, real_end DATE NULL,
            status_id INT NOT NULL DEFAULT 1,
            percent INT NOT NULL DEFAULT 0,
            glpi_task_id INT NULL,
            glpi_date_mod TEXT NULL,
            glpi_synced_at DATETIME(6) NULL,
            created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
            updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
            INDEX pm_task_project (project_id, seq),
            CONSTRAINT pm_task_level_check CHECK (level BETWEEN 0 AND 2),
            CONSTRAINT pm_task_percent_check CHECK (percent BETWEEN 0 AND 100),
            CONSTRAINT pm_task_project_fk FOREIGN KEY (project_id) REFERENCES pm_project(id) ON DELETE CASCADE
        ) {Opts}
        """,
        $"""
        CREATE TABLE IF NOT EXISTS pm_task_user (
            task_id BIGINT NOT NULL,
            user_id INT NOT NULL,
            user_name TEXT NULL,
            PRIMARY KEY (task_id, user_id),
            CONSTRAINT pm_task_user_task_fk FOREIGN KEY (task_id) REFERENCES pm_task(id) ON DELETE CASCADE
        ) {Opts}
        """,
        $"""
        CREATE TABLE IF NOT EXISTS pm_dependency (
            id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            project_id BIGINT NOT NULL,
            pred_id BIGINT NOT NULL,
            succ_id BIGINT NOT NULL,
            type SMALLINT NOT NULL DEFAULT 0,
            lag_days INT NOT NULL DEFAULT 0,
            glpi_link_id INT NULL,
            CONSTRAINT pm_dependency_unique UNIQUE (pred_id, succ_id),
            CONSTRAINT pm_dependency_type_check CHECK (type BETWEEN 0 AND 3),
            CONSTRAINT pm_dependency_project_fk FOREIGN KEY (project_id) REFERENCES pm_project(id) ON DELETE CASCADE,
            CONSTRAINT pm_dependency_pred_fk FOREIGN KEY (pred_id) REFERENCES pm_task(id) ON DELETE CASCADE,
            CONSTRAINT pm_dependency_succ_fk FOREIGN KEY (succ_id) REFERENCES pm_task(id) ON DELETE CASCADE
        ) {Opts}
        """,
        $"""
        CREATE TABLE IF NOT EXISTS pm_checklist (
            id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            task_id BIGINT NOT NULL,
            text TEXT NOT NULL,
            done BOOLEAN NOT NULL DEFAULT FALSE,
            position INT NOT NULL DEFAULT 0,
            done_at DATETIME(6) NULL,
            INDEX pm_checklist_task (task_id),
            CONSTRAINT pm_checklist_task_fk FOREIGN KEY (task_id) REFERENCES pm_task(id) ON DELETE CASCADE
        ) {Opts}
        """,
        $"""
        CREATE TABLE IF NOT EXISTS pm_attachment (
            id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            task_id BIGINT NOT NULL,
            file_name TEXT NOT NULL,
            content_type TEXT NULL,
            size INT NOT NULL,
            data LONGBLOB NOT NULL,
            created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
            INDEX pm_attachment_task (task_id),
            CONSTRAINT pm_attachment_task_fk FOREIGN KEY (task_id) REFERENCES pm_task(id) ON DELETE CASCADE
        ) {Opts}
        """,
        $"""
        CREATE TABLE IF NOT EXISTS pm_milestone (
            id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            project_id BIGINT NOT NULL,
            name TEXT NOT NULL,
            objective MEDIUMTEXT NULL,
            due_date DATE NOT NULL,
            created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
            updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
            CONSTRAINT pm_milestone_project_fk FOREIGN KEY (project_id) REFERENCES pm_project(id) ON DELETE CASCADE
        ) {Opts}
        """,
        $"""
        CREATE TABLE IF NOT EXISTS pm_milestone_task (
            milestone_id BIGINT NOT NULL,
            task_id BIGINT NOT NULL,
            PRIMARY KEY (milestone_id, task_id),
            CONSTRAINT pm_milestone_task_ms_fk FOREIGN KEY (milestone_id) REFERENCES pm_milestone(id) ON DELETE CASCADE,
            CONSTRAINT pm_milestone_task_task_fk FOREIGN KEY (task_id) REFERENCES pm_task(id) ON DELETE CASCADE
        ) {Opts}
        """,
        // metadados da própria base (ex.: quando a aplicação passou a usar este banco)
        $"""
        CREATE TABLE IF NOT EXISTS db_meta (
            k VARCHAR(64) NOT NULL PRIMARY KEY,
            v TEXT NULL,
            updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ) {Opts}
        """,
    ];

    public bool Configured => settings.PlanDbConfigured;

    public string ConnectionString => new MySqlConnectionStringBuilder
    {
        Server = settings.PlanDbHost, Port = (uint)settings.PlanDbPort, Database = settings.PlanDbName,
        UserID = settings.PlanDbUser, Password = settings.PlanDbPassword,
        ConnectionTimeout = 5, CharacterSet = "utf8mb4",
        UseAffectedRows = true,          // UPDATE/ON DUPLICATE sem mudança devolve 0        DateTimeKind = MySqlDateTimeKind.Utc,
        AllowUserVariables = false,
    }.ConnectionString;

    /// <summary>Abre uma conexão pronta (esquema criado, sessão em UTC).</summary>
    public async Task<MySqlConnection> OpenAsync(CancellationToken ct, bool markLive = true)
    {
        if (!Configured) throw new PlanUnavailableException("Banco não configurado (MYSQL_DB_HOST / MYSQL_DB_PASSWORD).");
        try
        {
            await EnsureAsync(markLive, ct);
            var conn = await _ds!.OpenConnectionAsync(ct);
            return conn;
        }
        catch (Exception ex) when (ex is MySqlException or TimeoutException or System.Net.Sockets.SocketException)
        {
            log.LogWarning(ex, "Banco MySQL indisponível.");
            throw new PlanUnavailableException("Banco de dados indisponível. Verifique se o container está no ar (docker compose up -d mysql).", ex);
        }
    }

    private async Task EnsureAsync(bool markLive, CancellationToken ct)
    {
        if (_ready) return;
        await _init.WaitAsync(ct);
        try
        {
            if (_ready) return;
            _ds ??= new MySqlDataSourceBuilder(ConnectionString).Build();
            await using var conn = await _ds.OpenConnectionAsync(ct);
            foreach (var ddl in Schema)
            {
                await using var cmd = new MySqlCommand(ddl, conn);
                await cmd.ExecuteNonQueryAsync(ct);
            }
            if (markLive)
            {
                await using var meta = new MySqlCommand("INSERT IGNORE INTO db_meta (k, v) VALUES ('live_since', DATE_FORMAT(UTC_TIMESTAMP(6), '%Y-%m-%dT%H:%i:%s.%fZ'))", conn);
                await meta.ExecuteNonQueryAsync(ct);
            }
            _ready = true;
            log.LogInformation("Banco MySQL pronto ({Host}:{Port}/{Db}).", settings.PlanDbHost, settings.PlanDbPort, settings.PlanDbName);
        }
        finally { _init.Release(); }
    }

    // ---------- helpers de comando ----------

    [GeneratedRegex(@"\$(\d+)")]
    private static partial Regex Positional();

    /// <summary>
    /// Cria um comando aceitando parâmetros no estilo $1, $2 … (podem se repetir no SQL).
    /// Listas (long[]/int[]) usadas como "IN ($n)" são expandidas em vários parâmetros.
    /// </summary>
    public static MySqlCommand Cmd(MySqlConnection conn, string sql, params object?[] args) => Cmd(conn, null, sql, args);

    public static MySqlCommand Cmd(MySqlConnection conn, MySqlTransaction? tx, string sql, params object?[] args)
    {
        var cmd = new MySqlCommand { Connection = conn, Transaction = tx };
        cmd.CommandText = Positional().Replace(sql, m =>
        {
            var i = int.Parse(m.Groups[1].Value);
            var v = args[i - 1];
            if (v is System.Collections.IEnumerable e and not string and not byte[])
            {
                var items = e.Cast<object>().ToList();
                if (items.Count == 0) return "NULL"; // IN (NULL) não casa com nada
                return string.Join(", ", items.Select((_, j) => $"@p{i}_{j}"));
            }
            return $"@p{i}";
        });
        for (var i = 0; i < args.Length; i++)
        {
            var v = args[i];
            if (v is System.Collections.IEnumerable e and not string and not byte[])
            {
                var j = 0;
                foreach (var item in e) cmd.Parameters.AddWithValue($"@p{i + 1}_{j++}", item);
            }
            else cmd.Parameters.AddWithValue($"@p{i + 1}", v ?? DBNull.Value);
        }
        return cmd;
    }

    public async ValueTask DisposeAsync() { if (_ds is not null) await _ds.DisposeAsync(); }
}
