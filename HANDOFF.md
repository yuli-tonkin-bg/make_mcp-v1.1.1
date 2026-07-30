# HANDOFF — продължаване на работата по разширяване на Make MCP

> **Как да продължиш (на другия лаптоп):** отвори Claude Code в папката `C:\Projects_MABI\make_mcp` (PowerShell + Claude, както обичайно) и кажи:
> *„Прочети HANDOFF.md и Make_MCP_Анализ_и_Препоръки.md и продължи оттам."*
> Този файл замества липсващия чат-контекст — транскриптите на Claude Code са локални и не се пренасят между машини.

**Дата на handoff:** 30.07.2026
**Автор на сесията:** Николай Стоянов (n.stoyanov@tonkin.bg)

---

## 1. Цел на работата

Проект „AI Консултации с Юли". Целта е **разширяване на собствения Make MCP сървър** (`server.js`, v1.3.0), защото Claude има твърде тесен достъп до Make.com — липсва достъп до структурата на сценариите (blueprint) и до реалните данни зад провалени изпълнения (DLQ bundle). Пълният анализ е в **`Make_MCP_Анализ_и_Препоръки.md`** (+ `.docx` версия) — задължително четиво.

## 2. Текущо състояние (какво е свършено)

- Направен е **пълен анализ** + ресърч от официалния Make Developer Hub, вписан в документа.
- **Трите отворени въпроса са отговорени и потвърдени:**
  - **Q1 (logs дълбочина):** обикновеният execution-log endpoint `GET /api/v2/scenarios/{id}/logs/{executionId}` връща **само метаданни** (0 модулни данни) — доказано на живо. Реалните per-module данни са достъпни през API **само** за провали през `GET /dlqs/{dlqId}/bundle`.
  - **Q2 (read scopes):** токенът демонстрирано има `scenarios:read`, `dlqs:read`, `connections:read` — доказано на живо (read-only сонди).
  - **Q3 (план/retention):** акаунтът е **Core**; retention = **30 дни** (потвърдено от сравнителната таблица: Free 7 / Core 30 / Pro 30 / Teams 30 / Enterprise 60); Make REST API е наличен на Core.
- **`server.js` НЕ е пипан.** Нищо не е commit-нато или push-нато.

## 3. Какво ОСТАВА (единствено)

- **Write scopes на токена** (`scenarios:write`, `dlqs:write`) — не са потвърдени емпирично (не мутираме жив акаунт за проверка). Проверяват се в **Make → профил → API / Authentication**. Нужни са **едва за P2+** (write инструментите), НЕ за P1.

## 4. Препоръчана следваща стъпка — изгради P1 (нулев риск, read-only)

Два нови инструмента в `server.js`, обвиващи вече доказани endpoint-и:

| Инструмент | Endpoint | Scope (доказан) |
|---|---|---|
| `make_get_blueprint(scenario_id)` | `GET /api/v2/scenarios/{id}/blueprint` | `scenarios:read` ✅ |
| `make_get_dlq_bundle(dlq_id)` | `GET /api/v2/dlqs/{id}/bundle` | `dlqs:read` ✅ |

Стъпки: добави двата tool-а в масива с tools + handler-и (следвай стила на съществуващите, напр. `make_get_execution` на ред ~292 и `make_list_incomplete`), регистрирай в `manifest.json`, bump версия → **1.4.0**.
**Внимание:** новите tool-ове се зареждат чак след **рестарт на MCP-то в Claude Desktop** — чак тогава се тестват на живо.

## 5. Ред на изграждане (от документа, раздел 6)

1. **P1** (горе) — read-only, нулев риск → тествай известно време
2. **P2 ниско-рисков write:** `make_clone_scenario` (`POST /scenarios/{id}/clone`), `make_delete_dlq` (`DELETE /dlqs`)
3. **P2 висока стойност:** `make_update_blueprint` (`PATCH /scenarios/{id}`) — само с модел „план → одобрение → действие", предпочитано върху клонинг
4. **P3:** `make_replay_execution` (`POST /scenarios/{id}/replay`), `make_get/update_scenario_interface`, `make_create_connection`

## 6. Задължителен модел за безопасност (не се компрометира)

Read-only по подразбиране · human-in-the-loop одобрение за всеки write · никакви разрушителни действия по подразбиране (bulk delete иска `confirmed=true`) · структурни промени върху **клонинг**, не върху живия сценарий · валидация на blueprint JSON преди PATCH · least-privilege токен · одит лог на write действия.

## 7. Технически бележки

- **MCP:** single-file `server.js`, ESM, `@modelcontextprotocol/sdk`. Base URL: `https://{zone}.make.com/api/v2` (зона по подразбиране `eu1`).
- **Токен:** идва през env var **`MAKE_API_TOKEN`**, инжектиран от Claude Desktop конфигурацията — **НЕ е в repo-то и НЕ е локален файл**. Също: `MAKE_ZONE`, `MAKE_ORG_ID`, `MAKE_TEAM_ID` (опц.).
- **Акаунт (за справка):** организация `4825958` („Yuli Tonkin 2"), екип `2422862`. Главен сценарий на проекта: `9518197` („Integration HTTP Консултации Юли — AI анализ и документ").
- **`.docx` се регенерира от `.md`** (source of truth) с python-docx. Скриптът беше в scratchpad (машинно-локален, не пренесен). При нужда се пресъздава: чете `.md`, гради `.docx` със заглавия/таблици/bold/code/blockquote/линкове. Конзолата е cp1252 → ползвай `PYTHONIOENCODING=utf-8` за кирилски print.

## 8. Git състояние към handoff

- Клон `main`, синхронен с `origin/main`. Untracked: двата документа + този HANDOFF.md. `server.js` без промени.
- ⚠️ Документите съдържат вътрешни данни (org/team/execution ID-та, инвентар на връзки). Ако се push-ва към GitHub — това ги съхранява на remote-а. Обмисли частен клон или ръчен пренос според чувствителността.
