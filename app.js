/* ============================================================
   BALANCÍMETRO · app.js
   Controle financeiro para motoristas de entregas/fretes.
   Tudo em LocalStorage, 100% offline.
============================================================ */

(() => {
  'use strict';

  /* ---------------------------------------------------------
     1. CONSTANTES E TABELAS DE PREÇO
  --------------------------------------------------------- */

  const STORAGE_KEYS = {
    SETTINGS: 'rc_settings',
    DAYS: 'rc_days',          // { 'YYYY-MM-DD': DayRecord }
    FUEL: 'rc_fuel_history',  // [ FuelRecord ]
    THEME: 'rc_theme',        // 'orange' | 'dark'
    NOTIF: 'rc_notif_state'   // { lastReminder: 'YYYY-MM-DD', lastMilestone: 0 }
  };

  // Tabela de valor por KM, por tipo de veículo e faixa de KM.
  // Cada faixa é avaliada pelo KM TOTAL da rota (não progressivo).
  const RATE_TABLE = {
    passeio: [
      { max: 100, value: 224.30 },
      { max: 150, value: 256.30 },
      { max: 200, value: 293.00 },
      { max: 300, value: 329.60 },
      { max: Infinity, value: 361.60 }
    ],
    utilitario: [
      { max: 100, value: 284.10 },
      { max: 150, value: 325.40 },
      { max: 200, value: 371.20 },
      { max: 300, value: 412.50 },
      { max: Infinity, value: 458.30 }
    ],
    van: [
      { max: 100, value: 373.00 },
      { max: 150, value: 429.00 },
      { max: 200, value: 485.00 },
      { max: 300, value: 542.00 },
      { max: Infinity, value: 598.00 }
    ],
    vuc: [
      { max: 100, value: 570.00 },
      { max: 150, value: 617.00 },
      { max: 200, value: 675.00 },
      { max: 300, value: 695.00 },
      { max: Infinity, value: 748.00 }
    ],
    // "Luxo" não foi definido na tabela original do usuário.
    // Usamos um multiplicador sobre a tabela "van" como estimativa segura,
    // mantendo a mesma lógica de faixas.
    luxo: [
      { max: 100, value: 373.00 * 1.35 },
      { max: 150, value: 429.00 * 1.35 },
      { max: 200, value: 485.00 * 1.35 },
      { max: 300, value: 542.00 * 1.35 },
      { max: Infinity, value: 598.00 * 1.35 }
    ]
  };

  const VEHICLE_LABELS = {
    passeio: 'Passeio',
    utilitario: 'Utilitário',
    van: 'Van',
    vuc: 'VUC',
    luxo: 'Luxo'
  };

  const FERIADO_MULTIPLIER = 1.2;

  /* ---------------------------------------------------------
     2. UTILITÁRIOS
  --------------------------------------------------------- */

  const fmtBRL = (value) => {
    const n = Number.isFinite(value) ? value : 0;
    return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  const fmtKM = (value) => {
    const n = Number.isFinite(value) ? value : 0;
    return `${n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km`;
  };

  const todayKey = (d = new Date()) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const parseKey = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  };

  const fmtDateLabel = (key) => {
    const d = parseKey(key);
    return d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' });
  };

  const fmtDateShort = (key) => {
    const d = parseKey(key);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  };

  const clampNum = (v, fallback = 0) => {
    const n = parseFloat(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };

  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  /* ---------------------------------------------------------
     3. PERSISTÊNCIA (LocalStorage)
  --------------------------------------------------------- */

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed ?? fallback;
    } catch (e) {
      console.warn('Falha ao ler', key, e);
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.warn('Falha ao salvar', key, e);
      return false;
    }
  }

  const defaultSettings = () => ({
    vehicle: 'passeio',
    inicioQuinzena: todayKey(),
    metaQuinzena: 0,
    notifEnabled: false,
    notifHour: '20:00'
  });

  let state = {
    settings: loadJSON(STORAGE_KEYS.SETTINGS, defaultSettings()),
    days: loadJSON(STORAGE_KEYS.DAYS, {}),
    fuel: loadJSON(STORAGE_KEYS.FUEL, [])
  };

  function persistSettings() { saveJSON(STORAGE_KEYS.SETTINGS, state.settings); }
  function persistDays() { saveJSON(STORAGE_KEYS.DAYS, state.days); }
  function persistFuel() { saveJSON(STORAGE_KEYS.FUEL, state.fuel); }

  /* ---------------------------------------------------------
     4. MODELO DE DIA
     DayRecord = {
       kmInicial: number|null,
       kmFinal: number|null,
       gastosExtra: number,
       encerrado: boolean,
       routes: [ RouteRecord ]
     }
     RouteRecord = {
       id, km, paradas, feriado, vehicle, consumo,
       valorKm, valorParadas, faturamento,
       combustivel, lucro, precoUsado, createdAt
     }
  --------------------------------------------------------- */

  function getDay(key) {
    if (!state.days[key]) {
      state.days[key] = {
        kmInicial: null,
        kmFinal: null,
        gastosExtra: 0,
        encerrado: false,
        routes: []
      };
    }
    return state.days[key];
  }

  function ensureDayExists(key) {
    if (!state.days[key]) {
      state.days[key] = {
        kmInicial: null,
        kmFinal: null,
        gastosExtra: 0,
        encerrado: false,
        routes: []
      };
      persistDays();
    }
    return state.days[key];
  }

  /* ---------------------------------------------------------
     5. REGRAS DE CÁLCULO
  --------------------------------------------------------- */

  // 5.1 Valor por KM, conforme veículo e faixa total da rota
  function calcValorKm(vehicle, km) {
    const table = RATE_TABLE[vehicle] || RATE_TABLE.passeio;
    const faixa = table.find(f => km <= f.max) || table[table.length - 1];
    return faixa.value;
  }

  // 5.2 Valor das paradas (faixas progressivas)
  // 1-60: R$0,58 cada
  // 61-90: R$1,96 cada (somente o excedente acima de 60)
  // >91: R$0,80 cada (somando faixas anteriores)
  function calcValorParadas(paradas) {
    const n = Math.max(0, Math.floor(paradas || 0));
    let total = 0;

    const faixa1 = Math.min(n, 60);
    total += faixa1 * 0.58;

    if (n > 60) {
      const faixa2 = Math.min(n - 60, 30); // 61 a 90 => até 30 paradas nessa faixa
      total += faixa2 * 1.96;
    }

    if (n > 90) {
      const faixa3 = n - 90;
      total += faixa3 * 0.80;
    }

    return total;
  }

  // 5.3 Preço por litro do combustível: usa o valor do abastecimento mais
  // recente registrado no histórico (tela de Abastecimentos). Se ainda não
  // houver nenhum abastecimento, usa um valor padrão de fallback.
  const FALLBACK_PRECO_COMBUSTIVEL = 5.89;

  function getLastFuelPrice() {
    if (!state.fuel || state.fuel.length === 0) {
      return { preco: FALLBACK_PRECO_COMBUSTIVEL, tipo: null, hasHistorico: false };
    }
    // O histórico é populado em ordem cronológica; o último item é o
    // abastecimento mais recente.
    const last = state.fuel[state.fuel.length - 1];
    return { preco: clampNum(last.preco, FALLBACK_PRECO_COMBUSTIVEL), tipo: last.tipo, hasHistorico: true };
  }

  // 5.4 Combustível estimado de uma rota: KM da rota ÷ consumo informado,
  // multiplicado pelo preço por litro do último abastecimento.
  function calcCombustivelRota(km, consumo, precoCombustivel) {
    const c = clampNum(consumo, 0);
    const p = clampNum(precoCombustivel, 0);
    if (c <= 0) return 0;
    const litros = km / c;
    return litros * p;
  }

  // 5.5 Cálculo completo de uma rota: faturamento, combustível e lucro.
  function calcRoute({ km, paradas, feriado, vehicle, consumo }) {
    const valorKm = calcValorKm(vehicle, km);
    const valorParadas = calcValorParadas(paradas);
    let faturamento = valorKm + valorParadas;
    if (feriado) faturamento *= FERIADO_MULTIPLIER;

    const { preco: precoCombustivel } = getLastFuelPrice();
    const combustivel = calcCombustivelRota(km, consumo, precoCombustivel);
    const lucro = faturamento - combustivel;

    return { valorKm, valorParadas, faturamento, combustivel, lucro, precoUsado: precoCombustivel };
  }

  // 5.6 Totais de um dia: soma o faturamento, combustível e lucro de cada
  // rota já calculados individualmente (cada rota usa seu próprio consumo).
  // Compatibilidade com rotas salvas em versões anteriores do app, que
  // usavam um único campo "total" (sem separar combustível/lucro por
  // rota). Garante que toda rota lida do armazenamento tenha sempre os
  // campos atuais preenchidos, independente de quando foi criada.
  function normalizeRoute(r) {
    if (r.faturamento != null && r.combustivel != null && r.lucro != null) {
      return r; // já está no formato atual
    }
    const faturamento = r.faturamento != null ? r.faturamento : (r.total != null ? r.total : 0);
    const combustivel = r.combustivel != null ? r.combustivel : 0;
    const lucro = r.lucro != null ? r.lucro : (faturamento - combustivel);
    return { ...r, faturamento, combustivel, lucro };
  }

  function calcDayTotals(dayKey) {
    const day = state.days[dayKey];
    if (!day) {
      return { faturamento: 0, kmRodado: 0, combustivel: 0, lucro: 0, rotas: 0, gastosExtra: 0 };
    }

    const routes = day.routes.map(normalizeRoute);
    const faturamento = routes.reduce((acc, r) => acc + r.faturamento, 0);
    const combustivelRotas = routes.reduce((acc, r) => acc + r.combustivel, 0);
    const rotas = routes.length;
    const gastosExtra = clampNum(day.gastosExtra, 0);

    let kmRodado = 0;
    if (day.kmInicial != null && day.kmFinal != null && day.kmFinal >= day.kmInicial) {
      kmRodado = day.kmFinal - day.kmInicial;
    } else {
      // Fallback: soma o KM das rotas registradas, caso o motorista não tenha
      // usado o fluxo de odômetro inicial/final.
      kmRodado = routes.reduce((acc, r) => acc + (r.km || 0), 0);
    }

    const lucro = faturamento - combustivelRotas - gastosExtra;

    return { faturamento, kmRodado, combustivel: combustivelRotas, lucro, rotas, gastosExtra };
  }

  // 5.7 Quinzena: 15 dias corridos a partir de inicioQuinzena,
  // repetindo o ciclo automaticamente (1ª, 2ª, 3ª... quinzena).
  function getQuinzenaRange(referenceDate = new Date()) {
    const start = parseKey(state.settings.inicioQuinzena || todayKey());
    const ref = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());

    const msPerDay = 24 * 60 * 60 * 1000;
    let diffDays = Math.floor((ref - start) / msPerDay);
    if (diffDays < 0) {
      // referência antes do início configurado: a quinzena ainda não começou,
      // tratamos a quinzena atual como a primeira a partir do start.
      diffDays = 0;
    }
    const cycle = Math.floor(diffDays / 15);
    const cycleStart = new Date(start.getTime() + cycle * 15 * msPerDay);
    const cycleEnd = new Date(cycleStart.getTime() + 14 * msPerDay);

    return { start: cycleStart, end: cycleEnd };
  }

  function calcQuinzenaTotals(referenceDate = new Date()) {
    const { start, end } = getQuinzenaRange(referenceDate);
    let faturamento = 0, combustivel = 0, gastosExtra = 0, lucro = 0, rotas = 0, kmRodado = 0, diasComMovimento = 0;

    const cursor = new Date(start);
    while (cursor <= end) {
      const key = todayKey(cursor);
      if (state.days[key]) {
        const t = calcDayTotals(key);
        faturamento += t.faturamento;
        combustivel += t.combustivel;
        gastosExtra += t.gastosExtra;
        lucro += t.lucro;
        rotas += t.rotas;
        kmRodado += t.kmRodado;
        if (t.rotas > 0 || t.kmRodado > 0) diasComMovimento++;
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    return { start, end, faturamento, combustivel, gastosExtra, lucro, rotas, kmRodado, diasComMovimento };
  }

  // 5.7 Série temporal agregada para os gráficos (dia / semana / mês).
  // Retorna os últimos N pontos (mais antigo -> mais recente), cada um com
  // { label, km, lucro, combustivel }.
  function buildChartSeries(period) {
    const allKeys = Object.keys(state.days).sort();
    if (allKeys.length === 0) return [];

    const dayTotalsCache = {};
    const getTotals = (key) => {
      if (!dayTotalsCache[key]) dayTotalsCache[key] = calcDayTotals(key);
      return dayTotalsCache[key];
    };

    if (period === 'dia') {
      // Últimos 14 dias corridos (mostra todos, mesmo sem movimento, para
      // dar noção de continuidade no eixo do tempo).
      const today = new Date();
      const points = [];
      for (let i = 13; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const key = todayKey(d);
        const t = state.days[key]
          ? getTotals(key)
          : { kmRodado: 0, lucro: 0, combustivel: 0, faturamento: 0, rotas: 0 };
        points.push({
          label: d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
          fullLabel: d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' }),
          km: t.kmRodado, lucro: t.lucro, combustivel: t.combustivel,
          faturamento: t.faturamento, rotas: t.rotas
        });
      }
      return points;
    }

    if (period === 'semana') {
      // Agrupa por semana (segunda a domingo), últimas 8 semanas.
      const today = new Date();
      const startOfWeek = (d) => {
        const x = new Date(d);
        const day = x.getDay(); // 0=domingo
        const diff = (day === 0 ? -6 : 1 - day); // volta até segunda
        x.setDate(x.getDate() + diff);
        x.setHours(0, 0, 0, 0);
        return x;
      };

      const weeks = [];
      const thisWeekStart = startOfWeek(today);
      for (let i = 7; i >= 0; i--) {
        const ws = new Date(thisWeekStart);
        ws.setDate(ws.getDate() - i * 7);
        const we = new Date(ws);
        we.setDate(we.getDate() + 6);
        weeks.push({ start: ws, end: we });
      }

      return weeks.map(({ start, end }) => {
        let km = 0, lucro = 0, combustivel = 0, faturamento = 0, rotas = 0;
        const cursor = new Date(start);
        while (cursor <= end) {
          const key = todayKey(cursor);
          if (state.days[key]) {
            const t = getTotals(key);
            km += t.kmRodado; lucro += t.lucro; combustivel += t.combustivel;
            faturamento += t.faturamento; rotas += t.rotas;
          }
          cursor.setDate(cursor.getDate() + 1);
        }
        const label = `${start.getDate()}/${start.getMonth() + 1}`;
        const fullLabel = `${start.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} – ${end.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}`;
        return { label, fullLabel, km, lucro, combustivel, faturamento, rotas };
      });
    }

    // period === 'mes': agrupa por mês corrido, últimos 6 meses.
    const today = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      months.push(d);
    }

    return months.map((monthDate) => {
      let km = 0, lucro = 0, combustivel = 0, faturamento = 0, rotas = 0;
      const y = monthDate.getFullYear();
      const m = monthDate.getMonth();
      allKeys.forEach((key) => {
        const d = parseKey(key);
        if (d.getFullYear() === y && d.getMonth() === m) {
          const t = getTotals(key);
          km += t.kmRodado; lucro += t.lucro; combustivel += t.combustivel;
          faturamento += t.faturamento; rotas += t.rotas;
        }
      });
      const label = monthDate.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
      const fullLabel = monthDate.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
      return { label, fullLabel, km, lucro, combustivel, faturamento, rotas };
    });
  }

  /* ---------------------------------------------------------
     6. REFERÊNCIAS DE DOM
  --------------------------------------------------------- */

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const els = {
    // home
    heroQuinzena: $('#hero-quinzena'),
    heroPeriodo: $('#hero-periodo'),
    statLucroHoje: $('#stat-lucro-hoje'),
    statKmHoje: $('#stat-km-hoje'),
    statFuelHoje: $('#stat-fuel-hoje'),
    statRotasHoje: $('#stat-rotas-hoje'),
    dayDate: $('#day-date'),
    kmRow: $('#km-row'),
    routeList: $('#route-list'),
    btnOpenFuel: $('#btn-open-fuel'),
    btnOpenSettings: $('#btn-open-settings'),
    btnToggleTheme: $('#btn-toggle-theme'),
    btnAddRoute: $('#btn-add-route'),
    btnFinishDay: $('#btn-finish-day'),

    // tabs / screens
    tabs: $$('.tab'),
    screens: $$('.screen'),
    backBtns: $$('[data-back]'),

    // settings
    cfgVehicle: $('#cfg-vehicle'),
    cfgInicioQuinzena: $('#cfg-inicio-quinzena'),
    cfgMeta: $('#cfg-meta'),
    cfgNotif: $('#cfg-notif'),
    cfgNotifHour: $('#cfg-notif-hour'),
    cfgNotifHourWrap: $('#cfg-notif-hour-wrap'),
    btnTestNotif: $('#btn-test-notif'),
    btnExportPdf: $('#btn-export-pdf'),
    btnSaveSettings: $('#btn-save-settings'),

    // fuel
    fuelType: $('#fuel-type'),
    fuelValor: $('#fuel-valor'),
    fuelPreco: $('#fuel-preco'),
    fuelLitrosPreview: $('#fuel-litros-preview'),
    btnAddFuel: $('#btn-add-fuel'),
    fuelList: $('#fuel-list'),

    // history
    historySegmented: $('#history-segmented'),
    historyBody: $('#history-body'),

    // charts
    chartsSegmented: $('#charts-segmented'),
    chartCanvas: $('#km-chart'),
    chartsSummary: $('#charts-summary'),

    // modal: rota
    modalRoute: $('#modal-route'),
    routeKm: $('#route-km'),
    routeParadas: $('#route-paradas'),
    routeConsumo: $('#route-consumo'),
    routeFeriado: $('#route-feriado'),
    prevKmVal: $('#prev-km-val'),
    prevParadasVal: $('#prev-paradas-val'),
    prevTotalVal: $('#prev-total-val'),
    prevFuelVal: $('#prev-fuel-val'),
    prevFuelInfo: $('#prev-fuel-info'),
    prevLucroVal: $('#prev-lucro-val'),
    btnSaveRoute: $('#btn-save-route'),
    btnCancelRoute: $('#btn-cancel-route'),

    // modal: km inicial
    modalKmStart: $('#modal-km-start'),
    kmInicialInput: $('#km-inicial-input'),
    btnSaveKmStart: $('#btn-save-km-start'),
    btnCancelKmStart: $('#btn-cancel-km-start'),

    // modal: km final
    modalKmEnd: $('#modal-km-end'),
    kmEndInfo: $('#km-end-info'),
    kmFinalInput: $('#km-final-input'),
    gastosExtraInput: $('#gastos-extra-input'),
    btnSaveKmEnd: $('#btn-save-km-end'),
    btnCancelKmEnd: $('#btn-cancel-km-end'),

    toast: $('#toast')
  };

  /* ---------------------------------------------------------
     7. TOAST
  --------------------------------------------------------- */

  let toastTimer = null;
  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('toast--show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('toast--show'), 2200);
  }

  /* ---------------------------------------------------------
     8. NAVEGAÇÃO ENTRE TELAS
  --------------------------------------------------------- */

  function goToScreen(name) {
    const map = {
      home: '#screen-home',
      history: '#screen-history',
      settings: '#screen-settings',
      fuel: '#screen-fuel',
      charts: '#screen-charts'
    };
    els.screens.forEach(s => s.classList.remove('screen--active'));
    const target = document.querySelector(map[name]);
    if (target) target.classList.add('screen--active');

    els.tabs.forEach(t => t.classList.toggle('tab--active', t.dataset.tab === name));

    if (name === 'history') renderHistory();
    if (name === 'settings') fillSettingsForm();
    if (name === 'fuel') renderFuelList();
    if (name === 'home') renderHome();
    if (name === 'charts') renderCharts();
  }

  els.tabs.forEach(tab => {
    tab.addEventListener('click', () => goToScreen(tab.dataset.tab));
  });
  els.backBtns.forEach(btn => {
    btn.addEventListener('click', () => goToScreen(btn.dataset.back));
  });
  els.btnOpenFuel.addEventListener('click', () => goToScreen('fuel'));
  els.btnOpenSettings.addEventListener('click', () => goToScreen('settings'));

  /* ---------------------------------------------------------
     8b. TEMA (alternado pelo ponto no logo, no topo da Home)
     Persistido em LocalStorage para lembrar a escolha entre visitas.
  --------------------------------------------------------- */

  function applyTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', theme === 'dark' ? '#14171C' : '#1A0E08');
    }
  }

  function loadTheme() {
    try {
      return localStorage.getItem(STORAGE_KEYS.THEME) || 'orange';
    } catch (e) {
      return 'orange';
    }
  }

  function saveTheme(theme) {
    try {
      localStorage.setItem(STORAGE_KEYS.THEME, theme);
    } catch (e) {
      console.warn('Falha ao salvar tema', e);
    }
  }

  let currentTheme = loadTheme();
  applyTheme(currentTheme);

  if (els.btnToggleTheme) {
    els.btnToggleTheme.addEventListener('click', () => {
      currentTheme = currentTheme === 'dark' ? 'orange' : 'dark';
      applyTheme(currentTheme);
      saveTheme(currentTheme);
    });
  }

  /* ---------------------------------------------------------
     9. RENDER: HOME
  --------------------------------------------------------- */

  function renderHome() {
    setTimeout(renderMetaProgress, 0);
    const todayK = todayKey();
    const day = state.days[todayK];

    // Quinzena
    const q = calcQuinzenaTotals();
    els.heroQuinzena.textContent = fmtBRL(q.lucro);
    els.heroQuinzena.style.color = q.lucro < 0 ? 'var(--danger)' : '';
    const startLabel = q.start.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    const endLabel = q.end.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    els.heroPeriodo.textContent = `${startLabel} a ${endLabel} \u00B7 ${q.rotas} rota${q.rotas === 1 ? '' : 's'}`;

    // Dia atual
    const t = calcDayTotals(todayK);
    els.statLucroHoje.textContent = fmtBRL(t.lucro);
    els.statKmHoje.textContent = fmtKM(t.kmRodado);
    els.statFuelHoje.textContent = fmtBRL(t.combustivel);
    els.statRotasHoje.textContent = String(t.rotas);

    els.dayDate.textContent = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });

    renderKmRow(day);
    renderRouteList(day);
  }

  function renderKmRow(day) {
    els.kmRow.innerHTML = '';

    if (!day || day.kmInicial == null) {
      const btn = document.createElement('button');
      btn.className = 'ghost-btn';
      btn.id = 'btn-km-inicial';
      btn.textContent = 'Registrar KM inicial';
      btn.addEventListener('click', () => openModal(els.modalKmStart, () => els.kmInicialInput.focus()));
      els.kmRow.appendChild(btn);
      return;
    }

    const summary = document.createElement('div');
    summary.className = 'km-summary';
    summary.innerHTML = `
      <span>KM inicial: <b>${day.kmInicial.toLocaleString('pt-BR')}</b></span>
      <span>${day.kmFinal != null ? `KM final: <b>${day.kmFinal.toLocaleString('pt-BR')}</b>` : 'Em andamento'}</span>
    `;
    els.kmRow.appendChild(summary);
  }

  function renderRouteList(day) {
    els.routeList.innerHTML = '';
    if (!day || day.routes.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'Nenhuma rota registrada hoje ainda.';
      els.routeList.appendChild(empty);
      return;
    }

    day.routes.slice().reverse().map(normalizeRoute).forEach((r) => {
      const item = document.createElement('div');
      item.className = 'route-item';
      item.innerHTML = `
        <div class="route-item__info">
          <span class="route-item__title">${r.km} km \u00B7 ${r.paradas} parada${r.paradas === 1 ? '' : 's'}</span>
          <span class="route-item__meta">Bruto ${fmtBRL(r.faturamento)} \u00B7 Combust. ${fmtBRL(r.combustivel)}${r.feriado ? ' \u00B7 Feriado' : ''}</span>
        </div>
        <span class="route-item__value" style="${r.lucro < 0 ? 'color:var(--danger)' : ''}">${fmtBRL(r.lucro)}</span>
        <button class="route-item__del" data-id="${r.id}" aria-label="Remover rota">
          <svg viewBox="0 0 24 24" width="16" height="16"><path d="M5 6h14M9 6V4h6v2M7 6l1 14h8l1-14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      `;
      els.routeList.appendChild(item);
    });

    els.routeList.querySelectorAll('.route-item__del').forEach(btn => {
      btn.addEventListener('click', () => removeRoute(btn.dataset.id));
    });
  }

  function removeRoute(id) {
    const key = todayKey();
    const day = state.days[key];
    if (!day) return;
    day.routes = day.routes.filter(r => r.id !== id);
    persistDays();
    renderHome();
    showToast('Rota removida');
  }

  /* ---------------------------------------------------------
     10. MODAL: NOVA ROTA
  --------------------------------------------------------- */

  function openModal(modalEl, after) {
    modalEl.classList.add('modal-overlay--active');
    if (after) setTimeout(after, 80);
  }
  function closeModal(modalEl) {
    modalEl.classList.remove('modal-overlay--active');
  }

  function updateRoutePreview() {
    const km = clampNum(els.routeKm.value, 0);
    const paradas = clampNum(els.routeParadas.value, 0);
    const consumo = clampNum(els.routeConsumo.value, 0);
    const feriado = els.routeFeriado.checked;
    const vehicle = state.settings.vehicle;

    const { valorKm, valorParadas, faturamento, combustivel, lucro, precoUsado } =
      calcRoute({ km, paradas, feriado, vehicle, consumo });
    const { tipo, hasHistorico } = getLastFuelPrice();

    els.prevKmVal.textContent = fmtBRL(valorKm * (feriado ? FERIADO_MULTIPLIER : 1));
    els.prevParadasVal.textContent = fmtBRL(valorParadas * (feriado ? FERIADO_MULTIPLIER : 1));
    els.prevTotalVal.textContent = fmtBRL(faturamento);
    els.prevFuelVal.textContent = fmtBRL(combustivel);
    els.prevFuelInfo.textContent = hasHistorico
      ? `${tipo || 'combustível'} a ${fmtBRL(precoUsado)}/L`
      : `padrão ${fmtBRL(precoUsado)}/L`;
    els.prevLucroVal.textContent = fmtBRL(lucro);
  }

  els.routeKm.addEventListener('input', updateRoutePreview);
  els.routeParadas.addEventListener('input', updateRoutePreview);
  els.routeConsumo.addEventListener('input', updateRoutePreview);
  els.routeFeriado.addEventListener('change', updateRoutePreview);

  // Lembra o último consumo digitado, para pré-preencher a próxima rota
  // e o motorista não precisar redigitar todas as vezes.
  let lastConsumoUsado = null;

  els.btnAddRoute.addEventListener('click', () => {
    els.routeKm.value = '';
    els.routeParadas.value = '';
    els.routeConsumo.value = lastConsumoUsado != null ? lastConsumoUsado : '';
    els.routeFeriado.checked = false;
    updateRoutePreview();
    openModal(els.modalRoute, () => els.routeParadas.focus());
  });

  els.btnCancelRoute.addEventListener('click', () => closeModal(els.modalRoute));

  els.btnSaveRoute.addEventListener('click', () => {
    const km = clampNum(els.routeKm.value, NaN);
    const paradas = clampNum(els.routeParadas.value, 0);
    const consumo = clampNum(els.routeConsumo.value, NaN);

    if (!Number.isFinite(km) || km <= 0) {
      showToast('Informe o KM da rota');
      els.routeKm.focus();
      return;
    }
    if (!Number.isFinite(consumo) || consumo <= 0) {
      showToast('Informe o consumo do carro');
      els.routeConsumo.focus();
      return;
    }

    const feriado = els.routeFeriado.checked;
    const vehicle = state.settings.vehicle;
    const { valorKm, valorParadas, faturamento, combustivel, lucro, precoUsado } =
      calcRoute({ km, paradas, feriado, vehicle, consumo });

    const key = todayKey();
    const day = getDay(key);
    day.routes.push({
      id: uid(),
      km, paradas, feriado, vehicle, consumo,
      valorKm, valorParadas, faturamento,
      combustivel, lucro, precoUsado,
      createdAt: Date.now()
    });
    persistDays();
    lastConsumoUsado = consumo;
    closeModal(els.modalRoute);
    renderHome();
    showToast('Rota adicionada');
  });

  /* ---------------------------------------------------------
     11. MODAL: KM INICIAL / KM FINAL
  --------------------------------------------------------- */

  els.btnCancelKmStart.addEventListener('click', () => closeModal(els.modalKmStart));

  els.btnSaveKmStart.addEventListener('click', () => {
    const km = clampNum(els.kmInicialInput.value, NaN);
    if (!Number.isFinite(km) || km < 0) {
      showToast('Informe o KM inicial');
      els.kmInicialInput.focus();
      return;
    }
    const key = todayKey();
    const day = getDay(key);
    day.kmInicial = km;
    persistDays();
    closeModal(els.modalKmStart);
    renderHome();
    showToast('KM inicial registrado');
  });

  els.btnFinishDay.addEventListener('click', () => {
    const key = todayKey();
    const day = getDay(key);

    if (day.kmInicial == null) {
      showToast('Registre o KM inicial primeiro');
      return;
    }

    els.kmEndInfo.textContent = `KM inicial registrado: ${day.kmInicial.toLocaleString('pt-BR')}`;
    els.kmFinalInput.value = day.kmFinal != null ? day.kmFinal : '';
    els.gastosExtraInput.value = day.gastosExtra ? day.gastosExtra : '';
    openModal(els.modalKmEnd, () => els.kmFinalInput.focus());
  });

  els.btnCancelKmEnd.addEventListener('click', () => closeModal(els.modalKmEnd));

  els.btnSaveKmEnd.addEventListener('click', () => {
    const key = todayKey();
    const day = getDay(key);
    const kmFinal = clampNum(els.kmFinalInput.value, NaN);

    if (!Number.isFinite(kmFinal) || kmFinal < day.kmInicial) {
      showToast('KM final deve ser maior que o inicial');
      els.kmFinalInput.focus();
      return;
    }

    day.kmFinal = kmFinal;
    day.gastosExtra = clampNum(els.gastosExtraInput.value, 0);
    day.encerrado = true;
    persistDays();
    closeModal(els.modalKmEnd);
    renderHome();
    showToast('Dia encerrado');
  });

  /* ---------------------------------------------------------
     12. CONFIGURAÇÕES
  --------------------------------------------------------- */

  function fillSettingsForm() {
    els.cfgVehicle.value = state.settings.vehicle;
    els.cfgInicioQuinzena.value = state.settings.inicioQuinzena;
    els.cfgMeta.value = state.settings.metaQuinzena || '';
    els.cfgNotif.checked = !!state.settings.notifEnabled;
    els.cfgNotifHour.value = state.settings.notifHour || '20:00';
    els.cfgNotifHourWrap.style.display = state.settings.notifEnabled ? '' : 'none';
    els.btnTestNotif.style.display = state.settings.notifEnabled ? '' : 'none';
  }

  els.btnSaveSettings.addEventListener('click', async () => {
    state.settings.vehicle = els.cfgVehicle.value;
    state.settings.inicioQuinzena = els.cfgInicioQuinzena.value || todayKey();
    state.settings.metaQuinzena = clampNum(els.cfgMeta.value, 0);
    const wantNotif = els.cfgNotif.checked;
    if (wantNotif && !state.settings.notifEnabled) {
      const ok = await requestNotifPermission();
      state.settings.notifEnabled = ok;
      if (!ok) showToast('Permissão de notificação negada');
    } else {
      state.settings.notifEnabled = wantNotif;
    }
    state.settings.notifHour = els.cfgNotifHour.value || '20:00';
    persistSettings();
    showToast('Configurações salvas');
    goToScreen('home');
  });

  // Live toggle: mostra/esconde campos de horário conforme o switch
  els.cfgNotif.addEventListener('change', () => {
    const on = els.cfgNotif.checked;
    els.cfgNotifHourWrap.style.display = on ? '' : 'none';
    els.btnTestNotif.style.display = on ? '' : 'none';
  });

  els.btnTestNotif.addEventListener('click', async () => {
    const ok = await requestNotifPermission();
    if (!ok) { showToast('Permita notificações no navegador'); return; }
    sendNotif('Balancímetro', 'Está funcionando! Vamos rodar bonito hoje 🚚');
  });

  /* ---------------------------------------------------------
     13. ABASTECIMENTOS
  --------------------------------------------------------- */

  function updateFuelPreview() {
    const valor = clampNum(els.fuelValor.value, 0);
    const preco = clampNum(els.fuelPreco.value, 0);
    if (valor > 0 && preco > 0) {
      const litros = valor / preco;
      els.fuelLitrosPreview.textContent = `Litros abastecidos: ${litros.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} L`;
    } else {
      els.fuelLitrosPreview.textContent = 'Litros abastecidos: \u2014';
    }
  }
  els.fuelValor.addEventListener('input', updateFuelPreview);
  els.fuelPreco.addEventListener('input', updateFuelPreview);

  els.btnAddFuel.addEventListener('click', () => {
    const tipo = els.fuelType.value;
    const valor = clampNum(els.fuelValor.value, NaN);
    const preco = clampNum(els.fuelPreco.value, NaN);

    if (!Number.isFinite(valor) || valor <= 0 || !Number.isFinite(preco) || preco <= 0) {
      showToast('Preencha valor e preço por litro');
      return;
    }

    const litros = valor / preco;
    state.fuel.push({
      id: uid(),
      tipo, valor, preco, litros,
      date: todayKey(),
      createdAt: Date.now()
    });
    persistFuel();

    // Atualiza preço médio do combustível nas configurações automaticamente,
    // já que é o dado mais recente informado pelo motorista.
    state.settings.precoCombustivel = preco;
    persistSettings();

    els.fuelValor.value = '';
    els.fuelPreco.value = '';
    updateFuelPreview();
    renderFuelList();
    renderHome();
    showToast('Abastecimento registrado');
  });

  function renderFuelList() {
    els.fuelList.innerHTML = '';
    if (state.fuel.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'Nenhum abastecimento registrado ainda.';
      els.fuelList.appendChild(empty);
      return;
    }

    state.fuel.slice().reverse().forEach((f) => {
      const item = document.createElement('div');
      item.className = 'fuel-item';
      item.innerHTML = `
        <div>
          <p class="fuel-item__type">${f.tipo}</p>
          <p class="fuel-item__meta">${fmtDateShort(f.date)} \u00B7 ${f.litros.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} L a ${fmtBRL(f.preco)}/L</p>
        </div>
        <span class="fuel-item__value">${fmtBRL(f.valor)}</span>
      `;
      els.fuelList.appendChild(item);
    });
  }

  /* ---------------------------------------------------------
     14. HISTÓRICO
  --------------------------------------------------------- */

  let historyRange = 'quinzena';

  els.historySegmented.querySelectorAll('.segmented__btn').forEach(btn => {
    btn.addEventListener('click', () => {
      historyRange = btn.dataset.range;
      els.historySegmented.querySelectorAll('.segmented__btn').forEach(b =>
        b.classList.toggle('segmented__btn--active', b === btn)
      );
      renderHistory();
    });
  });

  function renderHistory() {
    els.historyBody.innerHTML = '';
    if (historyRange === 'quinzena') {
      renderHistoryQuinzenas();
    } else {
      renderHistoryDays();
    }
  }

  function renderHistoryQuinzenas() {
    // Mostra a quinzena atual + outras quinzenas com movimento registrado.
    const allDayKeys = Object.keys(state.days).sort();
    if (allDayKeys.length === 0) {
      els.historyBody.innerHTML = '<p class="empty-state">Nenhum dado registrado ainda.</p>';
      return;
    }

    const cards = [];
    const seen = new Set();
    const refDates = [new Date(), ...allDayKeys.map(parseKey)].sort((a, b) => b - a);

    for (const ref of refDates) {
      const q = calcQuinzenaTotals(ref);
      const sig = q.start.getTime();
      if (seen.has(sig)) continue;
      seen.add(sig);
      cards.push(q);
      if (cards.length >= 6) break;
    }

    cards.forEach((q, idx) => {
      const card = document.createElement('div');
      card.className = 'period-card';
      const startLabel = q.start.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const endLabel = q.end.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
      card.innerHTML = `
        <div class="period-card__top">
          <div>
            <p class="period-card__title">${startLabel} \u2014 ${endLabel}</p>
            <p class="period-card__value" style="${q.lucro < 0 ? 'color:var(--danger)' : ''}">${fmtBRL(q.lucro)}</p>
          </div>
          <span class="period-card__badge">${idx === 0 ? 'Atual' : `${q.diasComMovimento} dia(s)`}</span>
        </div>
        <div class="period-card__grid">
          <div><span>Faturamento</span><b>${fmtBRL(q.faturamento)}</b></div>
          <div><span>Combustível</span><b>${fmtBRL(q.combustivel)}</b></div>
          <div><span>Rotas</span><b>${q.rotas}</b></div>
        </div>
      `;
      els.historyBody.appendChild(card);
    });
  }

  function renderHistoryDays() {
    const keys = Object.keys(state.days).sort().reverse();
    if (keys.length === 0) {
      els.historyBody.innerHTML = '<p class="empty-state">Nenhum dia registrado ainda.</p>';
      return;
    }

    let rendered = 0;
    keys.forEach(key => {
      const t = calcDayTotals(key);
      if (t.rotas === 0 && t.kmRodado === 0) return;
      rendered++;

      const card = document.createElement('div');
      card.className = 'day-card';
      card.innerHTML = `
        <div>
          <p class="day-card__date">${fmtDateLabel(key)}</p>
          <p class="day-card__meta">${t.rotas} rota${t.rotas === 1 ? '' : 's'} \u00B7 ${fmtKM(t.kmRodado)}</p>
        </div>
        <span class="day-card__value" style="${t.lucro < 0 ? 'color:var(--danger)' : ''}">${fmtBRL(t.lucro)}</span>
      `;
      els.historyBody.appendChild(card);
    });

    if (rendered === 0) {
      els.historyBody.innerHTML = '<p class="empty-state">Nenhum dia com movimento ainda.</p>';
    }
  }

  /* ---------------------------------------------------------
     15. GRÁFICOS (Canvas nativo, sem dependências externas
     para manter o app 100% funcional offline)
  --------------------------------------------------------- */

  let chartsPeriod = 'dia';

  els.chartsSegmented.querySelectorAll('.segmented__btn').forEach(btn => {
    btn.addEventListener('click', () => {
      chartsPeriod = btn.dataset.period;
      els.chartsSegmented.querySelectorAll('.segmented__btn').forEach(b =>
        b.classList.toggle('segmented__btn--active', b === btn)
      );
      renderCharts();
    });
  });

  // Resolução do canvas em pixels reais (devicePixelRatio) para texto nítido.
  function setupCanvasDPR(canvas, cssHeight) {
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.parentElement.clientWidth - 20; // padding interno do card
    canvas.style.width = cssWidth + 'px';
    canvas.style.height = cssHeight + 'px';
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width: cssWidth, height: cssHeight };
  }

  function drawLineSeries(ctx, points, valueKey, color, bounds, plot) {
    const { minY, maxY } = bounds;
    const range = (maxY - minY) || 1;
    const stepX = points.length > 1 ? plot.w / (points.length - 1) : 0;

    ctx.beginPath();
    points.forEach((p, i) => {
      const x = plot.x + stepX * i;
      const norm = (p[valueKey] - minY) / range;
      const y = plot.y + plot.h - norm * plot.h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Pontos
    points.forEach((p, i) => {
      const x = plot.x + stepX * i;
      const norm = (p[valueKey] - minY) / range;
      const y = plot.y + plot.h - norm * plot.h;
      ctx.beginPath();
      ctx.arc(x, y, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    });
  }

  // Guarda a última geometria de plotagem, usada para mapear cliques do
  // usuário (posição X em pixels) para o índice do ponto correspondente.
  let chartsPlotGeometry = null;
  let chartsLastPoints = [];
  let chartsHighlightIndex = null;

  function renderChartCanvas(points, highlightIndex) {
    const canvas = els.chartCanvas;
    const cardBody = canvas.parentElement;

    if (!points.length) {
      cardBody.innerHTML = '<p class="chart-empty">Sem dados suficientes ainda. Registre rotas e KM para ver o gráfico aqui.</p>';
      chartsPlotGeometry = null;
      return;
    }

    const { ctx, width, height } = setupCanvasDPR(canvas, 240);
    ctx.clearRect(0, 0, width, height);

    const plot = { x: 8, y: 14, w: width - 16, h: height - 46 };
    const stepX = points.length > 1 ? plot.w / (points.length - 1) : 0;
    chartsPlotGeometry = { plot, stepX, count: points.length };

    // Cada série é normalizada na MESMA área de plotagem, mas com seus
    // próprios min/max — isso permite comparar tendências (sobe/desce)
    // mesmo com magnitudes bem diferentes (KM em dezenas/centenas,
    // R$ lucro e combustível em outra escala).
    // KM é desenhado por último (por cima) com uma cor de alto contraste,
    // já que tende a ficar "escondido" atrás das outras duas linhas.
    const seriesDefs = [
      { key: 'lucro', color: getCSS('--accent') },
      { key: 'combustivel', color: getCSS('--accent-2') },
      { key: 'km', color: '#7FD4FF' }
    ];

    seriesDefs.forEach(({ key, color }) => {
      const values = points.map(p => p[key]);
      let minY = Math.min(...values, 0);
      let maxY = Math.max(...values, 0);
      if (minY === maxY) { minY -= 1; maxY += 1; }
      // Margem de 8% para as linhas não colarem nas bordas.
      const pad = (maxY - minY) * 0.08;
      drawLineSeries(ctx, points, key, color, { minY: minY - pad, maxY: maxY + pad }, plot);
    });

    // Marcador vertical do ponto selecionado (se houver), desenhado por
    // cima das linhas para indicar qual dia/semana/mês está em destaque.
    if (highlightIndex != null && highlightIndex >= 0 && highlightIndex < points.length) {
      const x = plot.x + stepX * highlightIndex;
      ctx.strokeStyle = getCSS('--text');
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, plot.y);
      ctx.lineTo(x, plot.y + plot.h);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // Linha de base (eixo X)
    ctx.strokeStyle = getCSS('--line');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plot.x, plot.y + plot.h + 0.5);
    ctx.lineTo(plot.x + plot.w, plot.y + plot.h + 0.5);
    ctx.stroke();

    // Rótulos do eixo X: escolhe um espaçamento que garanta não haver
    // sobreposição entre rótulos consecutivos (inclusive o último).
    ctx.fillStyle = getCSS('--text-dim');
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'center';
    const minLabelGapPx = 46; // espaço mínimo entre o centro de dois rótulos
    const labelStep = Math.max(1, Math.ceil(minLabelGapPx / Math.max(stepX, 1)));

    let lastLabelX = -Infinity;
    points.forEach((p, i) => {
      const isLast = i === points.length - 1;
      const onStep = i % labelStep === 0;
      if (!onStep && !isLast) return;
      const x = plot.x + stepX * i;
      // Evita desenhar o último rótulo se ele ficar colado no anterior.
      if (x - lastLabelX < minLabelGapPx * 0.6) return;
      ctx.fillText(p.label, x, plot.y + plot.h + 18);
      lastLabelX = x;
    });
  }

  // Toque/clique no canvas: identifica o ponto mais próximo do X tocado
  // e sincroniza o destaque com a lista detalhada abaixo.
  function handleChartTap(clientX) {
    if (!chartsPlotGeometry || !chartsLastPoints.length) return;
    const canvas = els.chartCanvas;
    const rect = canvas.getBoundingClientRect();
    const xInCanvas = clientX - rect.left;
    const { plot, stepX, count } = chartsPlotGeometry;

    let idx = stepX > 0 ? Math.round((xInCanvas - plot.x) / stepX) : 0;
    idx = Math.max(0, Math.min(count - 1, idx));

    chartsHighlightIndex = chartsHighlightIndex === idx ? null : idx;
    renderChartCanvas(chartsLastPoints, chartsHighlightIndex);
    renderChartsDetailList(chartsLastPoints, chartsHighlightIndex);

    if (chartsHighlightIndex != null) {
      const card = document.querySelector(`.chart-detail-card[data-idx="${chartsHighlightIndex}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  els.chartCanvas.addEventListener('click', (e) => handleChartTap(e.clientX));

  function getCSS(varName) {
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  }

  function renderChartsSummary(points) {
    if (!points.length) {
      els.chartsSummary.innerHTML = '';
      return;
    }
    const totalKm = points.reduce((a, p) => a + p.km, 0);
    const totalLucro = points.reduce((a, p) => a + p.lucro, 0);
    const totalCombustivel = points.reduce((a, p) => a + p.combustivel, 0);

    els.chartsSummary.innerHTML = `
      <div class="chart-summary__card">
        <p class="chart-summary__label">Lucro no período</p>
        <p class="chart-summary__value" style="color:${totalLucro < 0 ? 'var(--danger)' : 'var(--accent)'}">${fmtBRL(totalLucro)}</p>
      </div>
      <div class="chart-summary__card">
        <p class="chart-summary__label">KM total</p>
        <p class="chart-summary__value">${fmtKM(totalKm)}</p>
      </div>
      <div class="chart-summary__card">
        <p class="chart-summary__label">Combustível</p>
        <p class="chart-summary__value" style="color:var(--accent-2)">${fmtBRL(totalCombustivel)}</p>
      </div>
    `;
  }

  const CHARTS_LIST_TITLES = {
    dia: 'Detalhe por dia',
    semana: 'Detalhe por semana',
    mes: 'Detalhe por mês'
  };

  // Renderiza a lista detalhada (mais recente primeiro), com Lucro,
  // Faturamento bruto, Combustível e KM de cada dia/semana/mês.
  function renderChartsDetailList(points, highlightIndex) {
    const titleEl = document.getElementById('charts-list-title');
    if (titleEl) titleEl.textContent = CHARTS_LIST_TITLES[chartsPeriod] || 'Detalhe';

    const container = document.getElementById('charts-detail-list');
    if (!points.length) {
      container.innerHTML = '<p class="empty-state">Sem dados suficientes ainda.</p>';
      return;
    }

    const ordered = points.map((p, idx) => ({ ...p, idx })).slice().reverse();

    container.innerHTML = ordered.map((p) => `
      <div class="chart-detail-card${p.idx === highlightIndex ? ' chart-detail-card--highlight' : ''}" data-idx="${p.idx}">
        <div class="chart-detail-card__top">
          <span class="chart-detail-card__date">${p.fullLabel}</span>
          <span class="chart-detail-card__lucro" style="color:${p.lucro < 0 ? 'var(--danger)' : 'var(--accent)'}">${fmtBRL(p.lucro)}</span>
        </div>
        <div class="chart-detail-card__grid">
          <div><span>Faturamento</span><b>${fmtBRL(p.faturamento)}</b></div>
          <div><span>Combustível</span><b>${fmtBRL(p.combustivel)}</b></div>
          <div><span>KM</span><b>${fmtKM(p.km)}</b></div>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.chart-detail-card').forEach((card) => {
      card.addEventListener('click', () => {
        const idx = parseInt(card.dataset.idx, 10);
        chartsHighlightIndex = chartsHighlightIndex === idx ? null : idx;
        renderChartCanvas(chartsLastPoints, chartsHighlightIndex);
        renderChartsDetailList(chartsLastPoints, chartsHighlightIndex);
      });
    });
  }

  function renderCharts() {
    chartsHighlightIndex = null;
    const points = buildChartSeries(chartsPeriod);
    chartsLastPoints = points;
    renderChartCanvas(points, null);
    renderChartsSummary(points);
    renderChartsDetailList(points, null);
  }

  // Redesenha o gráfico ao girar/redimensionar a tela, para o canvas
  // acompanhar a largura correta.
  window.addEventListener('resize', () => {
    const chartsScreen = document.querySelector('#screen-charts');
    if (chartsScreen && chartsScreen.classList.contains('screen--active')) {
      renderChartCanvas(chartsLastPoints, chartsHighlightIndex);
    }
  });

  /* ---------------------------------------------------------
     16. SPLASH SCREEN
     Mostra a tela de abertura por um tempo mínimo (para não
     "piscar" em devices rápidos) e some assim que o app
     estiver pronto.
  --------------------------------------------------------- */

  const SPLASH_MIN_MS = 1400;

  function hideSplash() {
    const splash = document.getElementById('splash');
    if (!splash) return;
    splash.classList.add('splash--hidden');
    setTimeout(() => splash.remove(), 550);
  }

  function setupSplash() {
    const start = Date.now();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      const elapsed = Date.now() - start;
      const wait = Math.max(0, SPLASH_MIN_MS - elapsed);
      setTimeout(hideSplash, wait);
    };

    if (document.readyState === 'complete') {
      finish();
    } else {
      window.addEventListener('load', finish);
    }
    // Garantia: nunca deixa a splash presa, mesmo que 'load' nunca
    // dispare (ex: imagem de fundo ausente ou rede lenta).
    setTimeout(finish, 2000);
  }

  /* ---------------------------------------------------------
     17. INICIALIZAÇÃO
  --------------------------------------------------------- */

  function init() {
    setupSplash();

    // Garante que o dia de hoje exista no armazenamento para consistência.
    ensureDayExists(todayKey());
    fillSettingsForm();
    updateFuelPreview();
    renderHome();

    // Botão de exportar PDF
    if (els.btnExportPdf) els.btnExportPdf.addEventListener('click', exportQuinzenaPdf);

    // Notificações: agenda verificação periódica (a cada 5min) + ao ganhar foco
    checkNotifTriggers();
    setInterval(checkNotifTriggers, 5 * 60 * 1000);
    window.addEventListener('focus', checkNotifTriggers);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkNotifTriggers(); });

    // Fecha modais ao clicar fora do sheet.
    [els.modalRoute, els.modalKmStart, els.modalKmEnd].forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal(modal);
      });
    });

    // Registra o service worker para funcionamento offline.
    // Usa um caminho relativo ao documento atual (funciona tanto na raiz
    // quanto em subpastas, como no GitHub Pages: usuario.github.io/repo/).
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        const swUrl = new URL('service-worker.js', document.baseURI).href;
        const swScope = new URL('./', document.baseURI).href;
        navigator.serviceWorker.register(swUrl, { scope: swScope })
          .then((reg) => {
            console.log('Service worker registrado com sucesso:', reg.scope);
          })
          .catch((err) => {
            console.warn('Falha ao registrar service worker', err);
          });
      });
    }
  }



  /* ---------------------------------------------------------
     14. NOTIFICAÇÕES LOCAIS
  --------------------------------------------------------- */

  async function requestNotifPermission() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    try {
      const p = await Notification.requestPermission();
      return p === 'granted';
    } catch (e) { return false; }
  }

  function sendNotif(title, body) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      // Prefere via service worker (funciona com app fechado no Android)
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then(reg => {
          reg.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'balancimetro' });
        });
      } else {
        new Notification(title, { body, icon: 'icons/icon-192.png' });
      }
    } catch (e) { console.warn('notif fail', e); }
  }

  function checkNotifTriggers() {
    if (!state.settings.notifEnabled) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const notifState = loadJSON(STORAGE_KEYS.NOTIF, { lastReminder: '', lastMilestone: 0 });
    const now = new Date();
    const key = todayKey(now);
    const [hh, mm] = (state.settings.notifHour || '20:00').split(':').map(Number);
    const trigger = new Date(now); trigger.setHours(hh || 20, mm || 0, 0, 0);

    // A) Lembrete diário: passou do horário, dia não encerrado, ainda não notificou hoje
    if (now >= trigger && notifState.lastReminder !== key) {
      const day = state.days[key];
      if (day && !day.encerrado && day.routes && day.routes.length > 0) {
        const t = calcDayTotals(key);
        sendNotif('Encerrar o dia?', `Você já fez ${t.rotas} rota(s) hoje · ${fmtBRL(t.lucro)} de lucro. Fecha o odômetro?`);
        notifState.lastReminder = key;
        saveJSON(STORAGE_KEYS.NOTIF, notifState);
      }
    }

    // B) Meta da quinzena: 50%, 80%, 100%
    const meta = clampNum(state.settings.metaQuinzena, 0);
    if (meta > 0) {
      const q = calcQuinzenaTotals(now);
      const pct = (q.lucro / meta) * 100;
      const milestones = [50, 80, 100];
      const hit = milestones.filter(m => pct >= m).pop();
      if (hit && hit > (notifState.lastMilestone || 0)) {
        const msg = hit === 100
          ? `🎯 Meta batida! ${fmtBRL(q.lucro)} de ${fmtBRL(meta)}`
          : `Você já está em ${hit}% da meta (${fmtBRL(q.lucro)} de ${fmtBRL(meta)})`;
        sendNotif('Balancímetro', msg);
        notifState.lastMilestone = hit;
        saveJSON(STORAGE_KEYS.NOTIF, notifState);
      }
      // Reset de milestone quando começa nova quinzena
      const qKey = q.start.getTime();
      if (notifState.qKey !== qKey) {
        notifState.qKey = qKey;
        notifState.lastMilestone = 0;
        saveJSON(STORAGE_KEYS.NOTIF, notifState);
      }
    }
  }

  /* ---------------------------------------------------------
     15. BARRA DE PROGRESSO DE META (no hero)
  --------------------------------------------------------- */

  function renderMetaProgress() {
    let bar = document.getElementById('meta-bar');
    const meta = clampNum(state.settings.metaQuinzena, 0);
    const hero = document.querySelector('.hero');
    if (!hero) return;

    if (meta <= 0) {
      if (bar) bar.remove();
      return;
    }

    const q = calcQuinzenaTotals();
    const pct = Math.max(0, Math.min(100, (q.lucro / meta) * 100));

    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'meta-bar';
      bar.className = 'meta-bar';
      bar.innerHTML = '<div class="meta-bar__track"><div class="meta-bar__fill"></div></div><p class="meta-bar__label"></p>';
      hero.appendChild(bar);
    }
    bar.querySelector('.meta-bar__fill').style.width = pct.toFixed(1) + '%';
    bar.querySelector('.meta-bar__label').textContent =
      `${pct.toFixed(0)}% da meta · ${fmtBRL(q.lucro)} de ${fmtBRL(meta)}`;
    bar.classList.toggle('meta-bar--done', pct >= 100);
  }

  /* ---------------------------------------------------------
     16. EXPORTAÇÃO PDF (quinzena atual)
  --------------------------------------------------------- */

  function exportQuinzenaPdf() {
    const jsPDFCtor = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    if (!jsPDFCtor) {
      showToast('PDF ainda carregando, tente de novo em 2s');
      return;
    }
    const doc = new jsPDFCtor({ unit: 'pt', format: 'a4' });
    const q = calcQuinzenaTotals();
    const startLabel = q.start.toLocaleDateString('pt-BR');
    const endLabel = q.end.toLocaleDateString('pt-BR');

    // Cabeçalho
    doc.setFillColor(26, 14, 8);
    doc.rect(0, 0, 595, 90, 'F');
    doc.setTextColor(232, 115, 42);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(22);
    doc.text('BALANCÍMETRO', 40, 45);
    doc.setTextColor(245, 230, 204);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.text('Relatório de quinzena', 40, 65);
    doc.text(`${startLabel}  —  ${endLabel}`, 40, 80);

    let y = 130;
    doc.setTextColor(30, 30, 30);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text('Resumo', 40, y);
    y += 20;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    const rows = [
      ['Faturamento bruto', fmtBRL(q.faturamento)],
      ['Combustível',       fmtBRL(q.combustivel)],
      ['Outros gastos',     fmtBRL(q.gastosExtra)],
      ['Lucro líquido',     fmtBRL(q.lucro)],
      ['KM rodado',         fmtKM(q.kmRodado)],
      ['Rotas',             String(q.rotas)],
      ['Dias com movimento', String(q.diasComMovimento)]
    ];
    rows.forEach(([l, v]) => {
      doc.setTextColor(90, 90, 90);
      doc.text(l, 40, y);
      doc.setTextColor(20, 20, 20);
      doc.text(v, 555, y, { align: 'right' });
      doc.setDrawColor(230);
      doc.line(40, y + 4, 555, y + 4);
      y += 22;
    });

    // Meta
    const meta = clampNum(state.settings.metaQuinzena, 0);
    if (meta > 0) {
      y += 10;
      const pct = Math.max(0, Math.min(100, (q.lucro / meta) * 100));
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12);
      doc.setTextColor(30, 30, 30);
      doc.text(`Meta: ${fmtBRL(meta)}  ·  ${pct.toFixed(0)}%`, 40, y);
      y += 10;
      doc.setFillColor(235, 235, 235);
      doc.roundedRect(40, y, 515, 10, 5, 5, 'F');
      doc.setFillColor(232, 115, 42);
      doc.roundedRect(40, y, 515 * (pct / 100), 10, 5, 5, 'F');
      y += 30;
    }

    // Detalhe por dia
    y += 10;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(30, 30, 30);
    doc.text('Detalhe por dia', 40, y);
    y += 20;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(120, 120, 120);
    doc.text('Data', 40, y);
    doc.text('Rotas', 240, y);
    doc.text('KM', 300, y);
    doc.text('Combust.', 380, y, { align: 'right' });
    doc.text('Lucro', 555, y, { align: 'right' });
    y += 6;
    doc.setDrawColor(200);
    doc.line(40, y, 555, y);
    y += 14;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(30, 30, 30);

    const cursor = new Date(q.start);
    let anyDay = false;
    while (cursor <= q.end) {
      const key = todayKey(cursor);
      if (state.days[key]) {
        const t = calcDayTotals(key);
        if (t.rotas > 0 || t.kmRodado > 0) {
          anyDay = true;
          if (y > 780) { doc.addPage(); y = 60; }
          const d = cursor.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
          doc.text(d, 40, y);
          doc.text(String(t.rotas), 240, y);
          doc.text(fmtKM(t.kmRodado), 300, y);
          doc.text(fmtBRL(t.combustivel), 380, y, { align: 'right' });
          if (t.lucro < 0) doc.setTextColor(200, 60, 40); else doc.setTextColor(30, 30, 30);
          doc.text(fmtBRL(t.lucro), 555, y, { align: 'right' });
          doc.setTextColor(30, 30, 30);
          y += 18;
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    if (!anyDay) {
      doc.setTextColor(150, 150, 150);
      doc.text('Nenhum dia com movimento nessa quinzena.', 40, y);
    }

    // Rodapé
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text(`Balancímetro · gerado em ${new Date().toLocaleString('pt-BR')}`, 40, 820);
      doc.text(`${i}/${pages}`, 555, 820, { align: 'right' });
    }

    const filename = `balancimetro_${startLabel.replace(/\//g, '-')}_${endLabel.replace(/\//g, '-')}.pdf`;
    doc.save(filename);
    showToast('PDF exportado');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
