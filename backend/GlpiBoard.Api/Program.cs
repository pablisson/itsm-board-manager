using System.Security.Cryptography;
using System.Text;
using GlpiBoard.Api.Board;
using GlpiBoard.Api.Config;
using GlpiBoard.Api.Glpi;
using GlpiBoard.Api.Plan;
using GlpiBoard.Api.Pm;

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
builder.Services.AddSingleton<SlaReportService>();
builder.Services.AddSingleton<TechReportService>();
builder.Services.AddSingleton<ClientReportService>();
builder.Services.AddSingleton<GlpiBoard.Api.Data.AppDb>();
builder.Services.AddSingleton<PlanStore>();
builder.Services.AddSingleton<SolvedImportService>();
builder.Services.AddSingleton<PmStore>();
builder.Services.AddSingleton<PmGlpi>();
builder.Services.AddSingleton<PmService>();

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
app.MapGet("/api/plan/health", async (PlanStore s, CancellationToken ct) => Results.Ok(new { configured = s.Configured, ok = await s.PingAsync(ct) }));

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

app.MapGet("/api/reports/sla", async (SlaReportService r, string? from, string? to, bool? refresh, CancellationToken ct) =>
{
    if (settings.Validate() is { Count: > 0 } errs) return Results.BadRequest(new { errors = errs });
    var nowLocal = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, settings.GlpiTimeZone);
    var cur = new DateOnly(nowLocal.Year, nowLocal.Month, 1);
    static DateOnly? Month(string? s) => DateOnly.TryParseExact(s + "-01", "yyyy-MM-dd", out var d) && d.Year is >= 2000 and <= 2100 ? d : null;
    var f = string.IsNullOrEmpty(from) ? cur : Month(from);
    var t = string.IsNullOrEmpty(to) ? f : Month(to);
    if (f is null || t is null || t < f || t.Value > f.Value.AddMonths(SlaReportService.MaxMonths - 1))
        return Results.BadRequest(new { errors = new[] { $"Período inválido (use from/to = AAAA-MM, até {SlaReportService.MaxMonths} meses)." } });
    return Results.Ok(await r.GetAsync(f.Value, t.Value, refresh == true, ct));
});

// Desempenho: tickets solucionados/fechados nos dias from..to (AAAA-MM-DD)
app.MapGet("/api/reports/performance", async (SlaReportService r, string? from, string? to, bool? refresh, CancellationToken ct) =>
{
    if (settings.Validate() is { Count: > 0 } errs) return Results.BadRequest(new { errors = errs });
    static DateOnly? Day(string? s) => DateOnly.TryParseExact(s, "yyyy-MM-dd", out var d) && d.Year is >= 2000 and <= 2100 ? d : null;
    var f = Day(from); var t = Day(to);
    if (f is null || t is null || t < f || t.Value.DayNumber - f.Value.DayNumber >= SlaReportService.MaxSolvedDays)
        return Results.BadRequest(new { errors = new[] { $"Período inválido (use from/to = AAAA-MM-DD, até {SlaReportService.MaxSolvedDays} dias)." } });
    return Results.Ok(await r.GetSolvedAsync(f.Value, t.Value, refresh == true, ct));
});

// Por técnico: tickets ABERTOS nos dias from..to (AAAA-MM-DD), com tema (nível 2 da categoria)
app.MapGet("/api/reports/technicians", async (TechReportService r, string? from, string? to, bool? refresh, CancellationToken ct) =>
{
    if (settings.Validate() is { Count: > 0 } errs) return Results.BadRequest(new { errors = errs });
    static DateOnly? Day(string? s) => DateOnly.TryParseExact(s, "yyyy-MM-dd", out var d) && d.Year is >= 2000 and <= 2100 ? d : null;
    var f = Day(from); var t = Day(to);
    if (f is null || t is null || t < f || t.Value.DayNumber - f.Value.DayNumber >= TechReportService.MaxDays)
        return Results.BadRequest(new { errors = new[] { $"Período inválido (use from/to = AAAA-MM-DD, até {TechReportService.MaxDays} dias)." } });
    return Results.Ok(await r.GetAsync(f.Value, t.Value, refresh == true, ct));
});

