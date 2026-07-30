# Make.com MCP конектор

MCP конектор (разширение за Claude Desktop), който свързва Claude с **Make.com**
(Integromat) — списък, пускане, активиране/деактивиране и следене на сценарии
(scenarios / автоматизации).

> ⚠️ **Private repo.** Конфигурацията съдържа Make API токен — да НЕ става публично.
> Токенът НЕ е в кода — въвежда се при инсталация (виж по-долу).

Отделен е от Basecamp конектора нарочно — двата работят паралелно в Claude Desktop,
без да си пречат. Този проект споделя доказаната инфраструктура на Basecamp конектора
(корпоративен TLS fix, устойчив stdio старт), но с автентикация чрез Make API токен
вместо OAuth.

## Структура

| Файл | Роля |
|---|---|
| `server.js` | Цялата логика — инструментите + MCP сървърът |
| `manifest.json` | Манифест на разширението (версия, стартер, списък инструменти, конфигурация) |
| `package.json` | Зависимости |

## Инструменти (накратко)

- **Организация/екипи:** `make_list_organizations`, `make_list_teams`
- **Сценарии:** `make_list_scenarios`, `make_get_scenario`, `make_get_blueprint` (пълна JSON структура — модули/параметри/филтри/връзки), `make_clone_scenario` (безопасно копие за тест на промени)
- **Действия:** `make_run_scenario` (пусни сега), `make_start_scenario` (активирай), `make_stop_scenario` (деактивирай)
- **Следене:** `make_list_executions` (история), `make_get_execution` (детайли за едно изпълнение)
- **Data stores:** `make_list_data_stores`, `make_get_records`, `make_add_record`, `make_update_record`, `make_delete_record` (триене само на конкретни ключове)
- **Паднали изпълнения (DLQ):** `make_list_incomplete`, `make_retry_execution`, `make_get_dlq_bundle` (реалните данни зад провала), `make_delete_dlq` (триене само на конкретни id-та)
- **Webhooks:** `make_list_hooks`, `make_trigger_webhook`
- **Connections:** `make_list_connections`, `make_test_connection`
- **Друго:** `make_open_in_browser`

## Настройка (за потребители)

Потребителите **не инсталират нищо допълнително** — Claude Desktop носи вграден Node.

1. Свали последния `.mcpb` от **Releases** (или от фирмената папка).
2. Claude Desktop → Settings → Extensions → **Install from file** → избери `.mcpb`.
3. При инсталация попълни:
   - **Make API token** — създава се в Make: аватара горе вдясно → *Profile → API / MCP access → Add token*.
     Дай му scopes: `scenarios:read`, `scenarios:write`, `scenarios:run`, `teams:read`, `organizations:read`, `datastores:read`, `datastores:write`, `dlqs:read`, `dlqs:write`, `hooks:read`, `connections:read`, `connections:write`.
   - **Region (zone)** — виждаш го в URL-а на Make дашборда (напр. `eu1.make.com` → въведи `eu1`).
     Възможни: `eu1`, `eu2`, `us1`, `us2`. Грешен регион дава грешка за достъп дори с валиден токен.
   - **Organization ID / Team ID** (по желание) — ако имаш само една организация, се избира автоматично.
4. Пълен Quit + старт на Claude Desktop.

## За разработчици

```
npm install          # сваля зависимостите (нужно за билд/тест)
node --check server.js
```

Локален старт (нужни са env променливи):

```
# PowerShell
$env:MAKE_API_TOKEN="…"; $env:MAKE_ZONE="eu1"; node server.js
```

Полезни env променливи:

| Променлива | Смисъл |
|---|---|
| `MAKE_API_TOKEN` | API токенът (задължителен) |
| `MAKE_ZONE` | Регион: `eu1` (по подр.), `us1`… или пълен хост |
| `MAKE_API_BASE` | Пълен override на базовия URL (по желание) |
| `MAKE_ORG_ID` | Организация по подразбиране |
| `MAKE_TEAM_ID` | Екип по подразбиране |

## Билд на `.mcpb` (ръчно)

```
npm install
npx @anthropic-ai/mcpb pack . Make-mcp-<версия>.mcpb
```

`.mcpb` е zip с `manifest.json` в корена. `.mcpbignore` изключва `.git`, `.env` и др.

## Издаване на нова версия

1. Вдигни версията в `manifest.json` **и** `package.json`.
2. Билд на `.mcpb` и качване в Releases.

## Make API — бележки

- Базов URL: `https://{zone}.make.com/api/v2`
- Автентикация: header `Authorization: Token <токен>`
- Документация: https://developers.make.com/api-documentation
