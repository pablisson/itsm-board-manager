namespace GlpiBoard.Api.Config;

/// <summary>
/// Carrega um arquivo .env (apenas desenvolvimento/servidor próprio).
/// Nunca sobrescreve variáveis já definidas no ambiente do sistema operacional.
/// </summary>
public static class DotEnv
{
    public static void LoadIfExists(params string[] candidates)
    {
        foreach (var path in candidates)
        {
            if (!File.Exists(path)) continue;
            foreach (var raw in File.ReadAllLines(path))
            {
                var line = raw.Trim();
                if (line.Length == 0 || line.StartsWith('#')) continue;
                var idx = line.IndexOf('=');
                if (idx <= 0) continue;
                var key = line[..idx].Trim();
                var value = line[(idx + 1)..].Trim();
                if (value.Length >= 2 && ((value[0] == '"' && value[^1] == '"') || (value[0] == '\'' && value[^1] == '\'')))
                    value = value[1..^1];
                if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable(key)))
                    Environment.SetEnvironmentVariable(key, value);
            }
            return;
        }
    }
}
