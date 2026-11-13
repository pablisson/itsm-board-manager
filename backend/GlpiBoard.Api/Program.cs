using System.Security.Cryptography;
using System.Text;
using GlpiBoard.Api.Board;
using GlpiBoard.Api.Config;
using GlpiBoard.Api.Glpi;

// .env é opcional e NUNCA sobrescreve variáveis do sistema operacional / hospedagem.
DotEnv.LoadIfExists(".env", Path.Combine("..", "..", ".env"));

var builder = WebApplication.CreateBuilder(args);
var settings = BoardSettings.FromEnvironment(builder.Configuration);
builder.Services.AddSingleton(settings);
builder.Services.AddHttpClient("glpi", c => c.Timeout = TimeSpan.FromSeconds(60));
builder.Services.AddSingleton(sp => new GlpiClient(
    sp.GetRequiredService<IHttpClientFactory>().CreateClient("glpi"), settings, sp.GetRequiredService<ILogger<GlpiClient>>()));
builder.Services.AddSingleton<BoardService>();
builder.Services.AddSingleton<ReportService>();
builder.Services.AddSingleton<TimelineService>();

var app = builder.Build();
var log = app.Logger;

foreach (var e in settings.Validate()) log.LogWarning("Configuração: {Error}", e);
if (!settings.AuthConfigured && !settings.AuthDisabled)
    log.LogWarning("BOARD_AUTH_USER/BOARD_AUTH_PASSWORD não definidos: o board ficará BLOQUEADO até configurar (ou BOARD_AUTH_DISABLED=true em rede interna).");

// Cabeçalhos de segurança
app.Use(async (ctx, next) =>
{
    var h = ctx.Response.Headers;
    h["X-Content-Type-Options"] = "nosniff";
    h["X-Frame-Options"] = "DENY";
    h["Referrer-Policy"] = "no-referrer";
    h["Content-Security-Policy"] = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";
    await next();
});

// Autenticação Basic para o board publicado (HTTPS obrigatório na hospedagem).
app.Use(async (ctx, next) =>
{
    if (ctx.Request.Path.StartsWithSegments("/healthz")) { await next(); return; }
    if (settings.AuthDisabled) { await next(); return; }
    if (!settings.AuthConfigured)
    {
        ctx.Response.StatusCode = 503;
        await ctx.Response.WriteAsync("Board bloqueado: defina BOARD_AUTH_USER e BOARD_AUTH_PASSWORD.");
        return;
    }
    if (IsAuthorized(ctx.Request.Headers.Authorization.ToString(), settings)) { await next(); return; }
    ctx.Response.Headers.WWWAuthenticate = "Basic realm=\"Board ITSM\", charset=\"UTF-8\"";
    ctx.Response.StatusCode = 401;
});

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/healthz", () => Results.Ok(new { ok = true }));

app.MapGet("/api/config-status", (BoardSettings s) => Results.Json(new Dictionary<string, object?>
{
    // Apenas presença (true/false) — nunca valores.
    ["GLPI_URL"] = !string.IsNullOrEmpty(s.GlpiUrl),
    ["GLPI_APP_TOKEN"] = !string.IsNullOrEmpty(s.AppToken),
    ["GLPI_USER_TOKEN"] = s.UsesUserToken,
    ["GLPI_USERNAME"] = !string.IsNullOrEmpty(s.Username),
    ["GLPI_PASSWORD"] = !string.IsNullOrEmpty(s.Password),
    ["authMode"] = s.UsesUserToken ? "user_token" : s.UsesCredentials ? "basic" : "none",
    ["timezone"] = s.GlpiTimeZone.Id,
    ["doneDays"] = s.DoneDays,
    ["cancelledSolutionTypeIds"] = s.CancelledSolutionTypeIds.OrderBy(x => x).ToArray(),
    ["errors"] = s.Validate(),
}));

app.MapGet("/api/board", async (BoardService b, CancellationToken ct) => Results.Ok(await b.GetAsync(false, ct)));
app.MapPost("/api/board/refresh", async (BoardService b, CancellationToken ct) =>
{
    if (settings.Validate() is { Count: > 0 } errs) return Results.BadRequest(new { errors = errs });
    return Results.Ok(await b.GetAsync(true, ct));
});

app.MapGet("/api/reports/monthly", async (ReportService r, int? months, bool? refresh, CancellationToken ct) =>
{
    if (settings.Validate() is { Count: > 0 } errs) return Results.BadRequest(new { errors = errs });
    return Results.Ok(await r.GetMonthlyAsync(months ?? 12, refresh == true, ct));
});

app.MapGet("/api/timeline", async (TimelineService tl, int tech, CancellationToken ct) =>
{
    if (settings.Validate() is { Count: > 0 } errs) return Results.BadRequest(new { errors = errs });
    try { return Results.Ok(await tl.GetAsync(tech, ct)); }
    catch (Exception ex) when (ex is GlpiException or HttpRequestException or System.Text.Json.JsonException)
    {
        return Results.Json(new { errors = new[] { ex.Message } }, statusCode: 502);
    }
});

app.MapFallbackToFile("index.html");
app.Run();

static bool IsAuthorized(string header, BoardSettings s)
{
    if (!header.StartsWith("Basic ", StringComparison.OrdinalIgnoreCase)) return false;
    string decoded;
    try { decoded = Encoding.UTF8.GetString(Convert.FromBase64String(header[6..].Trim())); }
    catch (FormatException) { return false; }
    var i = decoded.IndexOf(':');
    if (i < 0) return false;
    return FixedEq(decoded[..i], s.AuthUser!) & FixedEq(decoded[(i + 1)..], s.AuthPassword!);
}

static bool FixedEq(string a, string b) =>
    CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(a)), SHA256.HashData(Encoding.UTF8.GetBytes(b)));
