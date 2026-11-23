# IceCraft CRM

Личная CRM IceCraft: заведения, касания, заказы, доставки, карта Таллинна, агенты.

- **Сайт:** GitHub Pages (этот репозиторий, ветка `main`, корень).
- **Вход и данные:** Supabase, проект `icecraft-crm` (Франкфурт). Таблица `public.docs`
  (`collection`, `id`, `data jsonb`), доступ только для пользователей из `crm_members` (RLS).
- **Карта:** `map/tallinn.pmtiles` — выгрузка Protomaps/OpenStreetMap (Эстония z0–9, Таллинн z10–14, центр z15).
  Пересобрать: `python3 tools/build_map.py <дата сборки protomaps>`.
- В репозитории нет данных клиентов. Публичный ключ Supabase в `crm-db.js` без входа ничего не открывает.

Коллекции: venues, activities, orders, places, drafts, agentlog, proposals, kb, tasks, routes, settings.
