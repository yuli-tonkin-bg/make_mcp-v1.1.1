import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// --- Corporate TLS: trust Windows system root CAs (fixes "unable to verify the first certificate") ---
// Взето 1:1 от Basecamp конектора — доказано работи в корпоративната мрежа на Tonkin.
// Зареждането е НЕБЛОКИРАЩО: 1) мигновено от кеша, 2) свеж PowerShell експорт на заден план.
import https from "https";
import tls from "tls";
import { execFile } from "child_process";

const CA_CACHE_FILE = () => path.join(__dirname, ".ca_cache.pem");

// Сигнал, че сертификатите са приложени — makeRequest го изчаква преди първата HTTPS
// заявка (сертификатите се зареждат на заден план след старта, виж v1.1.2).
let _caReadyResolve;
const caReady = new Promise((res) => { _caReadyResolve = res; });
function markCaReady() { if (_caReadyResolve) { _caReadyResolve(); _caReadyResolve = null; } }

function applyCAs(cas) {
  try {
    axios.defaults.httpsAgent = new https.Agent({ ca: [...cas] });
    console.error(`TLS: using ${cas.size} CA certificates (system + bundled)`);
  } catch (e) { console.error("TLS agent setup failed:", e.message); }
  markCaReady();
}

function loadSystemCAsAsync() {
  const cas = new Set(tls.rootCertificates);

  // 1) Node 22+: синхронно, но мигновено (без външен процес).
  try {
    if (typeof tls.getCACertificates === "function") {
      for (const c of tls.getCACertificates("system")) cas.add(c);
      applyCAs(cas);
      return;
    }
  } catch (e) { console.error("tls.getCACertificates failed:", e.message); }

  // 2) Кеш от предишен старт — четенето на файл е мигновено.
  try {
    if (fs.existsSync(CA_CACHE_FILE())) {
      const cached = fs.readFileSync(CA_CACHE_FILE(), "utf-8").match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
      for (const m of cached) cas.add(m);
      console.error(`TLS: loaded ${cached.length} cached CA certificates`);
    }
  } catch (e) { console.error("CA cache read failed:", e.message); }
  applyCAs(cas);

  // 3) Пресен PowerShell експорт — НА ЗАДЕН ПЛАН, не бави старта.
  if (process.platform === "win32") {
    const ps = "$sb = New-Object System.Text.StringBuilder; foreach ($loc in 'LocalMachine','CurrentUser') { foreach ($store in 'Root','CA') { try { Get-ChildItem \"Cert:\\$loc\\$store\" | ForEach-Object { $null = $sb.AppendLine('-----BEGIN CERTIFICATE-----'); $null = $sb.AppendLine([Convert]::ToBase64String($_.RawData, 'InsertLineBreaks')); $null = $sb.AppendLine('-----END CERTIFICATE-----') } } catch {} } }; [Console]::Out.Write($sb.ToString())";
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) { console.error("PowerShell CA export failed:", err.message); return; }
      const matches = String(stdout).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
      if (!matches.length) return;
      for (const m of matches) cas.add(m);
      applyCAs(cas);
      try { fs.writeFileSync(CA_CACHE_FILE(), matches.join("\n")); } catch (e) { console.error("CA cache write failed:", e.message); }
    });
  }
}

dotenv.config();

process.on("uncaughtException", (error) => {
  try { process.stderr.write(`UNCAUGHT EXCEPTION: ${error && error.stack ? error.stack : String(error)}\n`); } catch (_) {}
});
process.on("unhandledRejection", (reason) => {
  try { process.stderr.write(`UNHANDLED REJECTION: ${reason && reason.stack ? reason.stack : String(reason)}\n`); } catch (_) {}
});
process.on("beforeExit", (code) => { try { process.stderr.write(`process.beforeExit code=${code}\n`); } catch (_) {} });
process.on("exit", (code) => { try { process.stderr.write(`process.exit code=${code}\n`); } catch (_) {} });
process.on("SIGTERM", () => { try { process.stderr.write("SIGTERM received\n"); } catch (_) {} });
process.on("SIGHUP", () => { try { process.stderr.write("SIGHUP received\n"); } catch (_) {} });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3457); // различен от Basecamp (3456), за да няма сблъсък в HTTP режим

// ВАЖНО (v1.1.2): сертификатите се зареждат СЛЕД като stdio транспортът се закачи
// (виж main) — за да отговори `initialize` мигновено дори при студен старт. Иначе
// синхронното зареждане на корпоративните сертификати бавеше старта >5 сек и Claude
// Desktop показваше "Unable to connect to extension server" при първа инсталация.

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
//  Make.com конфигурация и HTTP клиент
// ============================================================================

