// Tableau de bord — lit /api/stats (protege par ADMIN_TOKEN) et affiche
// qui vient, d'ou, et ce qu'on demande au clone. Aucune cle ici : seul le
// token saisi (garde en sessionStorage) est envoye au serveur.

(() => {
  const $ = (s) => document.querySelector(s);
  const gate = $("#gate");
  const dash = $("#dash");
  const toolbar = $("#toolbar");
  const charts = {};
  let data = null;

  const NAVY = "#14213d";
  const RED = "#c0392b";
  const PALETTE = ["#14213d", "#c0392b", "#4a6fa5", "#e07b39", "#7a8ca3", "#a93226", "#2f6f6f", "#b58b3a", "#5b5f97", "#9aa5b1"];

  const LABELS = {
    "parcours": "Parcours",
    "competences": "Competences",
    "mission": "Missions",
    "livrable": "Livrables",
    "methode": "Methode",
    "ia-data": "IA & Data",
    "disponibilite-tarif": "Dispo / tarif",
    "contact": "Contact",
    "projets-github": "Projets GitHub",
    "hors-sujet": "Hors sujet",
    "autre": "Autre",
    "non classe": "Non classe",
    chaud: "Chaud",
    tiede: "Tiede",
    froid: "Froid",
  };
  const label = (k) => LABELS[k] || k;

  // --- Token ---
  const getToken = () => {
    try {
      return sessionStorage.getItem("ad_admin_token") || "";
    } catch {
      return "";
    }
  };
  const setToken = (t) => {
    try {
      if (t) sessionStorage.setItem("ad_admin_token", t);
      else sessionStorage.removeItem("ad_admin_token");
    } catch {
      /* ignore */
    }
  };

  // --- Chargement ---
  async function load() {
    const token = getToken();
    if (!token) return showGate();
    const days = $("#days").value;
    $("#status").textContent = "Chargement…";
    let res;
    try {
      res = await fetch(`/api/stats?days=${encodeURIComponent(days)}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
    } catch {
      return showGate("Connexion impossible.");
    }
    if (res.status === 401) {
      setToken("");
      return showGate("Token invalide.");
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return showGate(json.error || "Erreur serveur.");
    if (json.enabled === false) {
      return showGate(json.error || "Statistiques desactivees : configure DATABASE_URL sur Vercel.");
    }
    data = json;
    render();
  }

  function showGate(msg) {
    gate.hidden = false;
    dash.hidden = true;
    toolbar.hidden = true;
    const err = $("#gate-error");
    err.hidden = !msg;
    err.textContent = msg || "";
  }

  // --- Rendu ---
  const fmt = (n) => new Intl.NumberFormat("fr-FR").format(n || 0);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + " %" : "—");
  const esc = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const when = (ts) =>
    new Date(ts).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

  function render() {
    gate.hidden = true;
    dash.hidden = false;
    toolbar.hidden = false;
    const t = data.totals;
    $("#status").textContent = `Periode : ${data.days} derniers jours · calcule le ${new Date(data.generatedAt).toLocaleString("fr-FR")}`;

    renderKpis(t);
    renderSeries(data.series);
    bar("c-sources", data.sources, NAVY);
    bar("c-countries", data.countries, "#4a6fa5");
    bar("c-themes", data.themes.map((r) => ({ ...r, label: label(r.label) })), RED);
    doughnut("c-intents", data.intents.map((r) => ({ ...r, label: label(r.label) })));
    renderUtm(data.utm);
    renderCities(data.cities, data.devices);
    renderLeads(data.leads);
    fillThemeFilter(data.recent);
    renderConvs();
  }

  function renderKpis(t) {
    const tiles = [
      { l: "Visites", v: fmt(t.visits), s: `${fmt(t.visitors)} visiteurs uniques` },
      { l: "Revenus", v: fmt(t.returning), s: "visiteurs vus plusieurs jours" },
      { l: "Conversations", v: fmt(t.conversations), s: `${fmt(t.askers)} visiteurs ont pose une question` },
      { l: "Questions", v: fmt(t.questions), s: t.conversations ? `${(t.questions / t.conversations).toFixed(1)} par conversation` : "" },
      { l: "Conversion", v: pct(t.askers, t.visitors), s: "visiteurs → question posee" },
      { l: "Leads", v: fmt(t.leads), s: `${fmt(t.hot)} intentions chaudes`, hot: true },
      { l: "Latence moy.", v: t.avgLatencyMs ? (t.avgLatencyMs / 1000).toFixed(1) + " s" : "—", s: `${fmt(t.errors)} erreurs · ${fmt(t.rateLimited)} bloquees` },
      { l: "Tokens", v: fmt(t.tokensIn + t.tokensOut), s: `${fmt(t.tokensIn)} entree · ${fmt(t.tokensOut)} sortie · ${pct(t.cacheRead, t.tokensIn)} en cache` },
    ];
    $("#kpis").innerHTML = tiles
      .map(
        (k) => `<div class="kpi${k.hot ? " kpi--hot" : ""}">
          <div class="kpi__label">${esc(k.l)}</div>
          <div class="kpi__value">${esc(k.v)}</div>
          <div class="kpi__sub">${esc(k.s)}</div></div>`,
      )
      .join("");
  }

  // Si Chart.js n'a pas pu charger (CDN bloque), on affiche un repli HTML :
  // le tableau de bord reste lisible quoi qu'il arrive.
  const hasChart = () => typeof window.Chart === "function";

  function fallbackList(id, rows) {
    const canvas = document.getElementById(id);
    const box = canvas.parentElement;
    const max = Math.max(1, ...rows.map((r) => r.n || 0));
    box.classList.add("chart--fallback");
    box.innerHTML = rows.length
      ? rows
          .map(
            (r) => `<div class="fb"><span class="fb__label">${esc(r.label)}</span>
              <span class="fb__bar"><span style="width:${Math.round(((r.n || 0) / max) * 100)}%"></span></span>
              <span class="fb__n">${fmt(r.n)}</span></div>`,
          )
          .join("")
      : `<p class="empty">Pas encore de donnees.</p>`;
  }

  function chart(id, config) {
    if (!hasChart()) {
      const ds = config.data.datasets[0];
      const rows = config.data.labels.map((label, i) => ({ label, n: ds.data[i] }));
      return fallbackList(id, config.type === "line" ? rows.slice(-10) : rows);
    }
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(document.getElementById(id), config);
  }
  const baseOpts = { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } };

  function renderSeries(s) {
    chart("c-series", {
      type: "line",
      data: {
        labels: s.map((r) => r.day.slice(5).split("-").reverse().join("/")),
        datasets: [
          { label: "Visites", data: s.map((r) => r.visits), borderColor: NAVY, backgroundColor: "rgba(20,33,61,.08)", fill: true, tension: 0.3, pointRadius: 2 },
          { label: "Questions", data: s.map((r) => r.questions), borderColor: RED, backgroundColor: "transparent", tension: 0.3, pointRadius: 2 },
          { label: "Leads", data: s.map((r) => r.leads), borderColor: "#e07b39", backgroundColor: "transparent", tension: 0.3, pointRadius: 2, borderDash: [4, 3] },
        ],
      },
      options: {
        ...baseOpts,
        plugins: { legend: { display: true, position: "bottom" } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, x: { ticks: { maxTicksLimit: 12 } } },
        interaction: { mode: "index", intersect: false },
      },
    });
  }

  function bar(id, rows, color) {
    chart(id, {
      type: "bar",
      data: { labels: rows.map((r) => r.label), datasets: [{ data: rows.map((r) => r.n), backgroundColor: color, borderRadius: 4 }] },
      options: { ...baseOpts, indexAxis: "y", scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } },
    });
  }

  function doughnut(id, rows) {
    const colors = rows.map((r) => ({ Chaud: RED, Tiede: "#e07b39", Froid: "#4a6fa5" })[r.label] || "#9aa5b1");
    chart(id, {
      type: "doughnut",
      data: { labels: rows.map((r) => r.label), datasets: [{ data: rows.map((r) => r.n), backgroundColor: colors }] },
      options: { ...baseOpts, cutout: "62%", plugins: { legend: { display: true, position: "bottom" } } },
    });
  }

  function table(id, head, rows, empty) {
    const el = document.getElementById(id);
    if (!rows.length) {
      el.innerHTML = `<tbody><tr><td class="empty">${esc(empty)}</td></tr></tbody>`;
      return;
    }
    el.innerHTML =
      `<thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>` +
      `<tbody>${rows.map((r) => `<tr>${r.join("")}</tr>`).join("")}</tbody>`;
  }
  const td = (v, cls = "") => `<td${cls ? ` class="${cls}"` : ""}>${v}</td>`;

  function renderUtm(rows) {
    table(
      "t-utm",
      ["Source", "Medium", "Campagne", "Visites"],
      rows.map((r) => [td(esc(r.source || "—")), td(esc(r.medium || "—")), td(esc(r.campaign || "—")), td(fmt(r.n), "num")]),
      "Aucune campagne taguee pour l'instant. Ajoute ?utm_source=linkedin&utm_campaign=post-sept a tes liens.",
    );
  }

  function renderCities(cities, devices) {
    const rows = cities.map((r) => [td(esc(r.label)), td(fmt(r.n), "num")]);
    if (devices.length) {
      rows.push([td(`<strong>Appareils</strong>`), td("")]);
      devices.forEach((d) => rows.push([td(esc(d.label)), td(fmt(d.n), "num")]));
    }
    table("t-cities", ["Ville", "Visiteurs"], rows, "Pas encore de visites geolocalisees.");
  }

  function badges(r) {
    const out = [];
    if (r.intent) out.push(`<span class="badge badge--${esc(r.intent)}">${esc(label(r.intent))}</span>`);
    if (r.theme) out.push(`<span class="badge">${esc(label(r.theme))}</span>`);
    if (r.lead) out.push(`<span class="badge badge--lead">Lead</span>`);
    return out.join(" ");
  }

  function renderLeads(rows) {
    table(
      "t-leads",
      ["Quand", "Question", "Contact", "Qualification", "Lieu"],
      rows.map((r) => [
        td(esc(when(r.ts))),
        td(esc(r.question)),
        td(r.contact ? `<strong>${esc(r.contact)}</strong>` : "—"),
        td(badges(r)),
        td(esc([r.city, r.country].filter(Boolean).join(", ") || "—")),
      ]),
      "Aucun lead sur la periode. Les intentions chaudes et les contacts laisses apparaitront ici.",
    );
  }

  function fillThemeFilter(recent) {
    const sel = $("#q-theme");
    const current = sel.value;
    const themes = [...new Set(recent.map((r) => r.theme).filter(Boolean))].sort();
    sel.innerHTML =
      `<option value="">Tous les themes</option>` +
      themes.map((t) => `<option value="${esc(t)}">${esc(label(t))}</option>`).join("");
    sel.value = themes.includes(current) ? current : "";
  }

  function renderConvs() {
    if (!data) return;
    const q = $("#q-search").value.trim().toLowerCase();
    const theme = $("#q-theme").value;
    const intent = $("#q-intent").value;
    const leadOnly = $("#q-lead").checked;

    const rows = data.recent.filter(
      (r) =>
        (!q || (r.question || "").toLowerCase().includes(q)) &&
        (!theme || r.theme === theme) &&
        (!intent || r.intent === intent) &&
        (!leadOnly || r.lead),
    );

    // Regroupe par conversation (ordre : la plus recente d'abord).
    const groups = new Map();
    for (const r of rows) {
      const key = r.conversation_id || `solo-${r.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }

    const el = $("#convs");
    if (!groups.size) {
      el.innerHTML = `<p class="empty">Aucune conversation ne correspond.</p>`;
      return;
    }
    el.innerHTML = [...groups.values()]
      .map((msgs) => {
        const first = msgs[msgs.length - 1];
        const last = msgs[0];
        const place = [first.city, first.country].filter(Boolean).join(", ");
        const hasLead = msgs.some((m) => m.lead);
        const meta = [
          `<span>${esc(when(first.ts))}${msgs.length > 1 ? " → " + esc(when(last.ts)) : ""}</span>`,
          `<span>${msgs.length} question${msgs.length > 1 ? "s" : ""}</span>`,
          place ? `<span>${esc(place)}</span>` : "",
          first.device ? `<span>${esc(first.device)}</span>` : "",
          first.visitor_id ? `<span title="identifiant visiteur anonyme">visiteur ${esc(first.visitor_id.slice(0, 6))}</span>` : "",
          hasLead ? `<span class="badge badge--lead">Lead</span>` : "",
        ]
          .filter(Boolean)
          .join("");
        const items = [...msgs]
          .reverse()
          .map(
            (m) => `<div class="conv__q">
              <span class="q">${esc(m.question)}</span><span class="tags">${badges(m)}${
                m.status !== "ok" ? `<span class="badge">${esc(m.status)}</span>` : ""
              }</span>
              ${m.reply ? `<details><summary>Voir la reponse</summary><div class="r">${esc(m.reply)}</div></details>` : ""}
            </div>`,
          )
          .join("");
        return `<article class="conv"><div class="conv__meta">${meta}</div>${items}</article>`;
      })
      .join("");
  }

  // --- Export CSV (questions de la periode) ---
  function exportCsv() {
    if (!data) return;
    const cols = ["ts", "visitor_id", "conversation_id", "country", "city", "device", "theme", "intent", "lead", "contact", "question", "reply"];
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [cols.join(";"), ...data.recent.map((r) => cols.map((c) => cell(r[c])).join(";"))];
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ask-desailly-questions-${data.days}j.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // --- Evenements ---
  $("#gate-form").addEventListener("submit", (e) => {
    e.preventDefault();
    setToken($("#token").value.trim());
    $("#token").value = "";
    load();
  });
  $("#days").addEventListener("change", load);
  $("#refresh").addEventListener("click", load);
  $("#export").addEventListener("click", exportCsv);
  $("#logout").addEventListener("click", () => {
    setToken("");
    showGate();
  });
  ["#q-search", "#q-theme", "#q-intent", "#q-lead"].forEach((s) =>
    $(s).addEventListener("input", renderConvs),
  );

  load();
})();
