using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using GlpiBoard.Api.Config;
using Microsoft.Extensions.Logging.Abstractions;
using MySqlConnector;
using Npgsql;

namespace GlpiBoard.Api.Data;

/// <summary>
/// Cópia PostgreSQL (antigo) → MySQL (novo), preservando os ids, e conferência linha a linha.
///   dotnet GlpiBoard.Api.dll migrate-from-postgres            copia (espelha) e confere
///   dotnet GlpiBoard.Api.dll migrate-from-postgres --verify   só confere
/// A cópia substitui o conteúdo do MySQL; é recusada se a aplicação já estiver usando o MySQL
/// (db_meta.live_since), a menos que se passe --force.
/// </summary>
public static class PgMigration
{
    private sealed record Col(string Name, string Type);

    /// <summary>Chave de ordenação estável de cada tabela (igual nos dois bancos).</summary>
    private static readonly Dictionary<string, string> OrderBy = new()
    {
        ["pm_task_user"] = "task_id, user_id",
        ["pm_milestone_task"] = "milestone_id, task_id",
    };

    public static async Task<int> RunAsync(BoardSettings s, string[] args)
    {
        var verifyOnly = args.Contains("--verify");
        var force = args.Contains("--force");
        if (string.IsNullOrWhiteSpace(s.PgSourceHost) || string.IsNullOrEmpty(s.PgSourcePassword))
        { Console.Error.WriteLine("Origem PostgreSQL não configurada (PLAN_DB_HOST / PLAN_DB_PASSWORD)."); return 2; }

        var pgCs = new NpgsqlConnectionStringBuilder
        {
            Host = s.PgSourceHost, Port = s.PgSourcePort, Database = s.PgSourceName, Username = s.PgSourceUser, Password = s.PgSourcePassword,
            Timeout = 10, Timezone = "UTC",
        }.ConnectionString;
        await using var pg = new NpgsqlConnection(pgCs);
        await pg.OpenAsync();
        var db = new AppDb(s, NullLogger<AppDb>.Instance);
        await using var my = await db.OpenAsync(CancellationToken.None, markLive: false);

        var cols = new Dictionary<string, List<Col>>();
        foreach (var t in AppDb.Tables) cols[t] = await ColumnsAsync(pg, t);

        if (!verifyOnly)
        {
            await using (var q = new MySqlCommand("SELECT v FROM db_meta WHERE k = 'live_since'", my))
                if (await q.ExecuteScalarAsync() is string live && !force)
                {
                    Console.Error.WriteLine($"RECUSADO: a aplicação já usa o MySQL desde {live}. A cópia apagaria dados novos. Use --force só se tiver certeza.");
                    return 2;
                }
            await CopyAsync(pg, my, cols);
            await FixAutoIncrementAsync(pg, my);
        }
        return await VerifyAsync(pg, my, cols) ? 0 : 1;
    }

    private static async Task<List<Col>> ColumnsAsync(NpgsqlConnection pg, string table)
    {
        await using var c = new NpgsqlCommand("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position", pg);
        c.Parameters.AddWithValue(table);
        var list = new List<Col>();
        await using var r = await c.ExecuteReaderAsync();
        while (await r.ReadAsync()) list.Add(new(r.GetString(0), r.GetString(1)));
        if (list.Count == 0) throw new InvalidOperationException($"Tabela {table} não existe no PostgreSQL.");
        return list;
    }

    private static string Order(string t, List<Col> cols) => OrderBy.GetValueOrDefault(t) ?? cols[0].Name;
    private static string Q(string c) => $"`{c}`";

    private static object Read(System.Data.Common.DbDataReader r, int i, string type) => r.IsDBNull(i) ? DBNull.Value : type switch
    {
        "date" => r.GetFieldValue<DateOnly>(i),
        "timestamp with time zone" or "timestamp without time zone" => DateTime.SpecifyKind(r.GetDateTime(i), DateTimeKind.Utc),
        "bytea" => r.GetFieldValue<byte[]>(i),
        "boolean" => r.GetBoolean(i),
        "smallint" => Convert.ToInt16(r.GetValue(i)),
        "integer" => Convert.ToInt32(r.GetValue(i)),
        "bigint" => Convert.ToInt64(r.GetValue(i)),
        _ => r.GetString(i),
    };