const API_TOKEN = (process.env.MAKE_API_TOKEN || "").trim();
const RAW_ZONE = (process.env.MAKE_ZONE || "eu2").trim();
const DEFAULT_ORG_ID = (process.env.MAKE_ORG_ID || "").trim();
const DEFAULT_TEAM_ID = (process.env.MAKE_TEAM_ID || "").trim();

// Съставя базовия URL от региона. Приема:
//   "eu1"                     -> https://eu1.make.com/api/v2
//   "eu1.make.com"            -> https://eu1.make.com/api/v2
//   "eu1.make.celonis.com"    -> https://eu1.make.celonis.com/api/v2
//   пълен URL / MAKE_API_BASE -> ползва се както е даден
function resolveApiBase() {
  const override = (process.env.MAKE_API_BASE || "").trim();
  if (override) return override.replace(/\/+$/, "");
  let z = RAW_ZONE.replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/\/api\/v2$/, "");
  const host = z.includes(".") ? z : `${z}.make.com`;
  return `https://${host}/api/v2`;
}
const API_BASE = resolveApiBase();

function requireToken() {
  if (!API_TOKEN) {
    throw new Error(
      "Липсва Make API токен. Отвори Claude Desktop → Settings → Extensions → " +
      "'Make.com Integration' и попълни 'Make API token' (и региона/zone). " +
      "Токенът се създава в Make: профилът горе вдясно → Profile → API/MCP access → Add token."
    );
  }
}