// Por cliente: fila atual + abertos/solucionados nos últimos N dias (7 a 90; padrão 15)
app.MapGet("/api/reports/clients", async (ClientReportService r, int? days, bool? refresh, CancellationToken ct) =>
{
    if (settings.Validate() is { Count: > 0 } errs) return Results.BadRequest(new { errors = errs });
    var d = days ?? 15;
    if (d < ClientReportService.MinDays || d > ClientReportService.MaxDays)
        return Results.BadRequest(new { errors = new[] { $"Período inválido (days entre {ClientReportService.MinDays} e {ClientReportService.MaxDays})." } });
    return Results.Ok(await r.GetAsync(d, refresh == true, ct));
});

app.MapGet("/api/timeline",async (TimelineService tl, int tech, CancellationToken ct) =>
{
    if (settings.Validate() is { Count: > 0 } errs) return Results.BadRequest(new { errors = errs });
    try { return Results.Ok(await tl.GetAsync(tech, ct)); }
    catch (Exception ex) when (ex is GlpiException or HttpRequestException or System.Text.Json.JsonException)
    {
        return Results.Json(new { errors = new[] { ex.Message } }, statusCode: 502);
    }
});

// ---------- Planejamento (técnico × dia) — MySQL ----------
var plan = app.MapGroup("/api/plan");
plan.AddEndpointFilter(async (ctx, next) =>
{
    try { return await next(ctx); }
    catch (PlanUnavailableException ex) { return Results.Json(new { errors = new[] { ex.Message } }, statusCode: 503); }
});
static bool ValidDay(DateOnly d) => d.Year is >= 2000 and <= 2100;

plan.MapGet("", async (PlanStore store, string? month, CancellationToken ct) =>
{
    var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, settings.GlpiTimeZone).DateTime);
    var first = new DateOnly(today.Year, today.Month, 1);
    if (!string.IsNullOrEmpty(month))
    {
        if (!DateOnly.TryParseExact(month + "-01", "yyyy-MM-dd", out first) || !ValidDay(first))
            return Results.BadRequest(new { errors = new[] { "Parâmetro month inválido (use AAAA-MM)." } });
    }
    var last = first.AddMonths(1).AddDays(-1);
    var items = await store.ListAsync(first, last, ct);
    var counts = (await store.CountsAsync(today, ct)).Select(c => new { c.TechId, c.TicketId, c.Days, Next = c.Next });
    return Results.Ok(new { Month = first.ToString("yyyy-MM"), From = first, To = last, Today = today, Items = items, Counts = counts });
});

plan.MapPost("", async (PlanStore store, PlanCreate body, CancellationToken ct) =>
{
    if (body.TechId <= 0 || body.TicketId <= 0 || !ValidDay(body.Day)) return Results.BadRequest(new { errors = new[] { "Dados inválidos." } });
    return Results.Ok(await store.AddAsync(body, ct));
});

// busca no ITSM os solucionados/fechados no período e coloca no dia da solução
plan.MapPost("/import-solved", async (SolvedImportService svc, SolvedImportRequest body, HttpRequest req, CancellationToken ct) =>
{
    if (req.Headers["X-Requested-With"] != "board") return Results.BadRequest(new { errors = new[] { "Requisição inválida." } });
    if (settings.Validate() is { Count: > 0 } errs) return Results.BadRequest(new { errors = errs });
    if (!ValidDay(body.From) || body.To < body.From || body.To.DayNumber - body.From.DayNumber >= SolvedImportService.MaxDays)
        return Results.BadRequest(new { errors = new[] { $"Período inválido (até {SolvedImportService.MaxDays} dias)." } });
    try { return Results.Ok(await svc.ImportAsync(body.From, body.To, ct)); }
    catch (Exception ex) when (ex is GlpiException or HttpRequestException or System.Text.Json.JsonException)
    {
        return Results.Json(new { errors = new[] { ex.Message } }, statusCode: 502);
    }
});

plan.MapPut("/{id:long}", async (PlanStore store, long id, PlanMove body, CancellationToken ct) =>
{
    if (!ValidDay(body.Day) || body.Position is < 0) return Results.BadRequest(new { errors = new[] { "Dados inválidos." } });
    return await store.MoveAsync(id, body, ct) is { } item ? Results.Ok(item) : Results.NotFound();
});

plan.MapDelete("/{id:long}", async (PlanStore store, long id, CancellationToken ct) =>
    await store.DeleteAsync(id, ct) ? Results.NoContent() : Results.NotFound());

app.MapPm();

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