    private static async Task CopyAsync(NpgsqlConnection pg, MySqlConnection my, Dictionary<string, List<Col>> cols)
    {
        await using var tx = await my.BeginTransactionAsync();
        await Exec(my, tx, "SET FOREIGN_KEY_CHECKS = 0");
        foreach (var t in AppDb.Tables.Reverse()) await Exec(my, tx, $"DELETE FROM {t}");
        foreach (var t in AppDb.Tables)
        {
            var c = cols[t];
            var n = 0;
            await using var sel = new NpgsqlCommand($"SELECT {string.Join(", ", c.Select(x => $"\"{x.Name}\""))} FROM {t} ORDER BY {Order(t, c)}", pg);
            await using var r = await sel.ExecuteReaderAsync();
            var insert = $"INSERT INTO {t} ({string.Join(", ", c.Select(x => Q(x.Name)))}) VALUES ({string.Join(", ", c.Select((_, i) => $"@v{i}"))})";
            while (await r.ReadAsync())
            {
                await using var ins = new MySqlCommand(insert, my, tx);
                for (var i = 0; i < c.Count; i++) ins.Parameters.AddWithValue($"@v{i}", Read(r, i, c[i].Type));
                await ins.ExecuteNonQueryAsync();
                n++;
            }
            Console.WriteLine($"copiado  {t,-18} {n,6} linha(s)");
        }
        await Exec(my, tx, "SET FOREIGN_KEY_CHECKS = 1");
        await tx.CommitAsync();
    }

    /// <summary>Próximo id do MySQL = maior entre a sequência do PostgreSQL e o maior id copiado (+1): ids nunca são reaproveitados.</summary>
    private static async Task FixAutoIncrementAsync(NpgsqlConnection pg, MySqlConnection my)
    {
        await using var c = new NpgsqlCommand("""
            SELECT replace(sequencename, '_id_seq', ''), COALESCE(last_value, 0) FROM pg_sequences
            WHERE schemaname = current_schema() AND sequencename LIKE '%\_id\_seq'
            """, pg);
        var seqs = new List<(string, long)>();
        await using (var r = await c.ExecuteReaderAsync())
            while (await r.ReadAsync()) seqs.Add((r.GetString(0), r.GetInt64(1)));
        foreach (var (t, last) in seqs.Where(x => AppDb.Tables.Contains(x.Item1)))
        {
            await using var mx = new MySqlCommand($"SELECT COALESCE(MAX(id), 0) FROM {t}", my);
            var maxId = Convert.ToInt64(await mx.ExecuteScalarAsync());
            var next = Math.Max(last, maxId) + 1;
            await Exec(my, null, $"ALTER TABLE {t} AUTO_INCREMENT = {next}");
            Console.WriteLine($"próximo id {t,-18} {next}");
        }
    }

    private static async Task<bool> VerifyAsync(NpgsqlConnection pg, MySqlConnection my, Dictionary<string, List<Col>> cols)
    {
        Console.WriteLine();
        Console.WriteLine($"{"tabela",-18} {"Postgres",9} {"MySQL",9}  impressão digital (SHA-256 de todas as linhas/colunas)");
        var ok = true;
        foreach (var t in AppDb.Tables)
        {
            var c = cols[t];
            var colList = string.Join(", ", c.Select(x => x.Name));
            await using var a = new NpgsqlCommand($"SELECT {string.Join(", ", c.Select(x => $"\"{x.Name}\""))} FROM {t} ORDER BY {Order(t, c)}", pg);
            await using var b = new MySqlCommand($"SELECT {string.Join(", ", c.Select(x => Q(x.Name)))} FROM {t} ORDER BY {Order(t, c)}", my);
            var (na, ha) = await FingerprintAsync(a, c, pg: true);
            var (nb, hb) = await FingerprintAsync(b, c, pg: false);
            var same = na == nb && ha == hb;
            ok &= same;
            Console.WriteLine($"{t,-18} {na,9} {nb,9}  {(same ? "IGUAL" : "DIFERENTE")}  {ha[..16]} / {hb[..16]}");
        }
        Console.WriteLine(ok ? "\nRESULTADO: OK — todos os dados conferem." : "\nRESULTADO: FALHA — há diferenças.");
        return ok;
    }

    /// <summary>Representação canônica (independe do banco): data, UTC com microssegundos, hash dos binários.</summary>
    private static async Task<(long, string)> FingerprintAsync(System.Data.Common.DbCommand cmd, List<Col> cols, bool pg)
    {
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        long n = 0;
        await using var r = await cmd.ExecuteReaderAsync();
        var sb = new StringBuilder();
        while (await r.ReadAsync())
        {
            sb.Clear();
            for (var i = 0; i < cols.Count; i++)
            {
                if (i > 0) sb.Append('\u001f');
                var v = Read(r, i, cols[i].Type);
                sb.Append(v switch
                {
                    DBNull => "∅",
                    DateOnly d => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                    DateTime dt => dt.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff", CultureInfo.InvariantCulture),
                    byte[] bytes => $"{bytes.Length}:{Convert.ToHexString(SHA256.HashData(bytes))}",
                    bool bo => bo ? "1" : "0",
                    IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
                    _ => v.ToString(),
                });
            }
            sb.Append('\u001e');
            sha.AppendData(Encoding.UTF8.GetBytes(sb.ToString()));
            n++;
        }
        _ = pg;
        return (n, Convert.ToHexString(sha.GetHashAndReset()));
    }

    private static async Task Exec(MySqlConnection my, MySqlTransaction? tx, string sql)
    {
        await using var c = new MySqlCommand(sql, my, tx);
        await c.ExecuteNonQueryAsync();
    }
}
