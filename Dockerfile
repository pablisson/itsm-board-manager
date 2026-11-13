# ---- build do frontend React ----
FROM node:22-alpine AS web
WORKDIR /src/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build   # saída em /src/backend/GlpiBoard.Api/wwwroot

# ---- build do backend .NET ----
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS api
WORKDIR /src/backend/GlpiBoard.Api
COPY backend/GlpiBoard.Api/*.csproj ./
RUN dotnet restore
COPY backend/GlpiBoard.Api/ ./
COPY --from=web /src/backend/GlpiBoard.Api/wwwroot ./wwwroot
RUN dotnet publish -c Release -o /app --no-restore

# ---- runtime ----
FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=api /app ./
ENV ASPNETCORE_URLS=http://+:8080 ASPNETCORE_ENVIRONMENT=Production
EXPOSE 8080
USER app
ENTRYPOINT ["dotnet", "GlpiBoard.Api.dll"]
