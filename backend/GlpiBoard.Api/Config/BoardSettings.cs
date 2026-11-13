namespace GlpiBoard.Api.Config;

public sealed class BoardSettings
{
    // --- Conexão GLPI ---
    public string GlpiUrl { get; init; } = "";           // GLPI_URL  ex.: https://glpi.empresa.com/apirest.php
    public string? AppToken { get; init; }               // GLPI_APP_TOKEN
    public string? UserToken { get; init; }              // GLPI_USER_TOKEN (preferencial)
    public string? Username { get; init; }               // GLPI_USERNAME   (alternativa ao user token)
    public string? Password { get; init; }               // GLPI_PASSWORD
    public TimeZoneInfo GlpiTimeZone { get; init; } = TimeZoneInfo.Utc; // GLPI_TIMEZONE

    // --- Regras do board ---
    public int DoneDays { get; init; } = 30;              // BOARD_DONE_DAYS
    public HashSet<int> CancelledSolutionTypeIds { get; init; } = new(); // BOARD_CANCELLED_SOLUTIONTYPE_IDS
    public int CacheSeconds { get; init; } = 300;         // BOARD_CACHE_SECONDS
    public int RefreshMinIntervalSeconds { get; init; } = 15; // BOARD_REFRESH_MIN_INTERVAL_SECONDS
    public int AgeWarnHours { get; init; } = 72;          // BOARD_AGE_WARN_HOURS
    public int AgeCriticalHours { get; init; } = 168;     // BOARD_AGE_CRITICAL_HOURS

    // --- Acesso ao board publicado ---
    public string? AuthUser { get; init; }                // BOARD_AUTH_USER
    public string? AuthPassword { get; init; }            // BOARD_AUTH_PASSWORD
    public bool AuthDisabled { get; init; }               // BOARD_AUTH_DISABLED=true (só para rede interna)

    public bool UsesUserToken => !string.IsNullOrWhiteSpace(UserToken);
    public bool UsesCredentials => !UsesUserToken && !string.IsNullOrWhiteSpace(Username) && !string.IsNullOrWhiteSpace(Password);
    public bool AuthConfigured => !string.IsNullOrWhiteSpace(AuthUser) && !string.IsNullOrWhiteSpace(AuthPassword);

    /// <summary>URL base da interface web do GLPI (para links "abrir no GLPI").</summary>
    public string GlpiWebBase
    {
        get
        {
            var u = GlpiUrl.TrimEnd('/');
            var i = u.IndexOf("/apirest.php", StringComparison.OrdinalIgnoreCase);
            if (i >= 0) return u[..i];
            i = u.IndexOf("/api.php", StringComparison.OrdinalIgnoreCase);
            return i >= 0 ? u[..i] : u;
        }
    }

    public static BoardSettings FromEnvironment(IConfiguration c)
    {
        string? S(string k) => string.IsNullOrWhiteSpace(c[k]) ? null : c[k]!.Trim();
        int I(string k, int d) => int.TryParse(c[k], out var v) && v > 0 ? v : d;

        var tzId = S("GLPI_TIMEZONE") ?? "America/Sao_Paulo";
        TimeZoneInfo tz;
        try { tz = TimeZoneInfo.FindSystemTimeZoneById(tzId); }
        catch { tz = TimeZoneInfo.Utc; }

        var cancelIds = (S("BOARD_CANCELLED_SOLUTIONTYPE_IDS") ?? "")
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(x => int.TryParse(x, out var v) ? v : -1).Where(v => v > 0).ToHashSet();

        return new BoardSettings
        {
            GlpiUrl = (S("GLPI_URL") ?? "").TrimEnd('/'),
            AppToken = S("GLPI_APP_TOKEN"),
            UserToken = S("GLPI_USER_TOKEN"),
            Username = S("GLPI_USERNAME"),
            Password = c["GLPI_PASSWORD"], // senha não é "trimada"
            GlpiTimeZone = tz,
            DoneDays = I("BOARD_DONE_DAYS", 30),
            CancelledSolutionTypeIds = cancelIds,
            CacheSeconds = I("BOARD_CACHE_SECONDS", 300),
            RefreshMinIntervalSeconds = I("BOARD_REFRESH_MIN_INTERVAL_SECONDS", 15),
            AgeWarnHours = I("BOARD_AGE_WARN_HOURS", 72),
            AgeCriticalHours = I("BOARD_AGE_CRITICAL_HOURS", 168),
            AuthUser = S("BOARD_AUTH_USER"),
            AuthPassword = c["BOARD_AUTH_PASSWORD"],
            AuthDisabled = string.Equals(S("BOARD_AUTH_DISABLED"), "true", StringComparison.OrdinalIgnoreCase),
        };
    }

    /// <summary>Lista de problemas de configuração (sem expor valores).</summary>
    public List<string> Validate()
    {
        var errors = new List<string>();
        if (string.IsNullOrWhiteSpace(GlpiUrl)) errors.Add("GLPI_URL não definido.");
        else if (!Uri.TryCreate(GlpiUrl, UriKind.Absolute, out var uri)) errors.Add("GLPI_URL não é uma URL válida.");
        else if (uri.Scheme != Uri.UriSchemeHttps && !uri.IsLoopback) errors.Add("GLPI_URL deve usar HTTPS (tokens trafegam nos cabeçalhos).");
        if (!UsesUserToken && !UsesCredentials)
            errors.Add("Defina GLPI_USER_TOKEN (recomendado) ou o par GLPI_USERNAME + GLPI_PASSWORD.");
        return errors;
    }
}