// Единен HTTP клиент за Make API. Хвърля ясни (български) грешки.
async function makeRequest(endpoint, { method = "GET", data = null, params = null, timeout = 30000 } = {}) {
  requireToken();
  const config = {
    method,
    url: `${API_BASE}${endpoint}`,
    headers: {
      Authorization: `Token ${API_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "MakeMCPServer/1.5.0",
    },
    timeout,
  };
  if (params) config.params = params;
  if (data) config.data = data;

  // Изчакваме сертификатите да са готови (зареждат се на заден план след старта),
  // но най-много 10 сек, за да не увиснем.
  await Promise.race([caReady, new Promise((r) => setTimeout(r, 10000))]);

  try {
    const res = await axios(config);
    return res.data;
  } catch (error) {
    const status = error.response?.status;
    const body = error.response?.data;
    const msg =
      body?.message ||
      body?.detail ||
      (Array.isArray(body?.errors) ? body.errors.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("; ") : null) ||
      error.message;
    try { console.error(`Make API Error ${status ?? ""}:`, typeof body === "object" ? JSON.stringify(body) : body ?? error.message); } catch (_) {}
    if (status === 401 || status === 403) {
      throw new Error(
        `Make API отказа достъп (${status}). Провери: ` +
        `1) валиден ли е токенът; ` +
        `2) правилен ли е регионът/zone — сега ползвам ${API_BASE}; грешен регион дава 401 дори с валиден токен; ` +
        `3) има ли токенът нужните scopes (scenarios:read/write/run, teams:read, organizations:read). ` +
        `Детайл: ${msg}`
      );
    }
    throw new Error(`Make API грешка${status ? ` (${status})` : ""}: ${msg}`);
  }
}

// Make връща колекциите под ключ (напр. { scenarios: [...] }); имената леко варират
// между endpoint-и, затова падаме към "първия масив в обекта", ако очакваният ключ липсва.
function pickArray(body, preferredKey) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body[preferredKey])) return body[preferredKey];
  if (body && typeof body === "object") {
    for (const v of Object.values(body)) if (Array.isArray(v)) return v;
  }
  return [];
}
function pickObject(body, preferredKey) {
  if (body && body[preferredKey] && typeof body[preferredKey] === "object") return body[preferredKey];
  return body;
}

// Авто-пагинация през pg[offset]/pg[limit] с предпазен таван.
async function makePaginated(endpoint, key, { params = {}, pageLimit = 100, maxItems = 500 } = {}) {
  const out = [];
  let offset = 0;
  let guard = 0;
  while (guard < 100) {
    guard++;
    const pageParams = { ...params, "pg[limit]": pageLimit, "pg[offset]": offset };
    const body = await makeRequest(endpoint, { params: pageParams });
    const arr = pickArray(body, key);
    out.push(...arr);
    if (arr.length < pageLimit || out.length >= maxItems) break;
    offset += pageLimit;
  }
  return out.slice(0, maxItems);
}

// ============================================================================
//  Инструменти (tool implementations)
// ============================================================================

async function listOrganizations() {
  const orgs = await makePaginated("/organizations", "organizations", { pageLimit: 100, maxItems: 200 });
  return orgs.map((o) => ({ id: o.id, name: o.name, timezoneId: o.timezoneId, countryId: o.countryId }));
}

async function listTeams(organizationId) {
  let orgId = (organizationId || DEFAULT_ORG_ID || "").toString().trim();
  if (!orgId) {
    const orgs = await makePaginated("/organizations", "organizations", { pageLimit: 100, maxItems: 200 });
    if (orgs.length === 0) throw new Error("Този токен няма достъп до нито една организация.");
    if (orgs.length === 1) orgId = String(orgs[0].id);
    else {
      return {
        note: "Има повече от една организация. Извикай make_list_teams пак с organization_id (или задай Organization ID в настройките на разширението).",
        organizations: orgs.map((o) => ({ id: o.id, name: o.name })),
      };
    }
  }
  const teams = await makePaginated("/teams", "teams", { params: { organizationId: orgId }, pageLimit: 100, maxItems: 200 });
  return teams.map((t) => ({ id: t.id, name: t.name, organizationId: t.organizationId ?? Number(orgId) }));
}

async function listScenarios({ team_id, organization_id, active_only, limit } = {}) {
  const params = {};
  const teamId = (team_id || DEFAULT_TEAM_ID || "").toString().trim();
  const orgId = (organization_id || DEFAULT_ORG_ID || "").toString().trim();
  if (teamId) params.teamId = teamId;
  else if (orgId) params.organizationId = orgId;
  else {
    // Опит за авто-избор, ако има точно една организация.
    const orgs = await makePaginated("/organizations", "organizations", { pageLimit: 100, maxItems: 200 });
    if (orgs.length === 1) params.organizationId = orgs[0].id;
    else {
      throw new Error(
        "Нужен е team_id или organization_id. Извикай make_list_organizations и make_list_teams, " +
        "за да ги намериш, или задай Organization/Team ID в настройките на разширението."
      );
    }
  }
  if (active_only) params.isActive = true;
  const cap = Math.min(Number(limit) || 500, 2000);
  const scenarios = await makePaginated("/scenarios", "scenarios", { params, pageLimit: 100, maxItems: cap });
  return { count: scenarios.length, capped: scenarios.length >= cap, scenarios };
}

async function getScenario(scenarioId) {
  if (!scenarioId) throw new Error("scenario_id е задължителен.");
  const body = await makeRequest(`/scenarios/${encodeURIComponent(scenarioId)}`);
  return pickObject(body, "scenario");
}

// Пълната JSON структура на сценария (модули, параметри, филтри, връзки) — read-only,
// доказан scope (scenarios:read). Виж HANDOFF.md / Make_MCP_Анализ_и_Препоръки.md, П1.
async function getBlueprint(scenarioId) {
  if (!scenarioId) throw new Error("scenario_id е задължителен.");
  return await makeRequest(`/scenarios/${encodeURIComponent(scenarioId)}/blueprint`);
}

// Клонира сценарий — безопасен начин за тестване на структурни промени без риск за
// живия сценарий (П2, виж Make_MCP_Анализ_и_Препоръки.md раздел 4). states по подразбиране
// false: клонингът тръгва "чист", без да носи изпълнителското състояние на оригинала.
async function cloneScenario({ scenario_id, name, team_id, organization_id, states } = {}) {
  if (!scenario_id) throw new Error("scenario_id е задължителен.");
  if (!name) throw new Error("name е задължителен (име за клонинга).");
  const teamId = await resolveTeamId(team_id);
  let orgId = (organization_id || DEFAULT_ORG_ID || "").toString().trim();
  if (!orgId) {
    const orgs = await makePaginated("/organizations", "organizations", { pageLimit: 100, maxItems: 200 });
    if (orgs.length === 1) orgId = String(orgs[0].id);
    else throw new Error("Нужен е organization_id за клониране (има повече от една организация). Извикай make_list_organizations.");
  }
  const body = { name, teamId, states: states === true };
  return await makeRequest(`/scenarios/${encodeURIComponent(scenario_id)}/clone`, {
    method: "POST",
    data: body,
    params: { organizationId: orgId },
  });
}

async function runScenario({ scenario_id, data, wait } = {}) {
  if (!scenario_id) throw new Error("scenario_id е задължителен.");
  const responsive = wait !== false; // по подразбиране изчакваме резултата (Make таймаут ~40s)
  const payload = { data: data && typeof data === "object" ? data : {}, responsive };
  return await makeRequest(`/scenarios/${encodeURIComponent(scenario_id)}/run`, {
    method: "POST",
    data: payload,
    timeout: responsive ? 60000 : 30000,
  });
}

async function startScenario(scenarioId) {
  if (!scenarioId) throw new Error("scenario_id е задължителен.");
  const body = await makeRequest(`/scenarios/${encodeURIComponent(scenarioId)}/start`, { method: "POST", data: {} });
  return pickObject(body, "scenario");
}

async function stopScenario(scenarioId) {
  if (!scenarioId) throw new Error("scenario_id е задължителен.");
  const body = await makeRequest(`/scenarios/${encodeURIComponent(scenarioId)}/stop`, { method: "POST", data: {} });
  return pickObject(body, "scenario");
}

async function listExecutions({ scenario_id, limit, status } = {}) {
  if (!scenario_id) throw new Error("scenario_id е задължителен.");
  const params = { "pg[limit]": Math.min(Number(limit) || 20, 100) };
  if (status) params.status = status; // 1=success, 2=warning, 3=error
  const body = await makeRequest(`/scenarios/${encodeURIComponent(scenario_id)}/logs`, { params });
  return pickArray(body, "scenarioLogs");
}

async function getExecution({ scenario_id, execution_id } = {}) {
  if (!scenario_id || !execution_id) throw new Error("scenario_id и execution_id са задължителни.");
  return await makeRequest(`/scenarios/${encodeURIComponent(scenario_id)}/logs/${encodeURIComponent(execution_id)}`);
}

async function openInBrowser(url) {
  if (!url) throw new Error("url е задължителен.");
  try {
    const { default: open } = await import("open");
    await open(url);
    return { url, status: "opened" };
  } catch (e) {
    return { url, status: "failed", message: `Не можах да отворя браузъра: ${e.message}. Отвори ръчно: ${url}` };
  }
}

// ---- Data stores (v1.2.0) ----

// Резолвва team_id: параметър → конфигурация → единственият екип на (единствената) организация.
async function resolveTeamId(teamId) {
  const t = (teamId || DEFAULT_TEAM_ID || "").toString().trim();
  if (t) return t;
  const orgs = await makePaginated("/organizations", "organizations", { pageLimit: 100, maxItems: 200 });
  const orgId = orgs.length === 1 ? orgs[0].id : (DEFAULT_ORG_ID || null);
  if (!orgId) throw new Error("Нужен е team_id. Извикай make_list_teams, за да го намериш, или задай Team ID в настройките.");
  const teams = await makePaginated("/teams", "teams", { params: { organizationId: orgId }, pageLimit: 100, maxItems: 200 });
  if (teams.length === 1) return String(teams[0].id);
  throw new Error("Нужен е team_id (има повече от един екип). Извикай make_list_teams и подай team_id.");
}

async function listDataStores({ team_id, limit } = {}) {
  const teamId = await resolveTeamId(team_id);
  const cap = Math.min(Number(limit) || 200, 1000);
  const stores = await makePaginated("/data-stores", "dataStores", { params: { teamId }, pageLimit: 100, maxItems: cap });
  return { count: stores.length, dataStores: stores };
}

async function getRecords({ data_store_id, limit } = {}) {
  if (!data_store_id) throw new Error("data_store_id е задължителен.");
  const cap = Math.min(Number(limit) || 100, 1000);
  const records = await makePaginated(`/data-stores/${encodeURIComponent(data_store_id)}/data`, "records", { pageLimit: 100, maxItems: cap });
  return { count: records.length, capped: records.length >= cap, records };
}

async function addRecord({ data_store_id, data, key } = {}) {
  if (!data_store_id) throw new Error("data_store_id е задължителен.");
  if (!data || typeof data !== "object") throw new Error("data трябва да е обект с полетата на записа.");
  const payload = { data };
  if (key !== undefined && key !== null && String(key).length) payload.key = String(key);
  return await makeRequest(`/data-stores/${encodeURIComponent(data_store_id)}/data`, { method: "POST", data: payload });
}

async function updateRecord({ data_store_id, key, data } = {}) {
  if (!data_store_id || key === undefined || key === null || !String(key).length) throw new Error("data_store_id и key са задължителни.");
  if (!data || typeof data !== "object") throw new Error("data трябва да е обект с новите стойности на записа.");
  return await makeRequest(`/data-stores/${encodeURIComponent(data_store_id)}/data/${encodeURIComponent(key)}`, { method: "PUT", data });
}

async function deleteRecord({ data_store_id, keys } = {}) {
  if (!data_store_id) throw new Error("data_store_id е задължителен.");
  const list = Array.isArray(keys) ? keys.map(String).filter((k) => k.length) : (keys ? [String(keys)] : []);
  if (!list.length) throw new Error("Подай поне един ключ (keys) за триене. Триене на ВСИЧКИ записи не се поддържа от този инструмент нарочно.");
  return await makeRequest(`/data-stores/${encodeURIComponent(data_store_id)}/data`, { method: "DELETE", params: { confirmed: true }, data: { keys: list } });
}

// ---- Incomplete executions / DLQ, webhooks, connections (v1.3.0) ----

async function listIncomplete({ scenario_id, limit } = {}) {
  if (!scenario_id) throw new Error("scenario_id е задължителен.");
  const cap = Math.min(Number(limit) || 50, 200);
  const body = await makeRequest("/dlqs", { params: { scenarioId: scenario_id, "pg[limit]": cap } });
  return pickArray(body, "dlqs");
}

async function retryExecution({ dlq_id } = {}) {
  if (!dlq_id) throw new Error("dlq_id е задължителен (id на падналото изпълнение от make_list_incomplete).");
  return await makeRequest(`/dlqs/${encodeURIComponent(dlq_id)}/retry`, { method: "POST", data: {} });
}

// Реалните данни (bundle), обработвани в момента на провала — read-only, доказан
// scope (dlqs:read). Виж HANDOFF.md / Make_MCP_Анализ_и_Препоръки.md, П1.
async function getDlqBundle({ dlq_id } = {}) {
  if (!dlq_id) throw new Error("dlq_id е задължителен (id на падналото изпълнение от make_list_incomplete).");
  return await makeRequest(`/dlqs/${encodeURIComponent(dlq_id)}/bundle`);
}

// Трие САМО изрично посочени DLQ записи (П2). Bulk "изтрий всичко" (API поддържа all:true)
// нарочно не е изложено тук — виж модела за безопасност в Make_MCP_Анализ_и_Препоръки.md раздел 4.
async function deleteDlq({ scenario_id, dlq_ids } = {}) {
  if (!scenario_id) throw new Error("scenario_id е задължителен.");
  const ids = Array.isArray(dlq_ids) ? dlq_ids.map(String).filter((k) => k.length) : (dlq_ids ? [String(dlq_ids)] : []);
  if (!ids.length) throw new Error("Подай поне един dlq_id (dlq_ids) за триене. Изтриване на ВСИЧКИ записи не се поддържа от този инструмент нарочно.");
  return await makeRequest("/dlqs", {
    method: "DELETE",
    params: { scenarioId: scenario_id, confirmed: true },
    data: { ids },
  });
}

async function listHooks({ team_id } = {}) {
  const teamId = await resolveTeamId(team_id);
  const hooks = await makePaginated("/hooks", "hooks", { params: { teamId }, pageLimit: 100, maxItems: 300 });
  return { count: hooks.length, hooks };
}

async function triggerWebhook({ url, data } = {}) {
  if (!url || !/^https?:\/\//i.test(String(url))) throw new Error("Подай валиден webhook URL (напр. https://hook.eu2.make.com/...).");
  try {
    const res = await axios.post(String(url), (data && typeof data === "object") ? data : {}, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000,
    });
    return { status: res.status, response: res.data };
  } catch (error) {
    const status = error.response?.status;
    const body = error.response?.data;
    throw new Error(`Webhook грешка${status ? ` (${status})` : ""}: ${body ? (typeof body === "object" ? JSON.stringify(body) : body) : error.message}`);
  }
}

async function listConnections({ team_id } = {}) {
  const teamId = await resolveTeamId(team_id);
  const conns = await makePaginated("/connections", "connections", { params: { teamId }, pageLimit: 100, maxItems: 500 });
  return { count: conns.length, connections: conns };
}

async function testConnection({ connection_id } = {}) {
  if (!connection_id) throw new Error("connection_id е задължителен.");
  return await makeRequest(`/connections/${encodeURIComponent(connection_id)}/test`, { method: "POST", data: {} });
}

// ============================================================================
//  MCP дефиниции
// ============================================================================

const tools = [
  { name: "make_list_organizations", description: "List all Make.com organizations the API token has access to. Returns id + name. Use this first if you don't know the organization_id.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "make_list_teams", description: "List teams inside a Make.com organization (id + name). teamId is required by make_list_scenarios. If organization_id is omitted, the configured one is used, or the single org is auto-selected.", inputSchema: { type: "object", properties: { organization_id: { type: "string", description: "Organization ID (optional; falls back to configured MAKE_ORG_ID or the only org)" } }, required: [] } },
  { name: "make_list_scenarios", description: "List Make.com scenarios (automations) for a team or organization. Provide team_id OR organization_id (falls back to the configured ones, or the single org). Set active_only=true to return only active scenarios. Results are capped (default 500); 'capped' tells you if more exist.", inputSchema: { type: "object", properties: { team_id: { type: "string", description: "Team ID to list scenarios for (preferred)" }, organization_id: { type: "string", description: "Organization ID (used if team_id is not given)" }, active_only: { type: "boolean", description: "Only active scenarios (default false)" }, limit: { type: "number", description: "Max scenarios to return (default 500, max 2000)" } }, required: [] } },
  { name: "make_get_scenario", description: "Get full details of a single Make.com scenario by its ID (status, scheduling, team, description, etc.).", inputSchema: { type: "object", properties: { scenario_id: { type: "string", description: "The scenario ID" } }, required: ["scenario_id"] } },
  { name: "make_get_blueprint", description: "Get the full blueprint (JSON structure) of a Make.com scenario — every module, its parameters, filters and how modules connect to each other. This is the same data Make's own editor renders as the canvas. Use it to inspect exact module configuration without asking the user for screenshots.", inputSchema: { type: "object", properties: { scenario_id: { type: "string", description: "The scenario ID" } }, required: ["scenario_id"] } },
  { name: "make_clone_scenario", description: "Clone a Make.com scenario into a new one with a given name — the safe way to test structural changes (e.g. before make_update_blueprint) without touching the live scenario. team_id/organization_id fall back to the configured ones or the single team/org. states=true also copies module execution state (e.g. last trigger position); default false gives a clean copy.", inputSchema: { type: "object", properties: { scenario_id: { type: "string", description: "The scenario ID to clone" }, name: { type: "string", description: "Name for the cloned scenario" }, team_id: { type: "string", description: "Team ID to clone into (optional; falls back to configured MAKE_TEAM_ID or the only team)" }, organization_id: { type: "string", description: "Organization ID (optional; falls back to configured MAKE_ORG_ID or the only org)" }, states: { type: "boolean", description: "Also copy module execution state (default false = clean clone)" } }, required: ["scenario_id", "name"] } },
  { name: "make_run_scenario", description: "Run a Make.com scenario on demand (right now). By default waits for the run to finish and returns the result (Make waits up to ~40s); set wait=false to trigger and return the executionId immediately without waiting. 'data' is optional input passed to the scenario (only relevant if it starts with a trigger that accepts input). NOTE: the scenario must be ACTIVE — Make returns HTTP 422 'Scenario is not activated' for an inactive scenario; if needed, activate it first with make_start_scenario.", inputSchema: { type: "object", properties: { scenario_id: { type: "string", description: "The scenario ID to run" }, data: { type: "object", description: "Optional input data object passed to the scenario run" }, wait: { type: "boolean", description: "Wait for completion and return the result (default true). false = fire-and-forget, returns executionId." } }, required: ["scenario_id"] } },
  { name: "make_start_scenario", description: "Activate (turn ON / schedule) a Make.com scenario so it runs on its schedule or trigger.", inputSchema: { type: "object", properties: { scenario_id: { type: "string", description: "The scenario ID to activate" } }, required: ["scenario_id"] } },
  { name: "make_stop_scenario", description: "Deactivate (turn OFF) a Make.com scenario so it stops running on its schedule/trigger.", inputSchema: { type: "object", properties: { scenario_id: { type: "string", description: "The scenario ID to deactivate" } }, required: ["scenario_id"] } },
  { name: "make_list_executions", description: "List the execution history (logs) of a Make.com scenario, newest first. Shows whether runs succeeded/failed and when. Optionally filter by status (1=success, 2=warning, 3=error).", inputSchema: { type: "object", properties: { scenario_id: { type: "string", description: "The scenario ID" }, limit: { type: "number", description: "Max log entries (default 20, max 100)" }, status: { type: "number", description: "Filter: 1=success, 2=warning, 3=error" } }, required: ["scenario_id"] } },
  { name: "make_get_execution", description: "Get full details of a single scenario execution/log (status, operations, duration, error info) by scenario_id + execution_id (from make_list_executions).", inputSchema: { type: "object", properties: { scenario_id: { type: "string", description: "The scenario ID" }, execution_id: { type: "string", description: "The execution/log ID (from make_list_executions)" } }, required: ["scenario_id", "execution_id"] } },
  { name: "make_open_in_browser", description: "Open a Make.com URL (e.g. a scenario editor link) in the default browser on the user's computer.", inputSchema: { type: "object", properties: { url: { type: "string", description: "The URL to open" } }, required: ["url"] } },
  { name: "make_list_data_stores", description: "List Make.com data stores (Make's built-in lightweight database) for a team. team_id falls back to the configured team or the only team. Returns id, name and record info.", inputSchema: { type: "object", properties: { team_id: { type: "string", description: "Team ID (optional; falls back to configured MAKE_TEAM_ID or the only team)" }, limit: { type: "number", description: "Max data stores to return (default 200)" } }, required: [] } },
  { name: "make_get_records", description: "List the records in a Make.com data store. Each record has a 'key' and a 'data' object. Results are capped (default 100).", inputSchema: { type: "object", properties: { data_store_id: { type: "string", description: "The data store ID (from make_list_data_stores)" }, limit: { type: "number", description: "Max records to return (default 100, max 1000)" } }, required: ["data_store_id"] } },
  { name: "make_add_record", description: "Add a new record to a Make.com data store. 'data' is an object with the record's fields (must match the data store's structure). 'key' is optional — Make auto-generates one if omitted.", inputSchema: { type: "object", properties: { data_store_id: { type: "string", description: "The data store ID" }, data: { type: "object", description: "The record's fields as an object" }, key: { type: "string", description: "Optional record key (auto-generated if omitted)" } }, required: ["data_store_id", "data"] } },
  { name: "make_update_record", description: "Replace an existing record in a Make.com data store, identified by its key. 'data' is the full new object for the record (it REPLACES the record).", inputSchema: { type: "object", properties: { data_store_id: { type: "string", description: "The data store ID" }, key: { type: "string", description: "The key of the record to replace" }, data: { type: "object", description: "The new record fields as an object (replaces the record)" } }, required: ["data_store_id", "key", "data"] } },
  { name: "make_delete_record", description: "Delete SPECIFIC record(s) from a Make.com data store by key(s). Pass 'keys' as an array of the record keys to delete — ONLY those are removed. Deleting ALL records is intentionally NOT supported here, for safety.", inputSchema: { type: "object", properties: { data_store_id: { type: "string", description: "The data store ID" }, keys: { type: "array", items: { type: "string" }, description: "Array of record keys to delete (only these are removed)" } }, required: ["data_store_id", "keys"] } },
  { name: "make_list_incomplete", description: "List incomplete/failed executions (DLQ) of a Make.com scenario — runs that errored and are waiting. Use this before retrying.", inputSchema: { type: "object", properties: { scenario_id: { type: "string", description: "The scenario ID" }, limit: { type: "number", description: "Max entries (default 50, max 200)" } }, required: ["scenario_id"] } },
  { name: "make_retry_execution", description: "Retry a single incomplete/failed execution (DLQ item) by its id (from make_list_incomplete). This RE-RUNS the failed execution.", inputSchema: { type: "object", properties: { dlq_id: { type: "string", description: "The incomplete-execution (DLQ) id from make_list_incomplete" } }, required: ["dlq_id"] } },
  { name: "make_get_dlq_bundle", description: "Get the actual data (bundle) that was being processed at the moment a scenario execution failed — the real input/output values behind an incomplete/failed execution (from make_list_incomplete). Use this for real diagnosis instead of guessing from error messages alone.", inputSchema: { type: "object", properties: { dlq_id: { type: "string", description: "The incomplete-execution (DLQ) id from make_list_incomplete" } }, required: ["dlq_id"] } },
  { name: "make_delete_dlq", description: "Delete specific incomplete/failed execution(s) (DLQ items) by id, from a given scenario. Pass 'dlq_ids' as an array of the exact ids to delete (from make_list_incomplete) — ONLY those are removed. Deleting ALL incomplete executions of a scenario is intentionally NOT supported here, for safety.", inputSchema: { type: "object", properties: { scenario_id: { type: "string", description: "The scenario ID the DLQ items belong to" }, dlq_ids: { type: "array", items: { type: "string" }, description: "Array of DLQ ids to delete (only these are removed)" } }, required: ["scenario_id", "dlq_ids"] } },
  { name: "make_list_hooks", description: "List Make.com webhooks for a team. Returns each hook's id, name and its webhook URL (used by make_trigger_webhook). team_id falls back to the configured team or the only team.", inputSchema: { type: "object", properties: { team_id: { type: "string", description: "Team ID (optional; falls back to configured MAKE_TEAM_ID or the only team)" } }, required: [] } },
  { name: "make_trigger_webhook", description: "Trigger a Make.com scenario by sending a POST to its webhook URL (from make_list_hooks). This FIRES the scenario for real. 'data' is an optional JSON payload sent to the webhook.", inputSchema: { type: "object", properties: { url: { type: "string", description: "The webhook URL to POST to (e.g. https://hook.eu2.make.com/...)" }, data: { type: "object", description: "Optional JSON payload sent to the webhook" } }, required: ["url"] } },
  { name: "make_list_connections", description: "List Make.com connections (linked app accounts) for a team — id, name and app. Useful to see which integrations are connected. team_id falls back to the configured team or the only team.", inputSchema: { type: "object", properties: { team_id: { type: "string", description: "Team ID (optional; falls back to configured MAKE_TEAM_ID or the only team)" } }, required: [] } },
  { name: "make_test_connection", description: "Verify whether a Make.com connection is still valid (Make re-checks the saved credentials against the app). Returns a 'verified' status.", inputSchema: { type: "object", properties: { connection_id: { type: "string", description: "The connection ID (from make_list_connections)" } }, required: ["connection_id"] } },
];

async function handleTool(toolName, toolInput) {
  switch (toolName) {
    case "make_list_organizations": return await listOrganizations();
    case "make_list_teams": return await listTeams(toolInput.organization_id);
    case "make_list_scenarios": return await listScenarios(toolInput);
    case "make_get_scenario": return await getScenario(toolInput.scenario_id);
    case "make_get_blueprint": return await getBlueprint(toolInput.scenario_id);
    case "make_clone_scenario": return await cloneScenario(toolInput);
    case "make_run_scenario": return await runScenario(toolInput);
    case "make_start_scenario": return await startScenario(toolInput.scenario_id);
    case "make_stop_scenario": return await stopScenario(toolInput.scenario_id);
    case "make_list_executions": return await listExecutions(toolInput);
    case "make_get_execution": return await getExecution(toolInput);
    case "make_open_in_browser": return await openInBrowser(toolInput.url);
    case "make_list_data_stores": return await listDataStores(toolInput);
    case "make_get_records": return await getRecords(toolInput);
    case "make_add_record": return await addRecord(toolInput);
    case "make_update_record": return await updateRecord(toolInput);
    case "make_delete_record": return await deleteRecord(toolInput);
    case "make_list_incomplete": return await listIncomplete(toolInput);
    case "make_retry_execution": return await retryExecution(toolInput);
    case "make_get_dlq_bundle": return await getDlqBundle(toolInput);
    case "make_delete_dlq": return await deleteDlq(toolInput);
    case "make_list_hooks": return await listHooks(toolInput);
    case "make_trigger_webhook": return await triggerWebhook(toolInput);
    case "make_list_connections": return await listConnections(toolInput);
    case "make_test_connection": return await testConnection(toolInput);
    default: throw new Error(`Unknown tool: ${toolName}`);
  }
}

const server = new Server({ name: "make-mcp", version: "1.5.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const result = await handleTool(request.params.name, request.params.arguments || {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `Error: ${errorMessage}` }], isError: true };
  }
});

// ============================================================================
//  Старт
// ============================================================================

async function main() {
  console.error("Starting Make.com MCP Server...");

  const useHttp = process.argv.includes("--http") || process.argv.includes("--sse");

  // HTTP режим (само за локална разработка). Импортваме express мързеливо, за да
  // не е твърда зависимост за stdio режима, който Claude Desktop реално ползва.
  if (useHttp) {
    loadSystemCAsAsync(); // HTTP режим е само за разработка — тук латентността няма значение
    const { createMcpExpressApp } = await import("@modelcontextprotocol/sdk/server/express.js");
    const app = createMcpExpressApp(server);
    app.get("/health", (req, res) => res.json({ status: "ok" }));
    app.listen(PORT, () => console.error(`HTTP server on port ${PORT}`));
    return;
  }

  // stdio режим (както Claude Desktop пуска разширението): свързваме се веднага
  // и не блокираме — токенът е конфигурация, проверява се при първото извикване.
  console.error("Starting stdio server");
  process.stdin.resume();
  process.on("SIGINT", () => {
    console.error("SIGINT received, shutting down server...");
    process.exit(0);
  });

  let connected = false;
  (async () => {
    let attempt = 0;
    while (!connected) {
      attempt++;
      try {
        const transport = new StdioServerTransport();
        await server.connect(transport);
        connected = true;
        process.stderr.write(`Make MCP stdio server started (attempt=${attempt})\n`);
        // Чак СЕГА зареждаме сертификатите — на заден план, след като връзката е готова,
        // за да не бавим отговора на `initialize` (фикс за студен старт, v1.1.2).
        setImmediate(() => loadSystemCAsAsync());
      } catch (e) {
        process.stderr.write(`stdio connect attempt ${attempt} failed: ${e && e.message ? e.message : String(e)}\n`);
        await sleep(Math.min(5000, 1000 * attempt));
      }
    }
  })();

  setInterval(() => {
    try { process.stderr.write("heartbeat: process alive\n"); } catch (_) {}
  }, 15000);

  if (!API_TOKEN) {
    console.error("WARNING: MAKE_API_TOKEN не е зададен — инструментите ще връщат грешка, докато не се попълни в настройките на разширението.");
  } else {
    console.error(`Make MCP ready. API base: ${API_BASE}`);
  }

  await new Promise(() => {}); // keep process alive
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
// v1.5.0
