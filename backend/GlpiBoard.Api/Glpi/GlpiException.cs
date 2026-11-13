namespace GlpiBoard.Api.Glpi;

public sealed class GlpiException(string message, int? statusCode = null) : Exception(message)
{
    public int? StatusCode { get; } = statusCode;
}
