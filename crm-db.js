/* IceCraft CRM — вход и база данных (Supabase).
 * Даёт странице тот же интерфейс, что был у базы claude.ai:
 *   db.collection(c).onSnapshot(cb, err) / .add(data) / .doc(id).update|set|delete|onSnapshot
 *   db.doc("c/id").set|onSnapshot
 * Данные лежат в таблице public.docs (collection, id, data jsonb). Доступ — только после входа
 * и только для пользователей из crm_members (правила RLS в базе).
 */
(function () {
  "use strict";
  const CFG = {
    url: "https://sdphjmxuucpcoaqnufhu.supabase.co",
    key: "sb_publishable_-KM6YVe6QhuMgCG1__UzrQ_sc2XL3qw", // публичный ключ: без входа он ничего не открывает
  };
  const COLLECTIONS = ["venues", "activities", "orders", "places", "drafts", "agentlog", "proposals", "kb", "tasks", "routes", "settings"];

  const sb = window.supabase.createClient(CFG.url, CFG.key, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "icecraft-crm-auth" },
  });

  const err = (code, message) => Object.assign(new Error(message || code), { code });
  const newId = () => {
    const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", b = new Uint8Array(20);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => a[x % a.length]).join("");
  };

  /* ---------- локальный кеш коллекций + подписки ---------- */
  const store = {}; // c -> { rows: Map(id -> data), loaded: Promise, subs: Set }
  function coll(c) {
    if (!store[c]) store[c] = { rows: new Map(), loaded: null, subs: new Set(), docSubs: new Map() };
    return store[c];
  }
  async function loadAll(c) {
    const s = coll(c);
    if (s.loaded) return s.loaded;
    s.loaded = (async () => {
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await sb.from("docs").select("id,data").eq("collection", c).range(from, from + PAGE - 1);
        if (error) throw error;
        data.forEach((r) => s.rows.set(r.id, r.data));
        if (data.length < PAGE) break;
      }
    })();
    try { await s.loaded; } catch (e) { s.loaded = null; throw e; }
  }
  const docSnap = (id, data) => ({ id, exists: data !== undefined, data: () => (data === undefined ? undefined : JSON.parse(JSON.stringify(data))) });
  const pending = new Set();
  function notify(c) {
    pending.add(c);
    if (pending.size > 1) return;
    queueMicrotask(() => {
      const list = [...pending]; pending.clear();
      list.forEach((cc) => {
        const s = coll(cc);
        const snap = { docs: [...s.rows].map(([id, d]) => docSnap(id, d)) };
        snap.size = snap.docs.length; snap.empty = !snap.size;
        s.subs.forEach((fn) => { try { fn(snap); } catch (e) { console.error(e); } });
        s.docSubs.forEach((set, id) => set.forEach((fn) => { try { fn(docSnap(id, s.rows.get(id))); } catch (e) { console.error(e); } }));
      });
    });
  }
  function applyLocal(c, id, data) {
    const s = coll(c);
    if (data === undefined) s.rows.delete(id); else s.rows.set(id, data);
    notify(c);
  }

  /* ---------- живые обновления с других устройств и от агентов ---------- */
  let channel = null;
  function startRealtime() {
    if (channel) return;
    channel = sb.channel("crm-docs")
      .on("postgres_changes", { event: "*", schema: "public", table: "docs" }, (p) => {
        const row = p.eventType === "DELETE" ? p.old : p.new;
        if (!row || !row.collection || !store[row.collection]) return;
        applyLocal(row.collection, row.id, p.eventType === "DELETE" ? undefined : row.data);
      })
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") console.warn("realtime:", status);
      });
    // после сна телефона / потери сети — перечитать всё
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshAll();
    });
    window.addEventListener("online", refreshAll);
  }
  let lastRefresh = Date.now();
  async function refreshAll() {
    if (Date.now() - lastRefresh < 30000) return;
    lastRefresh = Date.now();
    for (const c of Object.keys(store)) {
      const s = store[c];
      if (!s.subs.size && !s.docSubs.size) continue;
      const fresh = new Map();
      try {
        for (let from = 0; ; from += 1000) {
          const { data, error } = await sb.from("docs").select("id,data").eq("collection", c).range(from, from + 999);
          if (error) throw error;
          data.forEach((r) => fresh.set(r.id, r.data));
          if (data.length < 1000) break;
        }
        s.rows = fresh; notify(c);
      } catch (e) { console.warn("refresh", c, e); }
    }
  }

  /* ---------- API в стиле старой базы ---------- */
  function docRef(c, id) {
    return {
      id,
      async set(data) {
        const clean = JSON.parse(JSON.stringify(data));
        const { error } = await sb.from("docs").upsert({ collection: c, id, data: clean });
        if (error) throw error;
        applyLocal(c, id, clean);
      },
      async update(patch) {
        const clean = JSON.parse(JSON.stringify(patch));
        const { data, error } = await sb.rpc("docs_merge", { p_collection: c, p_id: id, p_patch: clean });
        if (error) throw error;
        if (data == null) throw err("not_found", "Запись не найдена");
        applyLocal(c, id, data);
      },
      async delete() {
        const { error } = await sb.from("docs").delete().eq("collection", c).eq("id", id);
        if (error) throw error;
        applyLocal(c, id, undefined);
      },
      async get() {
        await loadAll(c);
        return docSnap(id, coll(c).rows.get(id));
      },
      onSnapshot(cb, onErr) {
        const s = coll(c);
        if (!s.docSubs.has(id)) s.docSubs.set(id, new Set());
        s.docSubs.get(id).add(cb);
        loadAll(c).then(() => cb(docSnap(id, s.rows.get(id))), (e) => onErr && onErr(e));
        return () => s.docSubs.get(id).delete(cb);
      },
    };
  }
  const db = {
    collection(c) {
      return {
        doc: (id) => docRef(c, id || newId()),
        async add(data) {
          const id = newId();
          await docRef(c, id).set(data);
          return { id };
        },
        onSnapshot(cb, onErr) {
          const s = coll(c);
          s.subs.add(cb);
          loadAll(c).then(() => notify(c), (e) => onErr && onErr(e));
          return () => s.subs.delete(cb);
        },
      };
    },
    doc(path) {
      const [c, id] = String(path).split("/");
      return docRef(c, id);
    },
  };

  /* ---------- экран входа ---------- */
  const css = `
  #auth{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;background:var(--bg,#f6f7f9);padding:20px;font:15px/1.45 Inter,system-ui,-apple-system,sans-serif;color:var(--fg,#16181d)}
  #auth .card{width:100%;max-width:360px;background:var(--panel,#fff);border:1px solid var(--line,#e3e6eb);border-radius:14px;padding:26px 24px;box-shadow:0 10px 30px rgba(0,0,0,.06)}
  #auth h1{font-size:20px;margin:0 0 4px} #auth p{margin:0 0 16px;color:var(--muted,#6b7280);font-size:14px}
  #auth label{display:block;font-size:13px;margin:10px 0 4px;color:var(--muted,#6b7280)}
  #auth input,#auth textarea{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--line,#d6dae1);border-radius:9px;font:inherit;background:transparent;color:inherit}
  #auth button{width:100%;margin-top:16px;padding:11px;border:0;border-radius:9px;background:#1f6feb;color:#fff;font:600 15px Inter,system-ui,sans-serif;cursor:pointer}
  #auth button.sec{background:transparent;color:inherit;border:1px solid var(--line,#d6dae1);margin-top:10px}
  #auth button:disabled{opacity:.6;cursor:default}
  #auth .msg{min-height:20px;margin-top:10px;font-size:13px;color:#c0392b}
  #auth .ok{color:#1a7f37}
  @media (prefers-color-scheme:dark){#auth{background:#0f1115;color:#e7e9ee}#auth .card{background:#171a21;border-color:#2a2f3a}#auth input,#auth textarea{border-color:#2f3542}}`;
  function el(html) { const d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstChild; }
  function showAuth(html) {
    let a = document.getElementById("auth");
    if (!a) {
      const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
      a = el('<div id="auth"></div>'); document.body.appendChild(a);
    }
    a.innerHTML = `<div class="card">${html}</div>`;
    a.hidden = false;
    return a;
  }
  const hideAuth = () => { const a = document.getElementById("auth"); if (a) a.hidden = true; };
  const ruErr = (e) => {
    const m = (e && (e.message || e.msg)) || String(e);
    if (/Invalid login credentials/i.test(m)) return "Неверный email или пароль";
    if (/Email not confirmed/i.test(m)) return "Email не подтверждён — откройте письмо от Supabase";
    if (/rate limit|too many/i.test(m)) return "Слишком много попыток, подождите минуту";
    if (/Failed to fetch|NetworkError/i.test(m)) return "Нет связи с сервером. Проверьте интернет; если не помогает — проект Supabase мог уснуть (откройте supabase.com и нажмите Restore).";
    return m;
  };

  function loginForm() {
    return new Promise((resolve) => {
      const a = showAuth(`
        <h1>IceCraft CRM</h1><p>Войдите, чтобы открыть базу.</p>
        <form id="af">
          <label for="ae">Email</label><input id="ae" type="email" autocomplete="username" required>
          <label for="ap">Пароль</label><input id="ap" type="password" autocomplete="current-password" required>
          <button id="ab" type="submit">Войти</button>
          <div class="msg" id="am"></div>
        </form>`);
      a.querySelector("#ae").focus();
      a.querySelector("#af").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const b = a.querySelector("#ab"), m = a.querySelector("#am");
        b.disabled = true; m.textContent = "";
        const { data, error } = await sb.auth.signInWithPassword({ email: a.querySelector("#ae").value.trim(), password: a.querySelector("#ap").value });
        b.disabled = false;
        if (error) { m.textContent = ruErr(error); return; }
        resolve(data.session);
      });
    });
  }

  async function mfaIfNeeded() {
    const { data } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (!data || data.nextLevel !== "aal2" || data.currentLevel === "aal2") return;
    const { data: f } = await sb.auth.mfa.listFactors();
    const totp = f && f.totp && f.totp[0];
    if (!totp) return;
    await new Promise((resolve) => {
      const a = showAuth(`<h1>Код подтверждения</h1><p>Введите 6 цифр из приложения-аутентификатора.</p>
        <form id="mf"><input id="mc" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
        <button id="mb" type="submit">Подтвердить</button><div class="msg" id="mm"></div></form>`);
      a.querySelector("#mc").focus();
      a.querySelector("#mf").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: totp.id, code: a.querySelector("#mc").value.trim() });
        if (error) { a.querySelector("#mm").textContent = "Неверный код"; return; }
        resolve();
      });
    });
  }

  async function checkMember() {
    const { data, error } = await sb.from("crm_members").select("role").limit(1);
    if (error) throw error;
    return data && data[0] ? data[0].role : null;
  }

  /* ---------- импорт из старой CRM (один раз) ---------- */
  async function importScreen() {
    return new Promise((resolve) => {
      const a = showAuth(`
        <h1>Перенос данных</h1>
        <p>База пока пустая. Загрузите файл <b>icecraft-crm-export.json</b>, сохранённый кнопкой «Выгрузить для переноса» в старой CRM, или вставьте его текст.</p>
        <input id="if" type="file" accept=".json,application/json">
        <label for="it">…или вставьте текст</label><textarea id="it" rows="4" placeholder='{"venues":[…]}'></textarea>
        <button id="ib">Загрузить в базу</button>
        <button id="is" class="sec">Пропустить — начать с пустой базы</button>
        <div class="msg" id="im"></div>`);
      const m = a.querySelector("#im");
      a.querySelector("#is").onclick = () => resolve(false);
      a.querySelector("#ib").onclick = async () => {
        const b = a.querySelector("#ib");
        let text = a.querySelector("#it").value.trim();
        const f = a.querySelector("#if").files[0];
        if (f) text = await f.text();
        if (!text) { m.textContent = "Выберите файл или вставьте текст"; return; }
        let dump;
        try { dump = JSON.parse(text); } catch (e) { m.textContent = "Это не JSON-файл выгрузки"; return; }
        const rows = [];
        Object.entries(dump.collections || dump).forEach(([c, docs]) => {
          if (!COLLECTIONS.includes(c) || !Array.isArray(docs)) return;
          docs.forEach((d) => d && d.id && rows.push({ collection: c, id: String(d.id), data: d.data || {} }));
        });
        if (!rows.length) { m.textContent = "В файле нет записей CRM"; return; }
        b.disabled = true; m.className = "msg ok";
        for (let i = 0; i < rows.length; i += 200) {
          m.textContent = `Загружаю… ${Math.min(i + 200, rows.length)} из ${rows.length}`;
          const { error } = await sb.from("docs").upsert(rows.slice(i, i + 200));
          if (error) { b.disabled = false; m.className = "msg"; m.textContent = "Ошибка: " + ruErr(error); return; }
        }
        const counts = {};
        rows.forEach((r) => (counts[r.collection] = (counts[r.collection] || 0) + 1));
        m.textContent = "Готово: " + Object.entries(counts).map(([c, n]) => `${c} ${n}`).join(", ");
        setTimeout(() => resolve(true), 1200);
      };
    });
  }

  async function isEmpty() {
    const { count, error } = await sb.from("docs").select("id", { count: "exact", head: true });
    if (error) throw error;
    return !count;
  }

  /* ---------- запуск ---------- */
  async function connect() {
    let { data: { session } } = await sb.auth.getSession();
    if (!session) session = await loginForm();
    await mfaIfNeeded();
    let role;
    try { role = await checkMember(); } catch (e) {
      showAuth(`<h1>Нет связи с базой</h1><p>${ruErr(e)}</p><button onclick="location.reload()">Повторить</button>`);
      return new Promise(() => {});
    }
    if (!role) {
      showAuth(`<h1>Нет доступа</h1><p>Аккаунт ${session.user.email} не добавлен в CRM.</p><button id="lo">Выйти</button>`);
      document.getElementById("lo").onclick = async () => { await sb.auth.signOut(); location.reload(); };
      return new Promise(() => {});
    }
    if (role !== "viewer" && (await isEmpty())) await importScreen();
    hideAuth();
    startRealtime();
    return { db, role, email: session.user.email };
  }

  sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_OUT") location.reload(); });

  window.CRM = {
    connect,
    sb,
    signOut: async () => { await sb.auth.signOut(); },
  };
})();
