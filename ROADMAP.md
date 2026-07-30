# Roadmap — make-mcp

Посока за развитие на конектора, базирана на **доказани, работещи** практики —
официалния Make MCP сървър и зрелите части от Make API v2.

## Текущо състояние (v1.1.2)

- **10 инструмента**, всички тествани срещу реалния Make API (**10/10**)
- Автоматичен release pipeline (таг `v*` → `.mcpb` в Releases)
- Cold-start фикс — stdio транспортът се свързва преди зареждането на корпоративните
  сертификати (`initialize` отговаря мигновено дори при свежа инсталация)

Налични инструменти: `make_list_organizations`, `make_list_teams`, `make_list_scenarios`,
`make_get_scenario`, `make_run_scenario`, `make_start_scenario`, `make_stop_scenario`,
`make_list_executions`, `make_get_execution`, `make_open_in_browser`.

> **Научено при тестовете:** `make_run_scenario` изисква сценарият да е **активен** —
> Make връща HTTP 422 „Scenario is not activated" за on-demand пускане на неактивен
> сценарий. (За неактивни: „Run once" през UI + четене през `make_list_executions`.)

## Ориентир

Официалният **Make MCP** има ~67 инструмента с две ядра: **Scenario Management**
(list/run/activate/deactivate + create/update/delete) и **Data Operations** (data stores).
Най-голямата ни доказана липса е **работа с данни** и **операционна надеждност**.

---

## Tier 1 — висока стойност, доказани, нисък риск

| Функция | Инструменти | Endpoints |
|---|---|---|
| **Data stores** | `make_list_data_stores`, `make_get_records`, `make_add_record`, `make_update_record`, `make_delete_record` | `GET /data-stores?teamId=`, `GET/POST/PUT/DELETE /data-stores/{id}/data` |
| **Retry на паднали изпълнения (DLQ)** | `make_list_incomplete`, `make_retry_execution` | `GET /dlqs?scenarioId=`, `POST /dlqs/{id}/retry`, `POST /dlqs/retry` |
| **Webhooks (задействане)** | `make_list_hooks`, `make_trigger_webhook` | `GET /hooks`, POST към webhook URL |

## Tier 2 — полезни, доказани

| Функция | Стойност |
|---|---|
| **Connections (list)** — `GET /connections` | Диагностика: свързани / счупени интеграции |
| **Blueprint (само четене)** — `GET` blueprint | Точна диагностика без редактиране (безопасно) |
| **Custom variables (четене/задаване)** | Общи стойности за сценариите |

## Tier 3 — мощни, по-рисково (само със защити)

- **create/update/delete scenarios** — само с потвърждение + backup
- **Blueprint редакция** — с резервно копие + валидация + прицелни промени
- **AI Agents / Templates / Notifications** — нови/нишови

---

## Инженерни оптимизации (доказани best practices)

| Оптимизация | Защо | Статус |
|---|---|---|
| Cold-start фикс (connect преди CA) | `initialize` мигновено при свежа инсталация | ✅ v1.1.2 |
| Rate-limit обработка (429 + Retry-After) | Make има лимити според плана | планирано |
| Компактни отговори (`cols[]` + трим) | По-малко контекст/токени | планирано |
| Кеш на org/team | По-малко излишни заявки | планирано |
| Retry при 5xx | Устойчивост | планирано |

> Новите функции изискват **нови scopes** на токена: `dlqs:read/write`, `connections:read`,
> `hooks:read`, права за data stores.

---

## Версии

| Версия | Съдържание |
|---|---|
| **v1.1.2** ✅ | Cold-start фикс |
| **v1.2.0** ✅ | Data stores (5 инструмента) + уточнено описание на `make_run_scenario` („изисква активен сценарий") |
| **v1.3.0** ✅ | DLQ retry + webhooks + connections (6 инструмента) |
| **v1.4.0** ✅ | П1 от Make_MCP_Анализ_и_Препоръки.md: `make_get_blueprint` + `make_get_dlq_bundle` (read-only, 2 инструмента) |
| **v1.4.1** ✅ | fix: default zone `eu1` → `eu2` (грешен default даваше 401 при инсталация с валиден токен) |
| **v1.5.0** | П2: `make_clone_scenario`, `make_delete_dlq` (ниско-рискови write) → едва тогава `make_update_blueprint` (план→одобрение→действие) |
| **Бъдеще** | Tier 3 със защити (create/update, blueprint edit) |

---

## Източници

- [Make MCP Server (Developer Hub)](https://developers.make.com/mcp-server)
- [Make MCP — What/How](https://www.make.com/en/mcp)
- [Make Cloud MCP](https://developers.make.com/mcp-server/make-cloud-mcp-server)
- [Data Stores API](https://developers.make.com/api-documentation/api-reference/data-stores)
- [Incomplete Executions (DLQ)](https://developers.make.com/api-documentation/api-reference/incomplete-executions)
- [Hooks](https://developers.make.com/api-documentation/api-reference/hooks)
- [API Reference](https://developers.make.com/api-documentation/api-reference)
