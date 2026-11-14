using System.Text.Json;
using GlpiBoard.Api.Glpi;
using GlpiBoard.Api.Plan;

namespace GlpiBoard.Api.Pm;

/// <summary>
/// /api/pm — gestão de projetos. Toda alteração devolve o projeto inteiro já recalculado
/// (o front só substitui o estado), com mensagens para o usuário em "messages".
/// </summary>
public static class PmEndpoints
{
    public sealed record TaskCreate(string? Title, long? AfterId);
    public sealed record DependencyInput(long PredId, long SuccId, int Type, int LagDays);
    public sealed record ChecklistInput(string? Text, bool? Done);

    public static void MapPm(this WebApplication app)
    {
        var g = app.MapGroup("/api/pm");
        g.AddEndpointFilter(async (ctx, next) =>
        {
            // Proteção CSRF: o login Basic é enviado automaticamente pelo navegador; um site de terceiros
            // não consegue mandar este cabeçalho sem passar pelo CORS (que não está liberado).
            var req = ctx.HttpContext.Request;
            if (!HttpMethods.IsGet(req.Method) && req.Headers["X-Requested-With"] != "board")
                return Results.Json(new { errors = new[] { "Requisição sem o cabeçalho X-Requested-With." } }, statusCode: 403);
            try { return await next(ctx); }
            catch (PmValidationException ex) { return Results.BadRequest(new { errors = new[] { ex.Message } }); }
            catch (PlanUnavailableException ex) { return Results.Json(new { errors = new[] { ex.Message } }, statusCode: 503); }
            catch (Exception ex) when (ex is GlpiException or HttpRequestException or TaskCanceledException)
            {
                return Results.Json(new { errors = new[] { "Falha ao falar com o ITSM: " + (ex is TaskCanceledException ? "tempo esgotado." : ex.Message) } }, statusCode: 502);
            }
        });

        async Task<IResult> View(PmService svc, long projectId, CancellationToken ct, List<string>? msgs = null) =>
            await svc.ViewAsync(projectId, ct, msgs) is { } v ? Results.Ok(v) : Results.NotFound();

        async Task<long> TaskProject(PmStore store, long taskId, CancellationToken ct) =>
            await store.ProjectOfTaskAsync(taskId, ct) ?? throw new PmValidationException("Tarefa não encontrada.");

        // ----- metadados / projetos -----
        g.MapGet("/meta", async (PmGlpi itsm, bool? refresh, CancellationToken ct) => Results.Ok(await itsm.MetaAsync(refresh == true, ct)));
        g.MapGet("/projects", async (PmService svc, CancellationToken ct) => Results.Ok(await svc.ListAsync(ct)));
        g.MapGet("/projects/{id:long}", (PmService svc, long id, CancellationToken ct) => View(svc, id, ct));
        g.MapPost("/projects", async (PmService svc, PmService.ProjectInput body, CancellationToken ct) =>
        {
            var id = await svc.CreateProjectAsync(body, ct);
            return await View(svc, id, ct);
        });
        g.MapPut("/projects/{id:long}", async (PmService svc, long id, PmService.ProjectInput body, CancellationToken ct) =>
        {
            await svc.UpdateProjectAsync(id, body, ct);
            return await View(svc, id, ct);
        });
        g.MapDelete("/projects/{id:long}", async (PmStore store, long id, CancellationToken ct) =>
            await store.DeleteProjectAsync(id, ct) ? Results.NoContent() : Results.NotFound());

        // ----- tarefas -----
        g.MapPost("/projects/{id:long}/tasks", async (PmService svc, long id, TaskCreate body, CancellationToken ct) =>
        {
            var tid = await svc.AddTaskAsync(id, body.Title, body.AfterId, ct);
            var v = await svc.ViewAsync(id, ct);
            return v is null ? Results.NotFound() : Results.Ok(new { view = v, taskId = tid });
        });
        g.MapPatch("/tasks/{id:long}", async (PmService svc, PmStore store, long id, JsonElement body, CancellationToken ct) =>
        {
            var pid = await TaskProject(store, id, ct);
            return await View(svc, pid, ct, await svc.PatchTaskAsync(pid, id, body, ct));
        });
        g.MapPost("/tasks/{id:long}/indent", async (PmService svc, PmStore store, long id, CancellationToken ct) =>
        { var pid = await TaskProject(store, id, ct); await svc.IndentAsync(pid, id, +1, ct); return await View(svc, pid, ct); });
        g.MapPost("/tasks/{id:long}/outdent", async (PmService svc, PmStore store, long id, CancellationToken ct) =>
        { var pid = await TaskProject(store, id, ct); await svc.IndentAsync(pid, id, -1, ct); return await View(svc, pid, ct); });
        g.MapPost("/tasks/{id:long}/move/{dir}", async (PmService svc, PmStore store, long id, string dir, CancellationToken ct) =>
        { var pid = await TaskProject(store, id, ct); await svc.MoveAsync(pid, id, dir == "up" ? -1 : 1, ct); return await View(svc, pid, ct); });
        g.MapPost("/tasks/{id:long}/align", async (PmService svc, PmStore store, long id, CancellationToken ct) =>
        { var pid = await TaskProject(store, id, ct); var m = await svc.AlignAsync(pid, id, ct); return await View(svc, pid, ct, [m]); });
        g.MapDelete("/tasks/{id:long}", async (PmService svc, PmStore store, long id, CancellationToken ct) =>
        {
            var pid = await TaskProject(store, id, ct);
            var n = await svc.DeleteTaskAsync(pid, id, ct);
            return await View(svc, pid, ct, [n > 1 ? $"{n} tarefas excluídas (com as subtarefas)." : "Tarefa excluída."]);
        });

        // ----- dependências -----
        g.MapPost("/projects/{id:long}/dependencies", async (PmService svc, long id, DependencyInput body, CancellationToken ct) =>
        { await svc.AddDependencyAsync(id, body.PredId, body.SuccId, body.Type, body.LagDays, ct); return await View(svc, id, ct); });
        g.MapPut("/dependencies/{id:long}", async (PmService svc, PmStore store, long id, DependencyInput body, CancellationToken ct) =>
        {
            var pid = await store.ProjectOfAsync("dependency", id, ct) ?? throw new PmValidationException("Dependência não encontrada.");
            PmService.CheckType(body.Type, body.LagDays);
            await store.UpdateDependencyAsync(id, body.Type, body.LagDays, ct);
            return await View(svc, pid, ct);
        });
        g.MapDelete("/dependencies/{id:long}", async (PmService svc, PmStore store, PmGlpi itsm, long id, CancellationToken ct) =>
        {
            var pid = await store.ProjectOfAsync("dependency", id, ct) ?? throw new PmValidationException("Dependência não encontrada.");
            var data = await store.LoadAsync(pid, ct);
            var link = data?.Dependencies.FirstOrDefault(d => d.Id == id)?.GlpiLinkId;
            await store.DeleteDependencyAsync(id, ct);
            if (link is { } l) await itsm.DeleteLinkAsync(l, ct);
            return await View(svc, pid, ct);
        });

        // ----- checklist -----
        g.MapPost("/tasks/{id:long}/checklist", async (PmService svc, PmStore store, long id, ChecklistInput body, CancellationToken ct) =>
        {
            var pid = await TaskProject(store, id, ct);
            await store.AddChecklistAsync(id, PmService.Text(body.Text, 500) ?? throw new PmValidationException("Informe o texto do item."), ct);
            return await View(svc, pid, ct);
        });
        g.MapPut("/checklist/{id:long}", async (PmService svc, PmStore store, long id, ChecklistInput body, CancellationToken ct) =>
        {
            var pid = await store.ProjectOfAsync("checklist", id, ct) ?? throw new PmValidationException("Item não encontrado.");
            await store.UpdateChecklistAsync(id, PmService.Text(body.Text, 500), body.Done, ct);
            return await View(svc, pid, ct);
        });
        g.MapDelete("/checklist/{id:long}", async (PmService svc, PmStore store, long id, CancellationToken ct) =>
        {
            var pid = await store.ProjectOfAsync("checklist", id, ct) ?? throw new PmValidationException("Item não encontrado.");
            await store.DeleteChecklistAsync(id, ct);
            return await View(svc, pid, ct);
        });

        // ----- anexos (lidos do formulário manualmente: sem antiforgery, protegido pelo cabeçalho acima) -----
        g.MapPost("/tasks/{id:long}/attachments", async (HttpRequest req, PmService svc, PmStore store, long id, CancellationToken ct) =>
        {
            var pid = await TaskProject(store, id, ct);
            if (!req.HasFormContentType) throw new PmValidationException("Envie o arquivo como multipart/form-data.");
            var form = await req.ReadFormAsync(ct);
            if (form.Files.Count == 0) throw new PmValidationException("Nenhum arquivo enviado.");
            foreach (var f in form.Files)
            {
                if (f.Length > PmStore.MaxAttachmentBytes) throw new PmValidationException($"“{f.FileName}” passa de {PmStore.MaxAttachmentBytes / 1024 / 1024} MB.");
                using var ms = new MemoryStream();
                await f.CopyToAsync(ms, ct);
                var name = Path.GetFileName(f.FileName);
                await store.AddAttachmentAsync(id, string.IsNullOrWhiteSpace(name) ? "arquivo" : name[..Math.Min(name.Length, 255)], f.ContentType, ms.ToArray(), ct);
            }
            return await View(svc, pid, ct);
        });
        g.MapGet("/attachments/{id:long}", async (PmStore store, long id, CancellationToken ct) =>
            await store.GetAttachmentAsync(id, ct) is { } a
                // sempre como download (nunca renderizado na origem do board)
                ? Results.File(a.Data, "application/octet-stream", a.Name)
                : Results.NotFound());
        g.MapDelete("/attachments/{id:long}", async (PmService svc, PmStore store, long id, CancellationToken ct) =>
        {
            var pid = await store.ProjectOfAsync("attachment", id, ct) ?? throw new PmValidationException("Anexo não encontrado.");
            await store.DeleteAttachmentAsync(id, ct);
            return await View(svc, pid, ct);
        });

        // ----- marcos -----
        g.MapPost("/projects/{id:long}/milestones", async (PmService svc, long id, PmService.MilestoneInput body, CancellationToken ct) =>
        { await svc.SaveMilestoneAsync(id, null, body, ct); return await View(svc, id, ct); });
        g.MapPut("/milestones/{id:long}", async (PmService svc, PmStore store, long id, PmService.MilestoneInput body, CancellationToken ct) =>
        {
            var pid = await store.ProjectOfAsync("milestone", id, ct) ?? throw new PmValidationException("Marco não encontrado.");
            await svc.SaveMilestoneAsync(pid, id, body, ct);
            return await View(svc, pid, ct);
        });
        g.MapDelete("/milestones/{id:long}", async (PmService svc, PmStore store, long id, CancellationToken ct) =>
        {
            var pid = await store.ProjectOfAsync("milestone", id, ct) ?? throw new PmValidationException("Marco não encontrado.");
            await store.DeleteMilestoneAsync(id, ct);
            return await View(svc, pid, ct);
        });

        // ----- ITSM -----
        g.MapPost("/tasks/{id:long}/glpi/link", async (PmService svc, PmStore store, PmGlpi itsm, long id, CancellationToken ct) =>
        { var pid = await TaskProject(store, id, ct); return await View(svc, pid, ct, await itsm.LinkTaskAsync(pid, id, ct)); });
        g.MapPost("/tasks/{id:long}/glpi/sync", async (PmService svc, PmStore store, PmGlpi itsm, long id, CancellationToken ct) =>
        { var pid = await TaskProject(store, id, ct); return await View(svc, pid, ct, await itsm.SyncTaskAsync(pid, id, ct)); });
        g.MapPost("/projects/{id:long}/glpi/sync", async (PmService svc, PmGlpi itsm, long id, CancellationToken ct) =>
            await View(svc, id, ct, await itsm.SyncProjectAsync(id, ct)));
        g.MapPost("/projects/{id:long}/glpi/link-all", async (PmService svc, PmGlpi itsm, long id, CancellationToken ct) =>
            await View(svc, id, ct, await itsm.LinkAllAsync(id, ct)));
    }
}
