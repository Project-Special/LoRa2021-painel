/* =============================================================================
   LoRa2021 — painel de bancada
   Estado lido em polling de 1 s; o registro vem junto, com id incremental, pra
   não precisar de WebSocket (num ESP32 com o rádio em ISR só traria disputa
   por CPU sem ganho real aqui).
   ========================================================================== */

'use strict';

const $ = (id) => document.getElementById(id);

// Valores aceitos pelo LR2021 — constantes do chip, não do firmware.
const SF = [5, 6, 7, 8, 9, 10, 11, 12];
const CR = [4, 5, 6, 7, 8];
const BW = [31.25, 41.67, 62.5, 83.33, 100, 125, 203.125, 250, 406.25, 500, 812.5, 1000];

// Posições da matriz de solda do módulo — servem de portadora e de rede casada.
const POS = [150, 433, 470, 868, 915];

// Espelho de kBandProfiles (lib/LoraLink/radio_profile.h). Existe pra a página
// nascer montada mesmo sem rádio respondendo: /api/state sobrescreve quando
// chega. Sem isto, abrir o arquivo direto (ou por Live Server, sem a API) dava
// um painel completamente vazio.
const BANDS = [
  { id: '150',   name: '150 MHz',        note: 'Posição mais baixa da matriz do módulo — uso licenciado' },
  { id: '433',   name: '433 MHz ISM',    note: 'ISM região 1 / radioamador — conferir ciclo de trabalho local' },
  { id: '470',   name: '470 MHz',        note: 'Plano de banda CN470' },
  { id: '868',   name: '868 MHz EU',     note: 'EU868 — limite de +14 dBm ERP, 1% de ciclo de trabalho' },
  { id: '915',   name: '915 MHz AU/US',  note: 'AU915 / US915 — é o plano usado no Brasil' },
  { id: 'sband', name: 'S-band 2.1 GHz', note: 'Banda de satélite LICENCIADA — só laboratório / teste' },
  { id: '2g4',   name: '2.4 GHz ISM',    note: 'ISM mundial — banda larga, vazão bem maior' },
];

// As bandas que a GRADE oferece. A lista BANDS acima continua inteira porque
// dela saem o nome e a nota de qualquer banda que o rádio reporte — mas como
// botão só entram as três em que se pode realmente operar:
//
//   433  a matriz de solda dos módulos ATUAIS está fechada aqui
//   915  plano do Brasil, pra quando houver módulo casado em 915
//   2g4  porta 2.4G, casamento próprio, não depende da matriz
//
// 150 / 470 / 868 pedem outra rede de casamento — clicar neles sintonizava o
// rádio fora da faixa casada, que transmite contra VSWR alto: alcance ruim e
// estresse no PA, sem erro nenhum na tela. S-band é LICENCIADA. Eram quatro
// botões que só tinham como dar errado.
const BAND_GRID = ['433', '915', '2g4'];

const DBM_LO = -130;
const DBM_HI = -30;
const HIST = 90;                 // amostras no gráfico (1 s cada)

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const frac = (dbm) => clamp01((dbm - DBM_LO) / (DBM_HI - DBM_LO));

let lastLog = -1;
let booted = false;
const dirty = new Set();
const history = [];

/* ────────────────────────────────────────────────────────────── ponteiro ── */

const CXP = 120, CYP = 124, R = 88;      // centro e raio do arco
const ARC_LEN = Math.PI * R;

(function buildTicks() {
  let out = '';
  for (let dbm = DBM_LO; dbm <= DBM_HI; dbm += 20) {
    const th = Math.PI * (1 - frac(dbm));          // 180°..0°
    const cos = Math.cos(th), sin = Math.sin(th);
    const at = (r) => [CXP + r * cos, CYP - r * sin];
    // traços e rótulos ficam POR FORA do arco: por dentro eles se amontoavam
    // no miolo e brigavam com o ponteiro.
    const [x1, y1] = at(R + 5);
    const [x2, y2] = at(R + 12);
    const [tx, ty] = at(R + 24);
    // nas pontas o rótulo é ancorado pela lateral, senão o "-130" fica
    // centrado na linha do pivô e parece que escorregou pra fora da escala
    const anchor = cos < -0.7 ? 'end' : cos > 0.7 ? 'start' : 'middle';
    out += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
    out += `<text text-anchor="${anchor}" x="${tx.toFixed(1)}" y="${(ty + 3).toFixed(1)}">${dbm}</text>`;
  }
  $('ticks').innerHTML = out;
})();

function setMeter(dbm) {
  const f = frac(dbm);
  $('needle').style.transform = `rotate(${(-90 + f * 180).toFixed(1)}deg)`;
  $('arc').style.strokeDashoffset = (ARC_LEN * (1 - f)).toFixed(1);
}

/* ─────────────────────────────────────────────────────────────── gráfico ── */

const cv = $('chart');
const cx = cv.getContext('2d');

// Janela vertical do gráfico. Fica em degraus de 20/40/80 dB e só se remexe
// quando o dado sai dela ou fica pequeno demais dentro dela — sem isso o eixo
// se redesenhava a cada segundo e a curva tremia na vertical.
const yScale = { lo: -110, hi: -70 };

function updateScale() {
  if (!history.length) return;
  const mn = Math.min(...history), mx = Math.max(...history);
  const span = yScale.hi - yScale.lo;
  const dentro = mn > yScale.lo + 2 && mx < yScale.hi - 2;
  const frouxa = (mx - mn) < span * 0.3 && span > 10;
  if (dentro && !frouxa) return;

  // começa em 10 dB: parando em 20 o enlace estável (que varia ~5 dB) ocupava
  // um quarto da altura e o espaço dado ao gráfico virava grade vazia
  let novo = 10;
  while (novo < (mx - mn) * 1.8 && novo < 80) novo *= 2;
  // encaixa o piso num múltiplo do passo da grade (linhas em números redondos)
  // sem arredondar o centro antes, senão a curva fica encostada num dos lados
  const st = novo >= 80 ? 20 : novo >= 40 ? 10 : novo >= 20 ? 5 : 2;
  const mid = (mn + mx) / 2;
  yScale.lo = Math.max(-140, Math.floor((mid - novo / 2) / st) * st);
  yScale.hi = Math.min(-20, yScale.lo + novo);
}

const PAD = { r: 12, t: 14, b: 18 };

function drawChart() {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cx.clearRect(0, 0, w, h);

  const glow = getComputedStyle(document.documentElement)
    .getPropertyValue('--glow').trim() || '#6cf0a0';

  const padL = w < 460 ? 26 : 38;
  const x0 = padL, x1 = w - PAD.r;
  const y0 = PAD.t, y1 = h - PAD.b;
  const plotW = x1 - x0, plotH = y1 - y0;

  updateScale();
  const { lo, hi } = yScale;
  const step = hi - lo >= 80 ? 20 : hi - lo >= 40 ? 10 : hi - lo >= 20 ? 5 : 2;
  const yAt = (v) => y1 - plotH * clamp01((v - lo) / (hi - lo));

  // ---- grade + escala em dBm ------------------------------------------
  cx.font = '700 10px ' + getComputedStyle(cv).fontFamily;
  cx.textBaseline = 'middle';
  for (let dbm = Math.ceil(lo / step) * step; dbm <= hi; dbm += step) {
    const y = Math.round(yAt(dbm)) + 0.5;
    cx.strokeStyle = '#1a2320';
    cx.setLineDash([2, 4]);
    cx.lineWidth = 1;
    cx.beginPath(); cx.moveTo(x0, y); cx.lineTo(x1, y); cx.stroke();
    cx.setLineDash([]);
    cx.fillStyle = '#8a9a93';
    cx.textAlign = 'right';
    cx.fillText(String(dbm), x0 - 7, y);
  }
  // divisões de tempo, uma a cada 15 s
  for (let i = 0; i <= 6; i++) {
    const x = Math.round(x0 + (plotW * i) / 6) + 0.5;
    if (i > 0 && i < 6) {
      cx.strokeStyle = '#161e1b';
      cx.beginPath(); cx.moveTo(x, y0); cx.lineTo(x, y1); cx.stroke();
    }
    // estreito: um rótulo sim, outro não — senão "-15s" e "agora" se encostam
    if (w < 460 && i % 2 && i !== 6) continue;
    cx.fillStyle = '#7a8a84';
    // nas pontas alinha pela lateral: no centro o primeiro invadia a calha
    // dos dBm e o último passava da borda
    cx.textAlign = i === 0 ? 'left' : i === 6 ? 'right' : 'center';
    cx.fillText(i === 6 ? 'agora' : `-${(6 - i) * 15}s`, x, y1 + 9);
  }

  // moldura do gráfico
  cx.strokeStyle = '#1d2622';
  cx.strokeRect(x0 + 0.5, y0 + 0.5, plotW - 1, plotH - 1);

  if (history.length < 2) return;

  // Enquanto a janela não encheu, os pontos se espalham por toda a largura —
  // o gráfico já nasce legível em vez de um traço espremido na direita.
  const n = history.length;
  const xAt = (i) => x0 + (plotW * i) / (n - 1);

  const pts = history.map((v, i) => [xAt(i), yAt(v)]);

  // traça a curva suavizada (pontos médios + quadráticas)
  const path = () => {
    cx.beginPath();
    cx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      const [px, py] = pts[i - 1];
      const [nx, ny] = pts[i];
      cx.quadraticCurveTo(px, py, (px + nx) / 2, (py + ny) / 2);
    }
    cx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  };

  // área
  const grad = cx.createLinearGradient(0, y0, 0, y1);
  grad.addColorStop(0, glow + '4d');
  grad.addColorStop(1, glow + '00');
  cx.save();
  path();
  cx.lineTo(pts[pts.length - 1][0], y1);
  cx.lineTo(pts[0][0], y1);
  cx.closePath();
  cx.fillStyle = grad;
  cx.fill();
  cx.restore();

  // linha
  path();
  cx.strokeStyle = glow;
  cx.lineWidth = 1.6;
  cx.lineJoin = 'round';
  cx.lineCap = 'round';
  cx.shadowColor = glow + '99';
  cx.shadowBlur = 6;
  cx.stroke();
  cx.shadowBlur = 0;

  // nível atual: tracejada neutra até a borda. No acento ela virava uma
  // segunda curva luminosa competindo com o dado.
  const [lx, ly] = pts[pts.length - 1];
  cx.strokeStyle = '#ffffff1a';
  cx.setLineDash([3, 3]);
  cx.beginPath(); cx.moveTo(x0, ly); cx.lineTo(lx, ly); cx.stroke();
  cx.setLineDash([]);

  cx.fillStyle = glow;
  cx.shadowColor = glow;
  cx.shadowBlur = 10;
  cx.beginPath(); cx.arc(lx, ly, 3, 0, Math.PI * 2); cx.fill();
  cx.shadowBlur = 0;
}

window.addEventListener('resize', drawChart);

/* ─────────────────────────────────────────────────────────────── registro ── */

let logSeq = 0;

function log(kind, msg) {
  const li = document.createElement('li');
  li.className = kind;
  if (logSeq++ % 2) li.classList.add('alt');
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  li.innerHTML = `<time>${hh}:${mm}:${ss}</time><span class="msg"></span>`;
  li.querySelector('.msg').textContent = msg;

  const box = $('log');
  box.prepend(li);
  while (box.children.length > 120) box.lastElementChild.remove();
}

onEl('clear', 'click', () => { $('log').innerHTML = ''; });

/* ───────────────────────────────────────────────────────────────── rede ── */

async function api(path, body) {
  const opt = body
    ? { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body) }
    : {};
  const r = await fetch(path, opt);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

/* ─────────────────────────────────────────────────────────────── widgets ── */

function fillSelect(el, values) {
  el.innerHTML = values.map((v) => `<option value="${v}">${v}</option>`).join('');
}

function buildBands() {
  const box = $('bands');
  box.innerHTML = BANDS
    .filter((b) => BAND_GRID.includes(b.id))
    .map((b) => `<button type="button" data-id="${b.id}" aria-pressed="false">${b.id.toUpperCase()}</button>`)
    .join('');

  box.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const b = BANDS.find((x) => x.id === btn.dataset.id);
    try {
      const st = await api('api/config', { band: btn.dataset.id });
      dirty.clear();
      history.length = 0;              // outra banda, outra escala de sinal
      render(st, true);
      log('sys', `banda: ${b.name}`);
    } catch (e) {
      log('err', `falha ao trocar de banda: ${e.message}`);
    }
  });
}

// Fallback do seletor de protocolo, para a pagina montar antes da primeira
// resposta do firmware. O /api/state sobrescreve com protoOpts.
const PROTOS = [
  { id: 'elrs', name: 'ExpressLRS',
    note: 'Quadro OTA v3 de 8 bytes. Escuta o transmissor comercial; o par define a camada fisica.' },
  { id: 'alfa', name: 'Protocolo Alfa',
    note: 'Enlace Alfatronic: ID de 96 bits, busca no canal padrao 38 e canal de trabalho recebido pelo ar.' },
  { id: 'espnow', name: 'ESP-NOW',
    note: 'Radio de 2,4 GHz do proprio ESP32, quadro de 15 bytes com sete joysticks e trinta e dois bits de chave. O LR2021 sai do ar.' },
  { id: 'ble', name: 'Alfa por BLE',
    note: 'O MESMO protocolo Alfa -- quadro de 15 bytes, rodizio do byte de ID, pareamento de 96 bits -- transportado por BLE em vez do LR2021, que sai do ar.' },
];

// Par de teste: o usuário declara o que está do outro lado e o rádio se
// configura naquela modulação. É <select> e não botões pelo mesmo motivo da
// rede de casamento — não competir com a grade de bandas.
const PEERS = [
  { id: 'bancada', name: 'Outra placa LoRa2021', decodes: true,
    note: 'Par igual a este firmware: decodifica e faz ping-pong.' },
  { id: 'elrs2g4', name: 'Transmissor ExpressLRS 2.4 GHz', decodes: true,
    note: 'Escuta na modulação do ELRS 2.4 GHz 50 Hz.' },
  { id: 'elrs900', name: 'Transmissor ExpressLRS 900 MHz', decodes: true,
    note: 'Escuta na modulação do ELRS 900 MHz 50 Hz.' },
];

function buildPeers(list) {
  const el = $('peer');
  el.innerHTML = list.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  el.addEventListener('change', async (ev) => {
    try {
      const st = await api('api/config', { peer: ev.target.value });
      dirty.clear();
      history.length = 0;
      render(st, true);
    } catch (e) {
      log('err', `par de teste: ${e.message}`);
    }
  });
}

// Protocolo. Trocar aqui reescreve a camada fisica inteira no firmware, entao
// o painel descarta o historico e o que estava sujo: os numeros da tela
// passaram a ser de outra pilha, e misturar as duas series no grafico produz um
// degrau que parece medida.
// Reconstroi o seletor QUANDO A LISTA MUDA, e registra o ouvinte uma vez so.
//
// Antes ele era montado uma unica vez, no arranque, com a lista fixa de
// fallback -- e o `protoOpts` que vem do firmware nunca chegava ao <select>.
// Efeito: um protocolo novo na placa (o ESP-NOW) existia na API, no console e
// no display, e faltava exatamente onde se escolhe. A assinatura evita
// reconstruir a cada enquete, que apagaria a selecao em curso.
let protoOuvinte = false;

// Razoes oferecidas, na escala do ExpressLRS.
const TLM_RAZOES = [1, 2, 4, 8, 16, 32, 64, 128, 256];
let tlmRazMontado = false;

function buildTlmRaz() {
  const el = $('tlmRaz');
  if (!el || tlmRazMontado) return;
  tlmRazMontado = true;
  el.innerHTML = TLM_RAZOES.map((n) => `<option value="${n}">1:${n}</option>`).join('');
  el.addEventListener('change', async (ev) => {
    const v = ev.target.value;
    try {
      if (LINK.mode !== 'http') {
        await serialWrite(`tlm ${v}
`);
        log('sys', `telemetria 1:${v} (pela USB)`);
        return;
      }
      await api('api/config', { tlmraz: v });
      log('sys', `telemetria 1:${v}`);
    } catch (e) {
      log('err', `telemetria falhou: ${e.message}`);
    }
  });
}

// Quadros por segundo do enlace, medidos entre duas leituras de estado.
let tlmQuadrosAnt = null;
let tlmQuadrosT = 0;
let tlmQps = 0;

function notaTlmRaz(s) {
  const el = $('tlmNotaRaz');
  if (!el) return;
  const razao = Number(s.tlmraz) || 0;
  const quadros = (Number(s.tx) || 0) + (Number(s.rx) || 0);
  const agora = Date.now();
  if (tlmQuadrosAnt === null) {
    tlmQuadrosAnt = quadros;
    tlmQuadrosT = agora;
  } else {
    const dq = quadros - tlmQuadrosAnt;
    const dt = (agora - tlmQuadrosT) / 1000;
    if (dq >= 0 && dt >= 0.5) {
      // Media exponencial: a contagem entra por enquete, e um pico entre
      // duas leituras faria o numero saltar sem o enlace ter mudado.
      const inst = dq / dt;
      tlmQps = tlmQps ? tlmQps * 0.7 + inst * 0.3 : inst;
      tlmQuadrosAnt = quadros;
      tlmQuadrosT = agora;
    }
  }
  if (!razao) { el.textContent = '·'; return; }
  if (tlmQps < 0.2) {
    el.textContent = `1:${razao} — enlace parado; sai uma linha a cada 5 s pelo teto de silencio`;
    return;
  }
  const seg = razao / tlmQps;
  const efetivo = seg >= 1 ? `${seg.toFixed(1)} s` : `${Math.round(seg * 1000)} ms`;
  let txt = `1:${razao} — ${Math.round(tlmQps)} quadros/s no enlace, ` +
    `uma linha a cada ${efetivo}`;
  // Acima de 8 s o app de alcance passa a chamar a PLACA de muda: e o prazo
  // de LINK_STALE_MS dele. Avisar aqui evita que a escolha pareca defeito.
  // O firmware limita o intervalo a 5 s: a linha `$T` tambem e a prova de
  // vida que o app do celular espera, e ele desiste em 8 s.
  if (seg > 5) txt += ' — limitado a 5 s: a placa tem de dar sinal de vida';
  el.textContent = txt;
}

// Registra ouvinte SEM derrubar a pagina quando o elemento nao existe.
//
// Os ouvintes moram no topo do modulo, e ali um `$('x')` nulo lanca antes
// de qualquer coisa rodar: a pagina inteira fica vazia por causa de um
// controle. Acontece sempre que o HTML e o JS ficam descasados -- cache do
// navegador, gravacao parcial do filesystem -- e a falha nao se parece com
// a causa. Assim um controle ausente custa aquele controle, e mais nada.
function onEl(id, ev, fn) {
  const el = $(id);
  if (!el) {
    console.warn(`painel: #${id} nao existe; ouvinte de ${ev} ignorado`);
    return;
  }
  el.addEventListener(ev, fn);
}

function buildProto(list) {
  const el = $('proto');
  const sig = list.map((p) => p.id).join(',');
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;

  const atual = el.value;
  el.innerHTML = list
    .map((p) => `<option value="${p.id}">${p.name}</option>`)
    .join('');
  if (atual && list.some((p) => p.id === atual)) el.value = atual;

  if (protoOuvinte) return;
  protoOuvinte = true;
  el.addEventListener('change', async (ev) => {
    const escolhido = ev.target.value;
    try {
      // Pela USB nao ha rota HTTP: quem troca o protocolo e o comando do
      // console da placa, o mesmo que se digitaria no monitor serial. O painel
      // nao recebe estado de volta na hora -- ele chega na proxima linha $A.
      if (LINK.mode !== 'http') {
        await serialWrite(`proto ${escolhido}\n`);
        log('sys', `protocolo: ${escolhido} (pela USB)`);
        return;
      }
      const st = await api('api/config', { proto: escolhido });
      dirty.clear();
      history.length = 0;
      render(st, true);
      log('sys', `protocolo: ${escolhido}`);
    } catch (e) {
      log('err', `protocolo: ${e.message}`);
      // A troca falhou: devolve o seletor ao que o firmware realmente tem, em
      // vez de deixar a tela afirmando um protocolo que nao subiu. Pela USB
      // isso acontece sozinho na proxima linha $A.
      if (LINK.mode === 'http') {
        try { render(await api('api/state'), true); } catch (_) { /* sem rede */ }
      }
    }
  });
}

// Papel no protocolo Alfa. Trocar reinicia a sessao do enlace no firmware, e o
// painel descarta o historico pelo mesmo motivo do seletor de protocolo: os
// numeros passam a ser de outro lado do enlace.
/* Os dois papeis do enlace Alfa. O nome curto e o que vai no botao; a frase
   explica quem fala primeiro e vira o `title`. */
const PAPEIS = [
  { id: 'rx', name: 'Receptor', nota: 'responde ao transmissor' },
  { id: 'tx', name: 'Transmissor', nota: 'chama o receptor' },
];

async function mandaPapelAlfa(id) {
  pintaPapelAlfa(id);
  try {
    if (LINK.mode !== 'http') {
      await serialWrite(`proto papel ${id}\n`);
      log('sys', `papel: ${id} (pela USB)`);
      return;
    }
    const st = await api('api/config', { apapel: id });
    history.length = 0;
    render(st, true);
    log('sys', `papel: ${id}`);
  } catch (e) {
    log('err', `papel: ${e.message}`);
  }
}

/* Comando dos sete joysticks do Alfa, na aba dos mostradores.
   Cada barra manda no `change`, e nao no `input`: arrastar gera um evento por
   pixel, e o radio nao tem por que receber cem quadros para um movimento. O
   rotulo acompanha ao vivo, entao o arrasto continua tendo resposta. */
let joyCmdPronto = false;

function buildJoyCmd() {
  const box = $('joyCmd');
  if (!box || joyCmdPronto) return;
  box.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const l = document.createElement('label');
    l.className = 'joycmd__l';
    l.innerHTML = `<b>J${i + 1}</b>` +
      `<input id="cj${i}" type="range" min="-100" max="100" step="1" value="0">` +
      `<output id="cjv${i}">0</output>`;
    box.appendChild(l);
  }
  for (let i = 0; i < 7; i++) {
    const el = $(`cj${i}`);
    const rot = $(`cjv${i}`);
    if (!el) continue;
    el.addEventListener('input', () => { if (rot) rot.textContent = el.value; });
    el.addEventListener('change', async () => {
      try {
        if (LINK.mode !== 'http') {
          await serialWrite(`proto joy ${i} ${el.value}\n`);
          return;
        }
        await api('api/config', { ajoy: `${i}:${el.value}` });
      } catch (e) {
        log('err', `joystick J${i + 1}: ${e.message}`);
      }
    });
  }
  joyCmdPronto = true;
}

/* Acompanha o estado sem atropelar quem esta arrastando. */
function pintaJoyCmd(s) {
  const box = $('joyCmd');
  if (!box) return;
  const alfa = Array.isArray(s.aj) && s.aj.length === ALFA_JOYS;
  const tx = s.alfa?.papel === 'transmissor';
  box.hidden = !(alfa && tx);
  if (box.hidden) return;
  buildJoyCmd();
  for (let i = 0; i < 7; i++) {
    const el = $(`cj${i}`);
    const rot = $(`cjv${i}`);
    if (!el || document.activeElement === el) continue;
    el.value = String(s.aj[i]);
    if (rot) rot.textContent = String(s.aj[i]);
  }
}

function pintaPapelAlfa(id) {
  const el = $('aPapel');
  if (!el) return;
  for (const b of el.children) {
    const meu = b.dataset.papel === id;
    b.setAttribute('aria-pressed', meu ? 'true' : 'false');
    b.setAttribute('aria-checked', meu ? 'true' : 'false');
  }
}

function buildPapelAlfa() {
  const el = $('aPapel');
  if (!el) return;
  el.innerHTML = '';
  for (const p of PAPEIS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.papel = p.id;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');
    b.title = p.nota;
    b.textContent = p.name;
    b.addEventListener('click', () => void mandaPapelAlfa(p.id));
    el.appendChild(b);
  }

  const cx = $('aVarre');
  if (cx) {
    cx.addEventListener('change', async (ev) => {
      const on = ev.target.checked ? '1' : '0';
      try {
        if (LINK.mode !== 'http') {
          await serialWrite(`proto joy ${ev.target.checked ? 'varre' : 'para'}
`);
          return;
        }
        await api('api/config', { avarre: on });
      } catch (e) {
        log('err', `joystick simulado: ${e.message}`);
      }
    });
  }
}

/* Papel no ESP-NOW. O Alfa -- por LoRa ou por BLE -- tem o papel dele no bloco
   de cima, porque ali papel decide identidade, e nao so quem emite. */
const PAPEIS_ESP = [
  { id: 'rx', name: 'Receptor', nota: 'recebe os quadros e devolve o relato' },
  { id: 'tx', name: 'Transmissor', nota: 'envia os quadros' },
];

function pintaPapelEsp(id) {
  const el = $('ePapel');
  if (!el) return;
  for (const b of el.children) {
    const meu = b.dataset.papel === id;
    b.setAttribute('aria-pressed', meu ? 'true' : 'false');
    b.setAttribute('aria-checked', meu ? 'true' : 'false');
  }
}

async function mandaPapelEsp(id) {
  pintaPapelEsp(id);
  try {
    if (LINK.mode !== 'http') {
      await serialWrite(`enow ${id}\n`);
      log('sys', `papel: ${id} (pela USB)`);
      return;
    }
    const st = await api('api/config', { epapel: id });
    history.length = 0;
    render(st, true);
    log('sys', `papel: ${id}`);
  } catch (e) {
    log('err', `papel: ${e.message}`);
  }
}

function buildPapelEsp() {
  const el = $('ePapel');
  if (!el) return;
  el.innerHTML = '';
  for (const p of PAPEIS_ESP) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.papel = p.id;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');
    b.title = p.nota;
    b.textContent = p.name;
    b.addEventListener('click', () => void mandaPapelEsp(p.id));
    el.appendChild(b);
  }

  const cx = $('eVarre');
  if (cx) {
    cx.addEventListener('change', async (ev) => {
      const on = ev.target.checked;
      try {
        if (LINK.mode !== 'http') {
          await serialWrite(`enow varre ${on ? 'on' : 'off'}\n`);
          return;
        }
        await api('api/config', { evarre: on ? '1' : '0' });
      } catch (e) {
        log('err', `joystick simulado: ${e.message}`);
      }
    });
  }
}

/* O Alfa por BLE nao tem bloco proprio: o enlace e o mesmo, e ele ja esta
   desenhado acima. O que muda e a linha do CANAL -- por BLE nao ha portadora --,
   que passa a dizer com quem se esta falando e com que sinal. */
function renderAlfaPorBle(s) {
  const b = s.ble;
  const sub = $('aSub');
  const lb = $('aCanalLb');
  if (!b) {
    if (sub) sub.textContent = 'ID de 96 bits';
    if (lb) lb.textContent = 'Canal';
    return;
  }
  if (sub) sub.textContent = 'por BLE · ID de 96 bits';
  if (lb) lb.textContent = 'BLE';
  const rssi = Number.isFinite(b.rssi) ? `${b.rssi} dBm` : '—';
  // O PHY EM USO, lido do controlador -- nao a escolha. Quando os dois
  // divergem (pediu Coded, o par so fala 1M) a linha diz isso por extenso.
  const uso = { 1: '1M', 2: '2M', 3: 'Coded' }[b.phyUso];
  let phy = uso || '';
  if (b.phy === 'coded' && uso && uso !== 'Coded') phy = `${uso} (pediu Coded)`;
  $('aCanal').textContent = b.conectado
    ? [b.par || 'conectado', rssi, phy].filter(Boolean).join(' · ')
    : b.estado;
}

function renderEsp(s) {
  const esp = s.espnow;
  if (!esp) return;
  const tx = esp.papel === 'tx';
  $('eTitulo').textContent = 'Enlace ESP-NOW';
  $('eSub').textContent = `difusão · canal ${esp.canal}`;
  pintaPapelEsp(esp.papel);
  // Varredura so no transmissor: e ele que gera os joysticks.
  $('fEVarre').hidden = !tx;
  if (esp.varre !== undefined && document.activeElement !== $('eVarre')) {
    $('eVarre').checked = !!esp.varre;
  }
  $('eEstado').textContent = esp.vivo ? `${esp.estado} · enlace vivo` : esp.estado;
  $('ePar').textContent = esp.par || 'ninguém ainda';

  const dbm = (v) => (Number.isFinite(v) ? `${v} dBm` : '—');
  // Cada lado conta o que PODE contar: o transmissor nao recebe quadro, e o
  // numero que interessa ali e o que o receptor relatou ter visto.
  if (tx) {
    const r = esp.relato;
    $('eCont').textContent = `enviados ${esp.tx} · RSSI ${dbm(esp.rssi)} · ` + (r
      ? `o receptor vê: LQ ${r.lq} %, RSSI ${dbm(r.rssi)}, ${r.rx} quadros, ` +
        `${r.perdidos} perdidos (há ${(r.idade / 1000).toFixed(0)} s)`
      : 'nenhum relato do receptor ainda');
  } else {
    $('eCont').textContent =
      `recebidos ${esp.rx} · perdidos ${esp.perdidos} · recusados ${esp.ruins} · ` +
      `LQ ${esp.lq} % · RSSI ${dbm(esp.rssi)}`;
  }
}

function buildMatch() {
  const el = $('match');
  el.innerHTML = POS.map((m) => `<option value="${m}">${m} MHz</option>`).join('');
  el.addEventListener('change', async (ev) => {
    try {
      render(await api('api/config', { match: ev.target.value }), true);
      log('sys', `rede de casamento: ${ev.target.value} MHz`);
    } catch (e) {
      log('err', `rede de casamento: ${e.message}`);
    }
  });
}

/** Escreve só se o usuário não estiver mexendo no campo. */
// Escrita que IGNORA o estado "mexido pelo usuario".
//
// put() respeita `dirty` para nao apagar o que alguem esta digitando. Isso vale
// para campos que SAO ajustes. No ExpressLRS, frequencia/SF/BW/CR nao sao: saem
// da taxa escolhida. Um toque acidental num deles os marcava como sujos para
// sempre, e a partir dali paravam de refletir o radio -- ficavam mostrando
// 812,5 kHz numa placa ja operando em 500.
function putSempre(el, value) {
  if (!el) return;
  const v = value === undefined || value === null ? '·' : value;
  if ('value' in el) el.value = v;
  else el.textContent = v;
}

function put(el, value) {
  if (dirty.has(el.id) || document.activeElement === el) return;
  if (el.type === 'checkbox') el.checked = !!value;
  else el.value = value;
}

/** Atualiza um contador e pisca se mudou. */
function readout(el, value) {
  const txt = String(value);
  if (el.textContent === txt) return;
  el.textContent = txt;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

/* ────────────────────────────────────────────────────────────────  render ── */

/* Qualidade de enlace.
   255 e a convencao do firmware para "sem medida" — so o RECEPTOR conta
   perdidos pela numeracao dos quadros, entao no transmissor este numero nao
   existe. Mostrar 100% ali seria inventar uma medida que ninguem fez.

   Zero por cento e "sem medida" precisam parecer diferentes: um e um enlace
   pessimo, o outro e a ausencia de informacao. */
function renderLq(s) {
  const out = $('lq');
  const bar = $('lqBar');
  const note = $('lqNote');
  const v = s.lq;

  if (v === undefined || v === null || v > 100) {
    out.textContent = '––';
    out.dataset.none = '1';
    bar.style.width = '0%';
    // Quem NAO mede LQ e o transmissor; o receptor sem enlace simplesmente nao
    // tem o que medir. Distinguir pelo papel (tlm < 0 e receptor), nao por
    // s.node existir -- isso dava "este no e transmissor" numa placa ELRS RX.
    note.textContent = (s.tlm !== undefined && s.tlm < 0)
      ? 'sem enlace — nenhum quadro chegando'
      : (s.node ? 'so o receptor mede LQ — este no e transmissor' : '·');
    return;
  }

  out.textContent = v;
  delete out.dataset.none;
  bar.style.width = v + '%';
  note.textContent =
    (s.lost ? s.lost + ' quadro(s) perdido(s)' : 'nenhum quadro perdido') +
    ' · ' + s.rx + ' recebidos';
}

/* Mostradores da aba de relance.
   Reaproveita a MESMA escala do ponteiro (DBM_LO/DBM_HI): duas leituras do
   mesmo RSSI na mesma pagina discordarem sobre o que e "meio" seria pior que
   nao mostrar nenhuma das duas. */
function renderGauges(s) {
  renderLq(s);
  renderSticks(s);

  const out = $('gRssi');
  const bar = $('gRssiBar');
  const note = $('gRssiNote');

  // Campo AUSENTE e "nenhuma leitura", nao "sinal de zero" -- e zero dBm nao
  // existe em LoRa, entao rssi >= 0 tambem e ausencia. Nao olha mais `s.rx`:
  // essa chave passou a reportar a cadencia configurada, e nao quadros vistos.
  if (!Number.isFinite(s.rssi) || s.rssi >= 0) {
    out.textContent = '–––.–';
    out.dataset.none = '1';
    bar.style.width = '0%';
    note.textContent = 'nenhum quadro recebido ainda';
  } else {
    out.textContent = s.rssi.toFixed(1);
    delete out.dataset.none;
    bar.style.width = (frac(s.rssi) * 100).toFixed(1) + '%';
    note.textContent = s.linked ? 'enlace ativo' : 'ultima leitura — enlace caiu';
  }

  // Campo AUSENTE vira traco, nao zero.
  //
  // O receptor ExpressLRS nao mede potencia nem tempo no ar, e antes esses
  // campos vinham como 0 — a tela afirmava "potencia 0 dBm" e "tempo no ar
  // 0 ms", numeros que ninguem mediu. Ausente e diferente de zero, e a tela
  // precisa dizer qual dos dois e.
  const tr = (v, casas) =>
    v === undefined || v === null || !Number.isFinite(Number(v))
      ? '–––'
      : casas === undefined ? String(v) : Number(v).toFixed(casas);

  $('gSnr').textContent = s.snr === undefined ? '––.–' : Number(s.snr).toFixed(1);
  $('gToa').textContent = tr(s.toa);
  $('gPwr').textContent = tr(s.power);
  $('gFreq').textContent = tr(s.freq, 3);
  $('gRx').textContent = tr(s.rx);
  $('gLost').textContent = tr(s.lost);
  $('gWho').textContent = (s.node || '····') + ' · ' + (s.band || '—');
}

/* Esconde o que ESTE firmware nao tem, em vez de exibir campo vazio.
   O painel nasceu para o firmware de bancada; rodando no ExpressLRS, metade
   dos conceitos nao existe -- nao ha rede de casamento, nem par de teste, nem
   frase guardada (ela vira UID na gravacao). Campo vazio sem explicacao e pior
   que campo ausente: parece defeito, e manda o operador procurar problema onde
   nao ha. */
/* Distribuicao das colunas por FIRMWARE.
   O arranjo original serve a bancada: banda a esquerda, modem no meio, trafego
   a direita. No ExpressLRS ele desanda -- a coluna 1 acumula banda, plano, taxa
   e telemetria enquanto a 3 fica cheia de controles que aquele firmware nao
   atende (mensagem, ping, beacon nao existem nele). Sobra rolagem de um lado e
   vazio do outro.
   Aqui as pecas mudam de coluna uma unica vez, e so nesse caso:
     1 · Banda + Plano     2 · Enlace (taxa, telemetria)     3 · Modem
   A bancada nao e tocada. */
let colunasArrumadas = false;

/* Esconde uma coluna que ficou so com o titulo.
   As secoes aparecem e somem conforme o protocolo no ar -- no Alfa a de
   trafego inteira nao se aplica --, e a moldura vazia ficava ocupando um
   terco da largura sem dizer nada. */
function escondeColunaVazia(id) {
  const col = $(id);
  if (!col) return;
  const conteudo = [...col.children].filter((e) => e.tagName !== 'H2');
  col.hidden = conteudo.length > 0 && conteudo.every((e) => e.hidden);
}

function arrumarColunas(elrs) {
  if (!elrs || colunasArrumadas) return;
  const col2 = $('pCol2'), col3 = $('pCol3');
  const modem = $('secModem'), taxa = $('secTaxa'), tlm = $('secTlm'), traf = $('secTrafego');
  if (!col2 || !col3 || !modem) return;

  if ($('tCol2')) $('tCol2').textContent = 'Enlace';
  if ($('tCol3')) $('tCol3').textContent = 'Modem';
  if (taxa) col2.appendChild(taxa);
  // A potencia GRAVA -- pertence a coluna dos controles, nao a das leituras.
  if ($('fPowerSel')) col2.appendChild($('fPowerSel'));
  if ($('powerHint')) col2.appendChild($('powerHint'));
  if (tlm) col2.appendChild(tlm);
  col3.appendChild(modem);
  if ($('specModem')) col3.appendChild($('specModem'));
  // O beacon so vale no teste de alcance entre duas placas nossas -- quem
  // decide e o par, e a regra vive em `mostraTrafego`.
  if (traf) traf.hidden = true;
  colunasArrumadas = true;
}

function ajustarSecoes(s) {
  const tem = (k) => s[k] !== undefined && s[k] !== null;
  const arr = (k) => Array.isArray(s[k]) && s[k].length > 0;

  const mostra = (id, on) => { const e = $(id); if (e) e.hidden = !on; };

  mostra('secProto', arr('protoOpts'));
  mostra('secAlfa', tem('alfa'));
  mostra('secEsp', tem('espnow'));

  // Par de teste e frase de binding sao do ExpressLRS. No Alfa quem faz esse
  // papel e o ID de 96 bits, e deixar os dois na tela sugere que ainda valem.
  // Nos transceptores do ESP32 nao ha nem uma coisa nem outra.
  const semElrs = ['alfa', 'espnow', 'ble'].includes(s.proto);
  mostra('secPeer', arr('peerOpts') && !semElrs);
  mostra('secBind', tem('phrase') && !semElrs);
  // O UID vem sempre e identifica o par; a FRASE nao e guardada pelo firmware.
  // Escondia-se o bloco inteiro e o UID ia junto, sem motivo.
  mostra('secUid', tem('uid') && !semElrs);
  // 'Perdidos' e o painel Registro nao existem no ExpressLRS: o firmware manda
  // lost:0 e log:[] fixos. Zero eterno parece medida; e campo vazio.
  const ehElrs = String(s.node || '').indexOf('ELRS') === 0;
  const celLost = $('gLost') && $('gLost').closest('div');
  if (celLost) celLost.hidden = ehElrs;
  mostra('secHw', arr('matchOpts'));
  mostra('bands', arr('bands') || !s.node || String(s.node).indexOf('ELRS') !== 0);


  // Contadores do protocolo proprio. No ExpressLRS quem conta pacote e o LQ, e
  // "enviados/CRC ruim/ida e volta" simplesmente nao tem equivalente.
  // "Recebidos" no ExpressLRS e a CADENCIA da taxa, nao quadros contados -- o
  // firmware manda 1000000/interval. Rotular de outro jeito era mostrar 50 numa
  // placa parada e chamar isso de recepcao.
  const rotRx = $('rx') && $('rx').previousElementSibling;
  if (rotRx) rotRx.textContent = String(s.node || '').indexOf('ELRS') === 0
    ? 'Cadência · Hz' : 'Recebidos';

  for (const [id, k] of [['tx','tx'], ['err','err'], ['rtt','rtt']]) {
    const cel = $(id) && $(id).closest('div');
    if (cel) cel.hidden = !tem(k) || String(s.node || '').indexOf('ELRS') === 0;
  }
}

/* Razao de telemetria. Os indices sao os do expresslrs_tlm_ratio_e; a ordem
   importa e nao pode ser reordenada aqui sem mexer no firmware. */
const TLM_OPCOES = [
  [1, 'Desligada'],
  [0, 'Padrao da taxa'],
  [2, '1:128  (leve)'],
  [3, '1:64'],
  [4, '1:32'],
  [5, '1:16'],
  [6, '1:8'],
  [7, '1:4'],
  [8, '1:2  (rapida, ocupa metade do ar)'],
  [9, 'So desarmado'],
];

let tlmMontado = false;

/* Taxa de pacote -- e, junto com ela, a banda.
   A lista vem do FIRMWARE (s.rates), nao daqui: o painel vive dentro dele, e
   uma tabela duplicada ficaria errada no dia em que as taxas mudassem. */
let taxaMontada = false;

/* Banda, plano e taxa sao TRES coisas e o painel as mostrava soltas: o
   seletor de plano listava so o lado sub-GHz, e 2,4 GHz nao aparecia em lugar
   nenhum porque nao e um "plano" -- e uma tabela fixa. Quem opera nao pensa
   assim: pensa "quero 433", "quero 915", "quero 2,4". A banda passa a ser o
   controle de cima, e plano e taxa se filtram por ela. */
const BANDAS_USO = [
  { id: '433', nome: '433 MHz' },
  { id: '915', nome: '915 MHz' },
  { id: '2g4', nome: '2,4 GHz' },
];

/* Em qual banda cai um plano de salto, pela frequencia central que o firmware
   informa. Evita repetir aqui a tabela de dominios do ExpressLRS. */
function bandaDoPlano(mhz) {
  if (mhz < 460) return '433';   // 460, nao 500: CN470 tem centro em 490 MHz
  if (mhz < 600) return '470';
  if (mhz < 900) return '868';
  return '915';
}

let bandaMontada = false;

function renderBanda(s) {
  // Banda nos DOIS lados, e nos dois ela grava na flash.
  //
  //   TX -> taxa de transmissao + plano. E o que ele anuncia no SYNC.
  //   RX -> taxa INICIAL de busca + plano. O receptor comeca por ela e insiste
  //         antes de varrer as outras.
  //
  // Enquanto o par estiver ligado o SYNC manda: o receptor segue o transmissor.
  // A escolha do receptor vale no BOOT e quando o enlace cai -- e e ela que
  // decide em qual banda ele passa a maior parte do tempo procurando.
  const taxas = Array.isArray(s.rates) ? s.rates : [];
  const doms = Array.isArray(s.domains) ? s.domains : [];
  const subG = taxas.filter((r) => r.b !== '2g4');
  const g24 = taxas.filter((r) => r.b === '2g4');

  // As bandas vem dos PLANOS, nao das taxas.
  //
  // Cada taxa sub-GHz e rotulada com a banda do plano ATIVO -- em 433 todas
  // dizem "433". Montar a lista a partir delas fazia 915 nunca aparecer, porque
  // so apareceria depois de ja estar em 915. Os planos, ao contrario, existem
  // todos o tempo todo, independentes do que esta em uso.
  const disp = BANDAS_USO.filter((b) =>
    b.id === '2g4' ? g24.length > 0
                   : subG.length > 0 && doms.some((d) => bandaDoPlano(d.mhz) === b.id));

  // Se a placa estiver numa banda fora da lista curta, ela entra: a tela tem de
  // dizer onde o radio ESTA, e nao so onde e comum estar.
  if (s.band && !disp.some((b) => b.id === s.band)) {
    disp.push({ id: s.band, nome: `${s.band} MHz` });
  }

  const cx = $('secBanda');
  if (cx) cx.hidden = disp.length < 2;
  if (disp.length < 2) return;

  const el = $('banda');
  const assinatura = disp.map((b) => b.id).join('|');

  if (!bandaMontada || el.dataset.sig !== assinatura) {
    el.innerHTML = '';
    for (const b of disp) {
      // "fora da faixa" sai do que o firmware disse sobre os planos daquela
      // banda -- nao de um palpite do painel.
      const plano = doms.find((d) => bandaDoPlano(d.mhz) === b.id);
      const fora = b.id !== '2g4' && plano && plano.ok === false;
      const o = document.createElement('option');
      o.value = b.id;
      o.textContent = b.nome + (fora ? '  — fora da faixa do módulo' : '');
      if (fora) o.dataset.fora = '1';
      el.appendChild(o);
    }
    el.dataset.sig = assinatura;

    if (!bandaMontada) {
      el.addEventListener('change', async () => {
        const alvo = el.value;
        const opt = el.options[el.selectedIndex];
        // A taxa mais LENTA da banda de destino: e a de maior alcance, que e o
        // que esta bancada mede. Ajusta-se depois no seletor de taxa.
        const cand = (alvo === '2g4' ? g24 : subG).slice().sort((x, y) => x.hz - y.hz);
        if (!cand.length) { log('err', `sem taxa disponível em ${opt.textContent}`); return; }
        const corpo = { rate: cand[0].i };
        if (alvo !== '2g4') {
          const plano = doms.find((d) => bandaDoPlano(d.mhz) === alvo && d.ok !== false)
                     || doms.find((d) => bandaDoPlano(d.mhz) === alvo);
          if (plano) corpo.domain = plano.i;
        }

        if (opt.dataset.fora) {
          log('err', `${opt.textContent} — o rádio sintoniza, mas a antena do módulo não casa aí`);
        }
        try {
          await api('api/config', corpo);
          log('sys', `banda: ${opt.textContent} · ${cand[0].hz} Hz — placa reiniciando`);
        } catch (e) {
          log('err', `falha ao mudar a banda: ${e.message}`);
        }
      });
      bandaMontada = true;
    }
  }
  if (document.activeElement !== el && s.band) el.value = s.band;
}

let domMontado = false;

function renderDominios(s) {
  // Planos sao coisa do lado sub-GHz. Em 2,4 GHz existe um so, fixo, e um
  // seletor de um item unico e ruido -- por isso a secao some ali.
  const todos = Array.isArray(s.domains) ? s.domains : [];
  const ehRx = s.tlm !== undefined && s.tlm < 0;

  // Os planos da banda selecionada logo acima. Em 2,4 GHz nao aparece: la
  // existe um plano so, e um seletor de item unico e ruido.
  const lista = todos.filter((d) => bandaDoPlano(d.mhz) === s.band);
  const tem = lista.length > 1 && s.band !== '2g4';
  const cx = $('secDominio');
  if (cx) cx.hidden = !tem;
  const nota = $('planoNota');
  if (nota) {
    nota.textContent = 'Em quais canais as taxas sub-GHz saltam. Gravado na flash desta placa e mantido no reset. A OUTRA ponta precisa do mesmo plano — o plano não viaja no pacote de sincronismo.'
      + (ehRx ? ' Com o par ligado, a banda em uso segue o transmissor; esta escolha vale no boot e sempre que o enlace cai.' : '');
  }
  if (!tem) return;

  const el = $('dominio');
  const assinatura = lista.map((d) => `${d.i}:${d.nome}`).join('|');
  if (!domMontado || el.dataset.sig !== assinatura) {
    el.innerHTML = '';
    for (const d of lista) {
      const o = document.createElement('option');
      o.value = String(d.i);
      // Plano que o modulo nao casa continua VISIVEL, e marcado. Esconder
      // faria a lista mentir sobre o que o firmware sabe fazer; deixar sem
      // marca faria o operador escolher e culpar o alcance.
      o.textContent = `${d.nome} · ${d.mhz} MHz · ${d.ch} canais`
        + (d.ok === false ? '  — fora da faixa do módulo' : '');
      if (d.ok === false) o.dataset.fora = '1';
      el.appendChild(o);
    }
    el.dataset.sig = assinatura;
    if (!domMontado) {
      el.addEventListener('change', async () => {
        const opt = el.options[el.selectedIndex];
        const nome = opt.textContent;
        if (opt.dataset.fora) {
          log('err', `${nome} — o rádio sintoniza, mas a antena do módulo não casa aí`);
        }
        try {
          await api('api/config', { domain: el.value });
          log('sys', `plano: ${nome} — placa reiniciando, a OUTRA ponta precisa do mesmo`);
        } catch (e) {
          log('err', `falha ao mudar o plano: ${e.message}`);
        }
      });
      domMontado = true;
    }
  }
  if (document.activeElement !== el && s.domain !== undefined) el.value = String(s.domain);
}

function renderTaxas(s) {
  // So as taxas da banda em uso. Misturar as duas bandas numa lista so foi o
  // que tornou o controle confuso: a taxa carrega a banda junto, e ver "2,4
  // GHz 500 Hz" numa placa operando em 433 convida ao clique errado.
  const lista = Array.isArray(s.rates) ? s.rates.filter((r) => r.b === s.band) : [];
  // Aparece nos DOIS. No receptor a taxa grava como taxa INICIAL de busca --
  // por onde ele comeca a procurar o transmissor dentro da banda escolhida.
  const cx = $('secTaxa');
  if (cx) cx.hidden = lista.length < 2;
  if (lista.length < 2) return;
  const el = $('taxa');
  // A nota muda com o papel: no receptor a taxa e so o ponto de PARTIDA da
  // busca -- o SYNC a substitui assim que o par fecha.
  const nt = $('taxaNota');
  if (nt) {
    nt.textContent = (s.tlm !== undefined && s.tlm < 0)
      ? 'Por qual taxa este receptor começa a procurar o transmissor, dentro da banda escolhida. Com o par fechado, quem manda é a taxa que vem no pacote de sincronismo.'
      : 'No ExpressLRS a banda não é um ajuste separado: cada taxa já nasce numa banda. Trocar aqui troca as duas — e as DUAS pontas precisam da mesma.';
  }

  const rotulo = (r) => `${r.hz} Hz${r.c8 ? ' · 8 canais' : ''}`;

  const assinatura = lista.map((r) => `${r.i}:${r.b}:${r.hz}`).join('|');
  if (!taxaMontada || el.dataset.sig !== assinatura) {
    el.innerHTML = '';
    for (const r of lista) {
      const o = document.createElement('option');
      o.value = String(r.i);
      o.textContent = rotulo(r);
      el.appendChild(o);
    }
    el.dataset.sig = assinatura;
    if (!taxaMontada) {
      el.addEventListener('change', async () => {
        const nome = el.options[el.selectedIndex].textContent;
        try {
          const st = await api('api/config', { rate: el.value });
          render(st, true);
          log('sys', `taxa: ${nome} — a OUTRA ponta precisa da mesma`);
        } catch (e) {
          log('err', `falha ao mudar a taxa: ${e.message}`);
        }
      });
      taxaMontada = true;
    }
  }
  if (document.activeElement !== el && s.rate !== undefined) el.value = String(s.rate);
}

/* Potencia. A lista vem do firmware com o dBm MEDIDO de cada nivel -- os
   valores do datasheet do modulo, nao o rotulo do nivel do ExpressLRS. */
let potMontada = false;

function renderPotencias(s) {
  // SEMPRE seletor, nunca campo livre.
  //
  // O campo numerico aceitava 63 dBm numa banda que vai ate 12: o firmware
  // limita depois, mas a tela convidava ao erro e nao dizia qual era o teto
  // senao numa dica ao lado. Agora as opcoes SAO a faixa -- e a faixa vem do
  // firmware (`pmin`/`pmax`), que a calcula pelo caminho de RF em uso: acima
  // de 1 GHz o LR2021 troca para o PA de -19 a +12 dBm, abaixo dele vai a +22.
  // Trocar de banda troca a lista.
  //
  // Duas origens, uma so aparencia: quando o firmware reporta degraus
  // discretos (`powers`, caso do receptor ExpressLRS) o valor enviado e o
  // INDICE do degrau; no firmware de bancada e o dBm direto. O `data-modo`
  // guarda qual dos dois esta na tela.
  const degraus = Array.isArray(s.powers) && s.powers.length > 0;
  const cx = $('fPowerSel');
  if (cx) cx.hidden = false;
  const antigo = $('fPower');
  if (antigo) antigo.hidden = true;

  const el = $('powerSel');
  const pmin = Number.isFinite(s.pmin) ? s.pmin : -19;
  const pmax = Number.isFinite(s.pmax) ? s.pmax : 12;

  const lista = degraus
    ? s.powers.map((x) => ({ v: String(x.i), t: `${x.dbm} dBm` }))
    : (() => {
        const out = [];
        for (let d = Math.round(pmax); d >= Math.round(pmin); d--) {
          out.push({ v: String(d), t: `${d} dBm` });
        }
        return out;
      })();

  const assinatura = (degraus ? 'i|' : 'd|') + lista.map((x) => x.v).join(',');
  if (!potMontada || el.dataset.sig !== assinatura) {
    el.innerHTML = '';
    for (const x of lista) {
      const o = document.createElement('option');
      o.value = x.v;
      o.textContent = x.t;
      el.appendChild(o);
    }
    el.dataset.sig = assinatura;
    el.dataset.modo = degraus ? 'indice' : 'dbm';
    if (!potMontada) {
      el.addEventListener('change', async () => {
        const arg = el.dataset.modo === 'indice' ? { pwr: el.value }
                                                 : { power: el.value };
        try {
          const st = await api('api/config', arg);
          render(st, true);
          log('sys', `potencia: ${el.options[el.selectedIndex].textContent}`);
        } catch (e) {
          log('err', `falha ao mudar a potencia: ${e.message}`);
        }
      });
      potMontada = true;
    }
  }
  // Casa pelo dBm em uso, que e o que o firmware reporta.
  if (document.activeElement !== el) {
    if (degraus) {
      const atual = s.powers.find((x) => Math.abs(x.dbm - s.power) < 0.05);
      if (atual) el.value = String(atual.i);
    } else if (s.power !== undefined) {
      el.value = String(Math.round(s.power));
    }
  }
}

function renderTlm(s) {
  // tlm === -1 e o receptor: ele NAO tem razao configurada, obedece ao que vem
  // no pacote de SYNC. Mostrar um seletor la seria um controle que nao controla
  // nada -- fica so o estado, que ainda assim vale muito: e a prova, medida na
  // outra ponta, de que o transmissor mandou telemetria ligar.
  const tem = s.tlm !== undefined && s.tlm !== null;
  $('secTlm').hidden = !tem;
  if (!tem) return;

  const el = $('tlm');
  const configuravel = s.tlm >= 0;
  // Esconder so o <select> deixava o .field vazio ocupando espaco, com um vao
  // entre o titulo e a linha "em uso".
  if ($('fTlm')) $('fTlm').hidden = !configuravel;
  const notaTlm = $('tlmNota');
  if (notaTlm) {
    notaTlm.textContent = configuravel
      ? 'Sem telemetria o transmissor não sabe o que a outra ponta ouve — RSSI, SNR e LQ ficam sem leitura no painel dele. Razões mais frequentes devolvem os números mais rápido e ocupam mais ar.'
      : 'A razão é decidida pelo transmissor e chega aqui no pacote de sincronismo. Este painel mostra qual está valendo.';
  }

  // O denominador efetivo: 1 significa "um pacote de subida para cada um", ou
  // seja, nenhuma janela de volta -- telemetria desligada.
  const d = s.tlmDenom;
  const efetiva = !(d > 1) ? 'desligada'
    : '1:' + d + (configuravel && s.tlm === 0 ? '  (padrao desta taxa)' : '');
  $('tlmEf').textContent = d === undefined ? '--' : efetiva;

  if (!configuravel) return;

  if (!tlmMontado) {
    el.innerHTML = '';
    for (const [v, nome] of TLM_OPCOES) {
      const o = document.createElement('option');
      o.value = String(v);
      o.textContent = nome;
      el.appendChild(o);
    }
    el.addEventListener('change', async () => {
      try {
        const st = await api('api/config', { tlm: el.value });
        render(st, true);
        log('sys', 'telemetria: ' + el.options[el.selectedIndex].textContent);
      } catch (e) {
        log('err', 'falha ao mudar telemetria: ' + e.message);
      }
    });
    tlmMontado = true;
  }
  // So escreve quando NAO esta com foco: sobrescrever a escolha do usuario
  // enquanto ele mexe no seletor e a forma mais rapida de tornar um controle
  // impossivel de usar.
  if (document.activeElement !== el) el.value = String(s.tlm);
}

let truncAvisado = false;

function render(s, force = false) {
  // O firmware avisa quando o estado nao coube inteiro. Sem esse aviso, um
  // campo ausente e indistinguivel de um campo sem leitura.
  if (s.trunc && !truncAvisado) {
    truncAvisado = true;
    log('err', 'estado truncado pelo firmware — campos podem estar faltando');
  }

  ajustarSecoes(s);
  renderBanda(s);
  renderDominios(s);
  renderTaxas(s);
  renderPotencias(s);
  renderTlm(s);
  document.documentElement.dataset.band = s.band;

  $('node').textContent = s.node;

  const link = $('link');
  link.dataset.state = s.linked ? 'on' : 'off';
  $('linkTxt').textContent = s.linked ? 'ATIVO' : 'AUSENTE';

  // A condicao e a PRESENCA da leitura, nao a taxa de pacotes. Enquanto `rx`
  // significava "quadros recebidos" as duas coisas coincidiam; desde que passou
  // a reportar a cadencia CONFIGURADA, um transmissor sem telemetria entrava
  // aqui com s.rssi ausente e o render inteiro morria num TypeError -- o painel
  // congelava e o log so dizia "sem resposta do radio".
  // SNR SEPARADO do RSSI: um pode existir sem o outro.
  //
  // Estavam na mesma condicao, e no protocolo Alfa o chip nao entrega o RSSI
  // do pacote (ver LR2021Chip::packetStatus) -- o painel apagava tambem o SNR,
  // que estava valido e em 16 dB. Cada campo responde pela propria medida.
  $('snr').textContent = Number.isFinite(s.snr) ? s.snr.toFixed(1) : '––.–';

  if (Number.isFinite(s.rssi) && s.rssi < 0) {
    $('rssi').textContent = s.rssi.toFixed(1);
    if ($('rssiNote')) $('rssiNote').textContent = '';
    setMeter(s.rssi);
    history.push(s.rssi);
    while (history.length > HIST) history.shift();
    drawChart();
  } else {
    // Sem leitura o campo volta a traco. Deixar o ultimo numero na tela e o
    // mesmo erro de sempre: o painel passaria a mostrar um sinal que nao existe.
    $('rssi').textContent = '–––.–';
    // ...e diz POR QUE, quando o firmware sabe. Traco sozinho responde "nao
    // sei" a duas perguntas diferentes: nunca houve retorno, ou parou de haver.
    const nota = $('rssiNote');
    if (nota) {
      // tlmIdade so existe no transmissor. No receptor o motivo e mais direto:
      // ele mede o que recebe, e sem enlace nao recebe nada.
      if (s.tlmIdade !== undefined) {
        nota.textContent = s.tlmIdade < 0
          ? 'sem telemetria — nenhum pacote de volta desde que ligou'
          : `telemetria parou há ${(s.tlmIdade / 1000).toFixed(1)} s`;
      } else if (s.linked === false) {
        nota.textContent = 'sem enlace — nenhum quadro chegando';
      }
    }
  }

  renderGauges(s);

  $('toa').textContent = s.toa;
  readout($('tx'), s.tx);
  readout($('rx'), s.rx);
  readout($('err'), s.err);
  // vermelho só quando o erro é relevante — antes acendia em 1 pacote ruim e
  // virava o segundo elemento mais gritante da página
  $('err').classList.toggle('hot', s.err > 3 && s.err > (s.rx + s.err) * 0.05);
  // sem medida, esconde a unidade: "— ms" parecia campo quebrado
  readout($('rtt'), s.rtt > 0 ? s.rtt : '—');
  $('rtt').parentElement.classList.toggle('no-unit', !(s.rtt > 0));

  for (const b of $('bands').children) {
    b.setAttribute('aria-pressed', String(b.dataset.id === s.band));
  }
  const cur = (s.bands || BANDS).find((b) => b.id === s.band);
  if (cur) $('bandNote').textContent = cur.note;

  put($('match'), s.match);

  const protos = s.protoOpts || PROTOS;
  buildProto(protos);
  if (s.proto !== undefined) {
    put($('proto'), s.proto);
    // Sem descricao do protocolo aqui: o nome esta no seletor e a secao logo
    // abaixo repete o mesmo. A linha existe para o unico caso em que ha ESTADO
    // a dizer -- a escolha e o que esta no ar divergindo na janela do boot do
    // ESP-NOW, quando calar levaria a ler que a selecao nao foi salva.
    let nota = '';
    if (s.protoNoAr && s.protoNoAr !== s.proto) {
      const noAr = protos.find((x) => x.id === s.protoNoAr);
      const nome = noAr ? noAr.name : s.protoNoAr;
      nota = s.espnowEspera
        ? `Selecionado. No ar agora: ${nome} — sobe quando ninguem estiver conectado.`
        : `Selecionado. No ar agora: ${nome} — sobe em ${s.espnowEm ?? 0} s.`;
    }
    $('protoNote').textContent = nota;
  }

  if (s.alfa) {
    ULTIMO_ALFA = s.alfa;
    const a = s.alfa;
    if (a.ssid !== undefined && $('aSsid')) $('aSsid').textContent = a.ssid;
    if (a.papel !== undefined) {
      pintaPapelAlfa(a.papel === 'transmissor' ? 'tx' : 'rx');
      // O joystick simulado so existe no transmissor: no receptor ele nao tem o
      // que fazer, e um controle inerte parece defeito.
      const tx = a.papel === 'transmissor';
      const fv = $('fAVarre');
      if (fv) fv.hidden = !tx;
    }
    if (a.varredura !== undefined && $('aVarre') && document.activeElement !== $('aVarre')) {
      $('aVarre').checked = !!a.varredura;
    }
    // Os joysticks nao tem controle nesta coluna: quem os desenha e a aba
    // Mostradores, pelo campo `aj` do estado.
    // estadoTxt e ciente do papel: no canal padrao o transmissor nao escuta,
    // ele chama. Firmware antigo nao manda o campo -- cai no estado interno.
    const est = a.estadoTxt || a.estado;
    $('aEstado').textContent = a.vivo ? `${est} · enlace vivo` : est;
    $('aCanal').textContent = `${a.canal} · ${Number(a.freq).toFixed(3)} MHz`;
    // Nao sobrescreve o que esta sendo digitado: o campo e editavel, e o
    // estado chega a cada segundo. `sujo` marca o que o operador mexeu e
    // ainda nao gravou.
    poeHex($('aUid'), a.uid);
    poeHex($('aParId'), a.par);
    $('aCont').textContent =
      `rx ${a.rx} · CRC ruim ${a.crcRuim} · ID ruim ${a.idRuim} · ` +
      `quedas ${a.quedas} · silêncio ${a.silencio} ms`;
  }
  renderAlfaPorBle(s);
  renderEsp(s);

  const peers = s.peerOpts || PEERS;
  put($('peer'), s.peer || 'bancada');
  const pp = peers.find((x) => x.id === (s.peer || 'bancada'));
  if (pp) $('peerNote').textContent = pp.note;

  // A frase é um campo que o usuário digita: sobrescrevê-la a cada poll apagaria
  // o que ele está escrevendo. Só atualiza quando o campo não está sujo — mesma
  // regra dos outros campos editáveis.
  if (s.phrase !== undefined && !dirty.has('phrase')) $('phrase').value = s.phrase;
  if (s.uid !== undefined) {
    $('uid').textContent = s.uid;
    // Bit 0 do último byte do UID, igual ao ExpressLRS decide.
    const last = parseInt(s.uid.trim().split(/\s+/).pop(), 16);
    $('iq').textContent = Number.isNaN(last) ? '·' : (last & 1 ? 'invertido' : 'normal');
  }
  $('matchWarn').hidden = !s.mismatch;

  // radioOk pode faltar em firmware antigo: só esconde quando é explicitamente
  // false, pra não piscar um alarme falso
  const radioDown = s.radioOk === false;
  $('radioWarn').hidden = !radioDown;
  if (radioDown) $('radioErr').textContent = s.radioErr || 'motivo desconhecido';

  // No ExpressLRS o modem e LEITURA, nao ajuste -- e o botao Aplicar nem existe
  // do outro lado (a rota so aceita banda, taxa, potencia e telemetria).
  const elrs = String(s.node || '').indexOf('ELRS') === 0;
  arrumarColunas(elrs);
  document.body.dataset.fw = elrs ? 'elrs' : 'bancada';

  // No ExpressLRS o modem e LEITURA. Os campos de formulario somem inteiros --
  // desabilitados eles pareciam formulario quebrado, e um <select> sem a opcao
  // correspondente (bw/cr desconhecidos viram 0 no firmware) renderizava vazio.
  if ($('secModem')) $('secModem').hidden = elrs;
  if ($('specModem')) $('specModem').hidden = !elrs;
  if (elrs) {
    const num = (v, casas, uni) =>
      Number.isFinite(v) && v > 0 ? v.toFixed(casas) + (uni || '') : '·';
    $('mFreq').textContent = num(s.freq, 3, ' MHz');
    $('mSf').textContent = s.sf ? 'SF' + s.sf : '·';
    $('mBw').textContent = num(s.bw, 2, ' kHz');
    $('mCr').textContent = s.cr ? '4/' + s.cr : '·';
    $('mToa').textContent = num(s.toa, 1, ' ms');
  } else {
    put($('freq'), s.freq.toFixed(3));
    put($('power'), s.power);
    put($('sf'), s.sf);
    put($('cr'), s.cr);
    put($('bw'), s.bw);
  }
  // O gerador do teste de alcance: so existe com o par de bancada, que e o
  // unico que responde ao quadro de texto. Com ExpressLRS ou Alfa no ar nao ha
  // beacon nenhum para ligar, e a coluna ficava com dois controles inertes.
  const traf = $('secTrafego');
  if (traf) traf.hidden = !String(s.peer || '').startsWith('bancada');
  escondeColunaVazia('pCol3');
  put($('beacon'), s.beacon);
  put($('interval'), s.interval);
  put($('quiet'), s.quiet);
  // O bloco existe so onde ha rota que o atenda: o firmware do receptor
  // ExpressLRS nao publica `tlmper`, e controle que nao controla nada e pior
  // que controle ausente -- e a mesma regra que esconde mensagem e ping la.
  if ($('secTlmPer')) $('secTlmPer').hidden = s.tlmraz === undefined;
  buildTlmRaz();
  if (s.tlmraz !== undefined) put($('tlmRaz'), String(s.tlmraz));
  // Taxa EFETIVA, medida: a razao e em quadros, e quantos quadros por
  // segundo o enlace faz depende do protocolo e da taxa do radio. Sem esta
  // conta o operador escolhe 1:128 sem saber se isso e um segundo ou um
  // minuto.
  notaTlmRaz(s);

  // A procedencia dos numeros vive AQUI, nao no rotulo do controle: sao os dBm
  // que o datasheet do modulo atribui a cada degrau, nao uma medida do radio.
  $('powerHint').textContent = Array.isArray(s.powers) && s.powers.length
    ? `${s.powers.length} níveis · ${s.pmin} a ${s.pmax} dBm nesta banda, pelo datasheet do módulo`
    : `faixa permitida ${s.pmin} a ${s.pmax} dBm nesta banda`;

  if (Array.isArray(s.log)) {
    for (const e of s.log) {
      if (e.i > lastLog) { log(e.k, e.t); lastLog = e.i; }
    }
  }

  booted = true;
}

/* ────────────────────────────────────────────────────────────────── ações ── */

// `msg` saiu junto com o botao de enviar; a guarda evita que a proxima
// remocao derrube o painel inteiro no carregamento.
for (const id of ['freq', 'sf', 'cr', 'bw', 'interval', 'phrase']) {
  const el = $(id);
  if (el) el.addEventListener('input', () => dirty.add(id));
}

onEl('apply', 'click', async () => {
  try {
    // A potencia vem do SELETOR, e so quando ele fala em dBm: no modo de
    // degraus discretos o valor e um indice e nao cabe no campo `power`, que o
    // firmware le como dBm. Naquele modo o seletor ja aplicou sozinho.
    const sel = $('powerSel');
    const pot = sel && sel.dataset.modo !== 'indice' ? { power: sel.value } : {};
    const st = await api('api/config', {
      freq: $('freq').value,
      ...pot,
      sf: $('sf').value,
      cr: $('cr').value,
      bw: $('bw').value,
    });
    dirty.clear();
    render(st, true);
    log('sys', `${st.freq.toFixed(3)} MHz · SF${st.sf} · BW ${st.bw} kHz · CR 4/${st.cr} · ${st.power} dBm`);
  } catch (e) {
    log('err', `aplicar falhou: ${e.message}`);
  }
});

onEl('phraseSave', 'click', async () => {
  const phrase = $('phrase').value.trim();
  if (!phrase) { log('err', 'frase vazia'); return; }
  try {
    const st = await api('api/config', { phrase });
    dirty.delete('phrase');
    render(st, true);
    log('sys', `binding "${phrase}" · UID ${st.uid || '?'}`);
  } catch (e) {
    log('err', `frase recusada: ${e.message}`);
  }
});



onEl('beacon', 'change', async (ev) => {
  try {
    await api('api/config', { beacon: ev.target.checked ? '1' : '0' });
    log('sys', `beacon ${ev.target.checked ? 'ligado' : 'desligado'}`);
  } catch (e) {
    log('err', `beacon falhou: ${e.message}`);
  }
});

// --- telemetria --------------------------------------------------------------
onEl('quiet', 'change', async (ev) => {
  try {
    await api('api/config', { quiet: ev.target.checked ? '1' : '0' });
    log('sys', `modo silencioso ${ev.target.checked ? 'ligado' : 'desligado'}`);
  } catch (e) {
    log('err', `silencioso falhou: ${e.message}`);
  }
});


onEl('tlmagora', 'click', async () => {
  try {
    await api('api/config', { tlmagora: '1' });
    log('sys', 'telemetria: uma linha agora');
  } catch (e) {
    log('err', `leitura falhou: ${e.message}`);
  }
});

onEl('interval', 'change', async (ev) => {
  try {
    await api('api/config', { interval: ev.target.value });
    dirty.delete('interval');
    log('sys', `intervalo do beacon: ${ev.target.value} ms`);
  } catch (e) {
    log('err', `intervalo falhou: ${e.message}`);
  }
});

/* ─────────────────────────────────────────────────────────────────── loop ── */

let offline = false;

async function poll() {
  // Pela serial quem manda o render sao as linhas que chegam, nao o relogio:
  // pedir /api/state numa pagina servida do PC daria 404 a cada segundo e
  // encheria o registro de erro sobre um transporte que nao esta em uso.
  if (LINK.mode === 'serial') return;
  try {
    render(await api('api/state'));
    if (offline) { offline = false; log('sys', 'rádio respondendo de novo'); }
  } catch (e) {
    if (!offline) { offline = true; log('err', 'sem resposta do rádio'); }
  }
}

/* Tudo que é constante é montado ANTES de falar com o rádio: assim a página
   abre legível mesmo sem API (arquivo direto, Live Server, rádio fora do ar) e
   o polling só preenche valores. */
buildBands();
buildMatch();
buildPeers(PEERS);
buildProto(PROTOS);
buildPapelAlfa();
buildPapelEsp();
fillSelect($('sf'), SF);
fillSelect($('cr'), CR);
fillSelect($('bw'), BW);

drawChart();
poll();
setInterval(poll, 1000);

/* =============================================================================
   Aba "Banco de dados"

   Le o Supabase direto do navegador, por REST — sem biblioteca. O painel nao
   tem etapa de build (mora no LittleFS da placa), entao qualquer dependencia
   teria de ser um <script> de CDN que a placa nunca conseguiria servir.

   So funciona com o painel aberto NO PC. Pelo AP da placa nao ha internet, e a
   aba diz isso em vez de ficar girando.
   ========================================================================== */

const DB = {
  list: [],
  session: null,
  map: null,
  layer: null,
  leaflet: false,
};

const cfgOk = () => !!(window.SUPABASE && window.SUPABASE.url && window.SUPABASE.key);

/** GET no PostgREST. Erro vira excecao, e a aba mostra o motivo na nota. */
async function sb(path) {
  const r = await fetch(`${window.SUPABASE.url}/rest/v1/${path}`, {
    headers: {
      apikey: window.SUPABASE.key,
      Authorization: `Bearer ${window.SUPABASE.key}`,
    },
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

const fmtDist = (m) =>
  m == null ? '—' : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2).replace('.', ',')} km`;

/* Mesma escala de cor do app: -40 dBm colado, -120 no limite da sensibilidade.
   Repetida aqui de proposito — o painel nao compartilha codigo com o app, e um
   import forcaria uma etapa de build que este arquivo nao tem. */
function rssiColor(v) {
  if (v == null) return '#64748b';
  const k = (Math.max(-120, Math.min(-40, v)) + 120) / 80;
  return `hsl(${Math.round(k * 120)}, 85%, 45%)`;
}

/* Cores do mapa lidas da PALETA, nao fixas.
   O painel inteiro raciona o acento em torno de --glow, que muda com a banda.
   O mapa -- a maior area da aba -- estava em #137fec (azul Material) em nove
   lugares, mais as cores de sistema do iOS no rastro. Em 915 o painel ficava
   laranja e o mapa azul: parecia widget de terceiro embutido. Pior, o vermelho
   do iOS e vizinho do acento de 915, e o "sem enlace" deixava de gritar. */
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const ACENTO = () => cssVar('--glow') || '#6cf0a0';
const TRAIL_OK = () => cssVar('--glow') || '#6cf0a0';
const TRAIL_DOWN = () => cssVar('--bad') || '#ff4f70';
const SINAL_OK = () => cssVar('--ok') || '#22c55e';
/* Aneis e regua sao REFERENCIA, nao leitura: ficam em cinza de instrumento
   para nao competir com o rastro, que e o dado. */
const REGUA = '#9aaaa3';

/** Carrega o Leaflet so quando a aba abre: na placa ele nunca seria baixado. */
function loadLeaflet() {
  if (DB.leaflet) return Promise.resolve(true);
  return new Promise((resolve) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    js.onload = () => { DB.leaflet = true; resolve(true); };
    js.onerror = () => resolve(false);
    document.head.appendChild(js);
  });
}

function dbNote(text) { $('dbNote').textContent = text; }

async function dbLoadList() {
  if (!cfgOk()) {
    // O formulario ja esta na tela; a nota so diz por que a lista esta vazia.
    dbNote('Informe o projeto Supabase acima para ver as campanhas.');
    return;
  }
  dbNote('Lendo o banco…');
  try {
    DB.list = await sb(
      'range_session_summary?select=id,local_id,name,created_at,band,samples,' +
      'max_distance_m,best_rssi_dbm,worst_rssi_dbm&order=created_at.desc',
    );
    renderDbList();
    dbNote(DB.list.length ? `${DB.list.length} campanha(s) no banco.` : 'Nenhuma campanha no banco.');
  } catch (e) {
    dbNote(`Falha ao ler: ${e.message}`);
  }
}

function renderDbList() {
  const box = $('dbList');
  box.innerHTML = '';
  for (const r of DB.list) {
    const li = document.createElement('li');
    li.className = 'db__item';
    // Era um <li> com onclick: sem tabindex, sem role, invisivel ao teclado --
    // e a aba inteira depende dele para abrir qualquer coisa.
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.dataset.id = r.id;
    if (!r.samples) li.dataset.empty = '1';

    // textContent, e nao innerHTML: o nome da campanha e digitado pelo usuario
    // no celular e chega aqui sem passar por validacao nenhuma.
    const b = document.createElement('b');
    b.textContent = r.name || 'sem nome';
    const d = document.createElement('span');
    d.textContent = `${new Date(r.created_at).toLocaleString('pt-BR')} · ${r.band || '—'}`;
    const p = document.createElement('span');
    p.textContent = `${r.samples} pontos · ${fmtDist(r.max_distance_m)}`;

    const del = document.createElement('button');
    del.className = 'db__del';
    del.type = 'button';
    del.textContent = 'apagar da nuvem';
    // stopPropagation: o item inteiro abre a campanha ao ser clicado, e sem
    // isto apagar abriria o que se acabou de apagar.
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void dbDelete(r);
    });

    li.append(b, d, p, del);

    if (r.samples) {
      const abrir = () => dbOpen(r);
      li.addEventListener('click', abrir);
      // role="button" sem teclado e so aparencia de acessivel.
      li.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); abrir(); }
      });
    }
    box.appendChild(li);
  }
}

/**
 * Apaga a campanha do banco.
 *
 * A confirmacao NOMEIA a campanha e diz quantos pontos vao junto. Um "tem
 * certeza?" generico e ruido que se aprende a clicar sem ler, e aqui nao ha
 * desfazer: a nuvem costuma ser a ultima copia de uma campanha ja apagada do
 * celular.
 */
async function dbDelete(item) {
  const msg =
    `Apagar "${item.name}" do banco?` +
    String.fromCharCode(10, 10) +
    `${item.samples} pontos serao removidos junto. Nao ha como desfazer.`;
  if (!window.confirm(msg)) return;

  dbNote(`Apagando "${item.name}"…`);
  try {
    // return=representation faz o PostgREST devolver o que apagou. Sem isso,
    // e sem a politica de DELETE no banco, a resposta seria 200 com zero linhas
    // e o painel diria "apagado" sem ter apagado nada.
    const r = await fetch(
      `${window.SUPABASE.url}/rest/v1/range_sessions?id=eq.${item.id}`,
      {
        method: 'DELETE',
        headers: {
          apikey: window.SUPABASE.key,
          Authorization: `Bearer ${window.SUPABASE.key}`,
          Prefer: 'return=representation',
        },
      },
    );
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const gone = await r.json();
    if (!gone.length) {
      const msg =
        'NADA FOI APAGADO.' +
        String.fromCharCode(10, 10) +
        'O banco recusa DELETE: falta a politica de RLS. Rode ' +
        'alcance_lora/migration-delete.sql no SQL Editor do Supabase.';
      // alert, e nao so a nota do topo: o botao fica no fim de uma lista longa,
      // e uma mensagem a 600 px de distancia do clique nao e lida. Acao
      // destrutiva que falhou tem de interromper.
      window.alert(msg);
      dbNote('Nada foi apagado — o banco nao permite DELETE (ver migration-delete.sql).');
      return;
    }

    DB.list = DB.list.filter((x) => x.id !== item.id);
    renderDbList();
    if (DB.session && DB.session.item.id === item.id) {
      DB.session = null;
      $('dbStats').hidden = true;
      $('dbRows').innerHTML = '';
      if (DB.layer) DB.layer.clearLayers();
    }
    dbNote(`"${item.name}" apagada. ${DB.list.length} campanha(s) restantes.`);
  } catch (e) {
    dbNote(`Falha ao apagar: ${e.message}`);
  }
}

async function dbOpen(item) {
  for (const el of $('dbList').children) {
    el.setAttribute('aria-current', String(el.dataset.id === item.id));
  }
  dbNote(`Baixando "${item.name}" — ${item.samples} pontos…`);

  try {
    // Paginado: o PostgREST corta em 1000 linhas sem avisar, e um trajeto
    // truncado ainda parece um trajeto — ninguem desconfiaria.
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const page = await sb(
        'range_samples?select=t,latitude,longitude,altitude,accuracy_m,distance_m,' +
        `rssi_dbm,snr_db,lq,linked&session_id=eq.${item.id}&order=t.asc&offset=${from}&limit=1000`,
      );
      rows.push(...page);
      if (page.length < 1000) break;
    }
    const head = await sb(`range_sessions?select=origin_lat,origin_lon&id=eq.${item.id}`);

    // "Sem sinal" e decidido AQUI, na busca, e nao em cada desenho: o mapa, a
    // tabela e os numeros passam a contar a mesma coisa, e quem ler o codigo
    // acha a regra num lugar so.
    //
    // Duas evidencias, e qualquer uma basta:
    //   `linked` falso  o firmware nao considerava o enlace vivo naquele
    //                   instante -- e o `link=` da linha $T.
    //   sem RSSI        nulo, ou o ZERO que o $T emite quando nao ha medida
    //                   (ver textoRssi() no firmware). Zero dBm nao acontece
    //                   num teste de alcance; -200 ou menos tambem e "nada".
    for (const r of rows) {
      const v = r.rssi_dbm == null ? null : Number(r.rssi_dbm);
      r.semSinal = !r.linked || v === null || v === 0 || v <= -200;
    }

    DB.session = { item, rows, origin: head[0] || null };

    renderDbStats();
    renderDbRows();
    await renderDbMap();
    dbNote(`"${item.name}" — ${rows.length} pontos.`);
  } catch (e) {
    dbNote(`Falha ao baixar: ${e.message}`);
  }
}

function renderDbStats() {
  const rows = DB.session.rows;
  const linked = rows.filter((r) => r.linked && r.distance_m != null);
  const rssi = rows.map((r) => r.rssi_dbm).filter((v) => v != null);
  const lost = rows.filter((r) => r.semSinal).length;
  const noRssi = rows.length - rssi.length;

  $('dbStats').hidden = false;
  $('dbPts').textContent = rows.length;
  // O alcance que interessa e o ponto mais longe COM enlace. O mais longe da
  // trilha pode ser onde o sinal ja tinha caido e o operador seguiu andando.
  $('dbReach').textContent = fmtDist(
    linked.length ? Math.max(...linked.map((r) => r.distance_m)) : null,
  );
  $('dbLost').textContent = lost;
  $('dbLost').className = lost ? 'bad' : '';
  $('dbBest').textContent = rssi.length ? Math.max(...rssi) : '—';
  $('dbWorst').textContent = rssi.length ? Math.min(...rssi) : '—';
  // Ponto sem RSSI chegou com a telemetria quebrada. Sem este numero, melhor e
  // pior seriam lidos como se cobrissem todos os pontos.
  $('dbNoRssi').textContent = noRssi;
  $('dbNoRssi').className = noRssi ? 'warn' : '';
}

function renderDbRows() {
  const tb = $('dbRows');
  tb.innerHTML = '';
  for (const r of DB.session.rows) {
    const tr = document.createElement('tr');

    const plain = [
      new Date(r.t).toLocaleTimeString('pt-BR'),
      Number(r.latitude).toFixed(6),
      Number(r.longitude).toFixed(6),
      r.altitude == null ? '—' : Math.round(r.altitude),
      r.accuracy_m == null ? '—' : Math.round(r.accuracy_m),
      fmtDist(r.distance_m),
    ];
    for (const c of plain) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.appendChild(td);
    }

    const rs = document.createElement('td');
    rs.textContent = r.rssi_dbm == null ? '—' : r.rssi_dbm;
    rs.style.color = rssiColor(r.rssi_dbm);
    tr.appendChild(rs);

    for (const c of [r.snr_db == null ? '—' : r.snr_db, r.lq == null ? '—' : r.lq]) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.appendChild(td);
    }

    const lk = document.createElement('td');
    const dot = document.createElement('span');
    dot.className = 'db__dot';
    dot.style.background = r.linked ? TRAIL_OK : TRAIL_DOWN;
    lk.appendChild(dot);
    tr.appendChild(lk);

    tb.appendChild(tr);
  }
}

async function renderDbMap() {
  const ok = await loadLeaflet();
  if (!ok) {
    $('dbMap').textContent = 'Mapa indisponivel — sem internet para carregar o Leaflet.';
    return;
  }

  if (!DB.map) {
    DB.map = L.map($('dbMap'), { zoomControl: true }).setView([0, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
    }).addTo(DB.map);
    DB.layer = L.layerGroup().addTo(DB.map);

    // Barra de escala: da a ordem de grandeza sem exigir clique nenhum.
    L.control.scale({ metric: true, imperial: false, maxWidth: 160 }).addTo(DB.map);
    montarRegua(DB.map);

    // O botao de tela cheia entra como CONTROLE do Leaflet, e nao como div
    // absoluto: quem decide a posicao passa a ser o canto, entao um controle
    // novo se empilha em vez de sobrepor.
    const Cheia = L.Control.extend({
      options: { position: 'topright' },
      onAdd() {
        const b = $('dbFull');
        b.classList.add('leaflet-control');
        L.DomEvent.disableClickPropagation(b);
        return b;
      },
    });
    DB.map.addControl(new Cheia());
  }
  DB.layer.clearLayers();
  DB.map.invalidateSize();

  const rows = DB.session.rows;
  if (!rows.length) return;

  const o = DB.session.origin;
  const hasOrigin = o && o.origin_lat != null && o.origin_lon != null;
  if (hasOrigin) {
    L.circleMarker([o.origin_lat, o.origin_lon], {
      radius: 9, color: '#ffffff', weight: 2, fillColor: ACENTO(), fillOpacity: 1,
    }).bindPopup('<b>Transmissor</b>').addTo(DB.layer);

    // Aneis de referencia: dao escala ao mapa sem precisar medir nada.
    for (const rad of [250, 500, 1000, 2000]) {
      L.circle([o.origin_lat, o.origin_lon], {
        radius: rad, color: REGUA, weight: 1, opacity: .35, fill: false, dashArray: '4 6',
      }).addTo(DB.layer);
    }
  }

  // Rastro em trechos, verde onde havia enlace e vermelho tracejado onde nao —
  // a mesma leitura do app. Trechos de mesma cor viram uma polilinha so, senao
  // uma campanha longa criaria centenas de camadas e o mapa engasgaria.
  let run = [];
  let runOk = null;
  const flush = () => {
    if (run.length > 1 && runOk !== null) {
      L.polyline(run, {
        color: runOk ? TRAIL_OK() : TRAIL_DOWN(),
        weight: 4,
        opacity: .85,
        dashArray: runOk ? undefined : '6 6',
      }).addTo(DB.layer);
    }
  };
  for (let i = 1; i < rows.length; i++) {
    // O trecho so e verde se havia enlace nas DUAS pontas: meio caminho sem
    // link nao e meio verde, e perda.
    const segOk = !rows[i - 1].semSinal && !rows[i].semSinal;
    if (segOk !== runOk) {
      flush();
      run = [[rows[i - 1].latitude, rows[i - 1].longitude]];
      runOk = segOk;
    }
    run.push([rows[i].latitude, rows[i].longitude]);
  }
  flush();

  // Pontos: VERDE onde havia sinal, VERMELHO onde nao havia. Binario de
  // proposito -- e a leitura que se quer num relance, olhando a caminhada. O
  // preenchimento era um degrade de RSSI e o estado ia so na borda: com o
  // enlace inteiro de pe tudo saia verde-amarelado, e o ponto sem sinal se
  // perdia. O RSSI continua no popup.
  //
  // Em DUAS passadas, os sem sinal por ultimo: pontos proximos se sobrepoem,
  // e o vermelho e justamente o que se procura -- nao pode ficar por baixo.
  const semSinalPorCima = [...rows.filter((r) => !r.semSinal), ...rows.filter((r) => r.semSinal)];
  for (const r of semSinalPorCima) {
    L.circleMarker([r.latitude, r.longitude], {
      radius: 5,
      color: '#ffffff',
      weight: 1.5,
      fillColor: r.semSinal ? TRAIL_DOWN() : SINAL_OK(),
      fillOpacity: 1,
    })
      .bindPopup(
        `<b>${r.rssi_dbm == null ? '—' : r.rssi_dbm} dBm</b><br>` +
        `SNR ${r.snr_db == null ? '—' : r.snr_db} dB<br>` +
        `dist ${fmtDist(r.distance_m)}<br>` +
        `${new Date(r.t).toLocaleTimeString('pt-BR')}` +
        (r.semSinal ? `<br><b style="color:${TRAIL_DOWN()}">sem sinal</b>` : ''),
      )
      .addTo(DB.layer);
  }

  const pts = rows.map((r) => [r.latitude, r.longitude]);
  if (hasOrigin) pts.push([o.origin_lat, o.origin_lon]);
  DB.map.fitBounds(L.latLngBounds(pts).pad(0.15));
}

/* Regua: distancia entre dois pontos quaisquer do mapa.
   Os aneis de referencia so existem quando a campanha tem origem gravada, e a
   distancia por ponto e sempre ATE O TRANSMISSOR. Nenhuma das duas responde
   "quanto ha entre estes dois lugares" -- que numa campanha de alcance e a
   pergunta de sempre: entre o ultimo ponto com enlace e o primeiro sem ele. */
function montarRegua(map) {
  let ativa = false;
  let a = null;
  const camada = L.layerGroup().addTo(map);
  let linhaViva = null;
  let etiqueta = null;
  let botao = null;

  const etiquetaEm = (ll, texto, forte) => L.marker(ll, {
    icon: L.divIcon({
      className: '',
      html: `<b style="background:${forte ? ACENTO() : REGUA};color:#0b0f0e;` +
            `padding:3px 8px;border-radius:3px;font:600 12px/1 system-ui;` +
            `white-space:nowrap">${texto}</b>`,
      iconAnchor: [-10, 8],
    }),
    interactive: false,
  });

  const dica = (txt) => {
    const el = $('dbMapDica');
    if (el) { el.textContent = txt || ''; el.hidden = !txt; }
  };

  const desliga = () => {
    ativa = false;
    a = null;
    camada.clearLayers();
    linhaViva = etiqueta = null;
    if (botao) { botao.style.background = ''; botao.style.color = ''; }
    map.getContainer().style.cursor = '';
    dica('');
  };

  const Botao = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
      botao = L.DomUtil.create('a', '', div);
      botao.href = '#';
      botao.title = 'Medir a distância entre dois pontos';
      // Rotulo por extenso: um simbolo sozinho na barra nao se acha, e a
      // ferramenta so serve se alguem souber que ela existe.
      botao.textContent = 'Medir';
      botao.style.cssText = 'font:600 12px/26px system-ui;text-align:center;' +
                            'width:auto;padding:0 10px;letter-spacing:.04em';
      L.DomEvent.on(botao, 'click', (e) => {
        L.DomEvent.stop(e);
        if (ativa) { desliga(); return; }
        ativa = true;
        a = null;
        camada.clearLayers();
        botao.style.background = ACENTO();
        botao.style.color = '#0b0f0e';
        map.getContainer().style.cursor = 'crosshair';
        dica('Clique no primeiro ponto');
      });
      return div;
    },
  });
  map.addControl(new Botao());

  // Enquanto arrasta o mouse depois do primeiro clique, a distancia acompanha.
  // Sem isso a regua so responde no fim, e nao da para "procurar" um valor.
  map.on('mousemove', (ev) => {
    if (!ativa || !a) return;
    const m = map.distance(a, ev.latlng);
    if (linhaViva) linhaViva.setLatLngs([a, ev.latlng]);
    else linhaViva = L.polyline([a, ev.latlng], {
      color: REGUA, weight: 2, opacity: .7, dashArray: '6 6',
    }).addTo(camada);
    if (etiqueta) camada.removeLayer(etiqueta);
    etiqueta = etiquetaEm(ev.latlng, fmtDist(m), false).addTo(camada);
  });

  map.on('click', (ev) => {
    if (!ativa) return;
    if (a) {
      // map.distance devolve metros sobre o elipsoide -- distancia no chao,
      // nao na tela: vale em qualquer zoom e em qualquer latitude.
      const m = map.distance(a, ev.latlng);
      camada.clearLayers();
      linhaViva = etiqueta = null;
      L.polyline([a, ev.latlng], { color: ACENTO(), weight: 3 }).addTo(camada);
      for (const ll of [a, ev.latlng]) {
        L.circleMarker(ll, {
          radius: 5, color: '#fff', weight: 2, fillColor: ACENTO(), fillOpacity: 1,
        }).addTo(camada);
      }
      etiquetaEm(ev.latlng, fmtDist(m), true).addTo(camada);
      a = null;
      dica('Clique para medir de novo, ou toque em Medir para sair');
    } else {
      camada.clearLayers();
      linhaViva = etiqueta = null;
      a = ev.latlng;
      L.circleMarker(a, {
        radius: 5, color: '#fff', weight: 2, fillColor: ACENTO(), fillOpacity: 1,
      }).addTo(camada);
      dica('Clique no segundo ponto');
    }
  });

  // Sair da campanha nao pode deixar a regua armada por baixo.
  map.on('unload', desliga);
}

/* --- troca de aba ---------------------------------------------------------
   O polling do radio continua rodando nas duas: sair da aba nao e sair da
   bancada, e o registro tem de estar completo quando se voltar. */
function showTab(which) {
  const db = which === 'db';
  const g = which === 'gauges';
  // Sair da aba com o mapa expandido deixaria um mapa fixed cobrindo a
  // bancada, sem nada visível para fechá-lo.
  if (!db && typeof mapIsFull === 'function' && mapIsFull()) setMapFull(false);
  $('tabBench').setAttribute('aria-selected', String(!db && !g));
  $('tabGauges').setAttribute('aria-selected', String(g));
  $('tabDb').setAttribute('aria-selected', String(db));
  $('viewBench').hidden = db || g;
  $('viewGauges').hidden = !g;
  $('viewDb').hidden = !db;

  setRcFast(g);

  if (db) {
    // Pede a credencial ASSIM QUE A ABA ABRE, e não quando alguma consulta
    // falha: descobrir que falta configuração depois de clicar em algo é o
    // caminho mais longo para a mesma informação.
    if (!cfgOk()) dbNote('Informe o projeto Supabase para ver as campanhas.');
    else if (!DB.list.length) void dbLoadList();
  }
  // O Leaflet mede o container na criacao; criado escondido, mede zero e o mapa
  // fica cinza pela metade. Remedir ao mostrar a aba e obrigatorio.
  if (db && DB.map) setTimeout(() => DB.map.invalidateSize(), 60);
}

/* --- joysticks em tempo real ------------------------------------------------
   O /api/state e pesado e vem a 1 Hz -- suficiente para banda, contadores e
   grafico, e visivelmente lento para um joystick que se move a 50 Hz.

   Entao a aba de mostradores busca /api/rc, que traz so os 16 canais e o
   enlace (~110 bytes), a 20 Hz. Nao substitui o polling normal: ele continua
   cuidando de todo o resto, e este aqui so mexe nas barras. */
let rcTimer = null;
let rcBusy = false;

async function pollRc() {
  // Sem sobreposicao: numa rede ruim uma resposta atrasada seria alcancada
  // pela seguinte e as barras andariam para tras.
  if (rcBusy || LINK.mode !== 'http') return;
  rcBusy = true;
  try {
    const r = await fetch('api/rc', { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      if (Array.isArray(d.aj)) {
        renderSticks({ aj: d.aj, asw: d.asw, rapido: true, alfa: ULTIMO_ALFA });
      } else {
        renderSticks({ rc: d.rc.slice(0, 4), rcAll: d.rc, rcMax: 2047,
                       rcN: 0, rcAge: 0, rcSw: 0 });
      }
    }
  } catch (e) {
    /* uma falha isolada nao merece ruido: o polling normal ja acusa queda */
  } finally {
    rcBusy = false;
  }
}

/* Cadencia da enquete de canais.
   50 ms sao VINTE requisicoes por segundo. Pela serial isso e local e barato;
   pelo WiFi vai tudo para um ESP32 que ao mesmo tempo roda o radio -- e como a
   aba Mostradores comeca a enquete assim que abre, ela disputava banda com o
   proprio carregamento da pagina. Resultado observado: o navegador desistia do
   style.css e o painel aparecia sem estilo nenhum, com o resto funcionando.
   Pela rede, 10 Hz: mais que suficiente para acompanhar joystick, metade do peso. */
const RC_MS = () => (LINK.mode === 'http' ? 100 : 50);

function setRcFast(on) {
  if (on && !rcTimer) {
    // Espera a pagina TERMINAR de carregar antes de comecar a pedir. Enquanto
    // ha folha de estilo e script em voo, a enquete e o que os atropela.
    const armar = () => { if (!rcTimer) rcTimer = setInterval(pollRc, RC_MS()); };
    if (document.readyState === 'complete') armar();
    else window.addEventListener('load', armar, { once: true });
  } else if (!on && rcTimer) {
    clearInterval(rcTimer);
    rcTimer = null;
  }
}

onEl('tabBench', 'click', () => showTab('bench'));
onEl('tabGauges', 'click', () => showTab('gauges'));
onEl('emerg', 'click', mandaEmergAlfa);
onEl('simJoy', 'click', mandaSimJoy);
onEl('aUidGrava', 'click', () => void gravaId('aUid', 'auid'));
onEl('aParGrava', 'click', () => void gravaId('aParId', 'apar'));
for (const id of ['aUid', 'aParId']) {
  onEl(id, 'input', () => {
    const el = $(id);
    if (el) el.dataset.sujo = '1';
  });
}
onEl('tabDb', 'click', () => showTab('db'));
onEl('dbReload', 'click', () => { DB.list = []; void dbLoadList(); });

/* --- mapa em tela cheia ----------------------------------------------------
   O mapa útil de uma campanha é o grande: numa caixa de 300 px, um trajeto de
   quilômetros vira um risco. Aqui o invólucro passa a `fixed` cobrindo a
   página, e o mesmo elemento do Leaflet continua no lugar — nada é recriado,
   então o enquadramento e os tiles já carregados sobrevivem à troca. */
function setMapFull(on) {
  const wrap = $('dbMapWrap');
  wrap.classList.toggle('db__mapwrap--full', on);
  $('dbFull').textContent = on ? '← voltar' : '⤢ tela cheia';

  // Trava a rolagem do fundo: sem isso o gesto de arrastar o mapa rolava a
  // página junto, e o mapa "escapava" enquanto se tentava mover nele.
  document.documentElement.classList.toggle('mapfull', on);

  // invalidateSize é obrigatório: o Leaflet mede o container quando ele muda de
  // tamanho, não sozinho. Sem isto metade do mapa fica cinza, com tiles só na
  // faixa do tamanho antigo.
  if (DB.map) {
    DB.map.invalidateSize();
    setTimeout(() => DB.map.invalidateSize(), 80);
  }
}

const mapIsFull = () => $('dbMapWrap').classList.contains('db__mapwrap--full');

onEl('dbFull', 'click', () => setMapFull(!mapIsFull()));

// Esc fecha, que é o que todo mundo tenta antes de procurar o botão.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && mapIsFull()) setMapFull(false);
});

/* --- credenciais do banco --------------------------------------------------
   Pedidas ao abrir a aba, guardadas so no navegador.

   A pagina e publica no GitHub Pages: qualquer chave versionada junto ficaria
   publica tambem. E servida pelo ESP32 nao ha rota para o Supabase, entao o
   formulario tambem nao atrapalha ali — quem abrir pela placa simplesmente nao
   vai preencher.

   localStorage e por navegador e por origem. Nao viaja, nao sincroniza, e some
   com "limpar dados do site" — que e exatamente o comportamento esperado de uma
   credencial digitada numa pagina de terceiro. */
const SB_STORE = 'lora2021.supabase';

function sbLoad() {
  try {
    const raw = localStorage.getItem(SB_STORE);
    if (!raw) return null;
    const c = JSON.parse(raw);
    return c && c.url && c.key ? c : null;
  } catch {
    return null;
  }
}

function sbApply(cfg) {
  window.SUPABASE = cfg;
  const has = !!cfg;
  $('dbAuth').hidden = has;
  $('dbWho').hidden = !has;
  if (has) {
    // So o host, nunca a chave. Mostrar a credencial numa tela que alguem pode
    // estar projetando ou compartilhando nao ajuda em nada.
    $('dbHost').textContent = cfg.url.replace(/^https?:\/\//, '');
  }
}

onEl('sbSave', 'click', () => {
  const url = $('sbUrl').value.trim().replace(/\/+$/, '');
  const key = $('sbKey').value.trim();
  if (!/^https?:\/\/.+/.test(url) || key.length < 20) {
    dbNote('URL ou chave em branco / incompletas.');
    return;
  }
  const cfg = { url, key };
  try {
    localStorage.setItem(SB_STORE, JSON.stringify(cfg));
  } catch {
    // Navegacao privada pode recusar. Vale para esta sessao mesmo assim.
    dbNote('Nao consegui guardar — vai valer so ate fechar a aba.');
  }
  sbApply(cfg);
  $('sbKey').value = '';
  DB.list = [];
  void dbLoadList();
});

onEl('sbForget', 'click', () => {
  try {
    localStorage.removeItem(SB_STORE);
  } catch {
    /* nada a fazer */
  }
  sbApply(null);
  DB.list = [];
  DB.session = null;
  $('dbList').innerHTML = '';
  $('dbRows').innerHTML = '';
  $('dbStats').hidden = true;
  if (DB.layer) DB.layer.clearLayers();
  dbNote('Credenciais esquecidas neste navegador.');
});

// Restaura antes de qualquer troca de aba.
//
// O que foi DIGITADO no formulario tem precedencia sobre o arquivo local: quem
// trocou a credencial na tela esta corrigindo o arquivo, nao o contrario — e a
// ordem inversa faria "trocar" nunca pegar nesta maquina.
sbApply(sbLoad() || window.SUPABASE_LOCAL || null);

/* --- joysticks e chaves do ExpressLRS ----------------------------------------
   Os quatro canais vem no RCDATA em 10 bits (0..1023), na ordem AETR. A barra
   e proporcional ao valor cru: converter para a escala CRSF (172..1811) so
   acrescentaria uma conversao para desconverter na hora de desenhar.

   As chaves sao os 7 bits do byte 6 mais o bit alto, que carrega o AUX1.  */
const CH_NAMES = ['Aileron', 'Profundor', 'Motor', 'Leme'];

/* Desenha um joystick na escala do CENTRO: -100 % a +100 %, zero no meio.
   Vale para os tres dialetos -- o Alfa ja fala nessa escala, o CRSF vem em
   172..1811 com 992 no centro e o quadro cru em 0..1023 com 512. Convertidos,
   os tres cabem na mesma barra e o numero ao lado diz o mesmo que a barra. */
function pintaJoy(i, pct) {
  const v = Math.max(-100, Math.min(100, pct));
  const fill = $('ch' + i);
  const rot = $('chv' + i);
  if (fill) {
    // Metade do trilho para cada lado: 100 % de curso = 50 % de largura.
    fill.style.left = (v >= 0 ? 50 : 50 + v / 2).toFixed(2) + '%';
    fill.style.width = (Math.abs(v) / 2).toFixed(2) + '%';
  }
  if (rot) rot.textContent = (v > 0 ? '+' : '') + v.toFixed(0);
}

/* Quantos mostradores, e com que nome, depende do PROTOCOLO no ar.
   O ExpressLRS leva quatro joysticks e as chaves nos canais auxiliares; o Alfa
   leva SETE joysticks e 32 bits de chaves, dois bits por chave. Sao dois
   desenhos, e o display da placa ja faz essa distincao (tela.cpp). */
const ALFA_JOYS = 7;
const ALFA_CHAVES = 8;   // SA..SH, dois bits cada: bits 0..15 do quadro
const ALFA_NOMES = ['SA', 'SB', 'SC', 'SD', 'SE', 'SF', 'SG', 'SH'];
const ALFA_BIT_EMERG = 16;  // 1 = ARMADA (prot_alfa.h)

/* Ultimo bloco `alfa` visto no estado de 1 Hz.
   A enquete de canais roda a 10 Hz e traz so os valores; sem isto o comando
   dos joysticks piscaria a cada leitura rapida, por nao saber o papel. */
let ULTIMO_ALFA = null;

let sticksBuilt = '';

function buildSticks(dialeto) {
  if (sticksBuilt === dialeto) return;
  sticksBuilt = dialeto;
  const alfa = dialeto === 'alfa';
  const nJoy = alfa ? ALFA_JOYS : 4;
  const nSw = alfa ? ALFA_CHAVES : 8;
  const box = $('chans');
  box.innerHTML = '';
  for (let i = 0; i < nJoy; i++) {
    const row = document.createElement('div');
    row.className = 'chan';

    const lb = document.createElement('span');
    lb.className = 'chan__lb';
    lb.textContent = alfa ? 'J' + (i + 1) : CH_NAMES[i];

    const track = document.createElement('span');
    track.className = 'chan__track';
    const fill = document.createElement('span');
    fill.className = 'chan__fill';
    fill.id = 'ch' + i;
    fill.style.width = '50%';
    track.appendChild(fill);

    const v = document.createElement('span');
    v.className = 'chan__v';
    v.id = 'chv' + i;
    v.textContent = '––––';

    row.append(lb, track, v);
    box.appendChild(row);
  }

  const sw = $('switches');
  sw.innerHTML = '';
  for (let i = 0; i < nSw; i++) {
    const b = document.createElement('span');
    b.className = 'swx';   // .sw e o interruptor da bancada; ver style.css
    b.id = 'sw' + i;

    const lb = document.createElement('b');
    lb.textContent = alfa ? ALFA_NOMES[i] : 'AUX' + (i + 1);

    // Chave de tres posicoes desenhada como a do display (chaveTres, em
    // tela.cpp): trilho com tres detentes e o cursor onde a chave esta.
    //
    // Antes era uma barra que enchia de baixo para cima. Uma barra responde
    // "quanto", e uma chave nao tem quanto: tem posicao. O cursor no detente
    // se le num relance, e e o mesmo desenho que esta na tela da placa.
    //
    // O cursor anda de forma proporcional, e nao de detente em detente: assim
    // uma chave de 6 posicoes tambem aparece, parando entre as marcas.
    const tr = document.createElement('i');
    tr.className = 'sw__track';
    const fi = document.createElement('i');
    fi.className = 'sw__cur';
    fi.id = 'swf' + i;
    tr.appendChild(fi);

    b.append(tr, lb);
    sw.appendChild(b);

    // No Alfa a chave e COMANDO: clicar anda uma posicao (baixo, meio, alto) e
    // manda os 32 bits. No ExpressLRS ela e so mostrador -- o quadro vem do
    // transmissor, e nao ha o que comandar deste lado.
    if (alfa) {
      b.classList.add('swx--btn');
      b.tabIndex = 0;
      b.title = 'clique para trocar de posicao';
      const anda = () => mandaChaveAlfa(i);
      b.addEventListener('click', anda);
      b.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); anda(); }
      });
    }
  }

  const emg = $('emerg');
  if (emg) {
    emg.hidden = !alfa;
    // No meio da fileira, entre as quatro chaves de cada lado: e o arranjo de
    // um controle de verdade, e o botao que se procura com pressa fica no
    // centro, nao no fim de uma lista.
    if (alfa) sw.insertBefore(emg, $('sw4'));
  }
}

/* Os 32 bits do quadro Alfa, montados aqui e mandados inteiros.
   O painel guarda o ultimo bitmap que o firmware relatou: comandar uma chave e
   trocar dois bits nele, nao inventar um valor novo -- os outros bits tem
   significado na maquina do outro lado. */
let chavesAlfa = 0;
// Enquanto um comando esta em voo, o estado do firmware nao sobrescreve a tela:
// entre o clique e a resposta a chave voltaria sozinha para a posicao antiga.
let chavesEnviadasEm = 0;

async function mandaAlfaBits(bits) {
  chavesAlfa = bits >>> 0;
  chavesEnviadasEm = Date.now();
  pintaChavesAlfa(chavesAlfa);
  try {
    if (LINK.mode !== 'http') {
      await serialWrite('proto chaves ' + chavesAlfa.toString(16) + '\n');
      return;
    }
    await api('api/config', { achaves: String(chavesAlfa) });
  } catch (e) {
    log('err', 'chaves: ' + e.message);
  }
}

function mandaChaveAlfa(i) {
  const pos = (chavesAlfa >> (i * 2)) & 3;
  const nova = pos >= 2 ? 0 : pos + 1;   // 3 nao existe: sao tres posicoes
  const limpo = chavesAlfa & ~(3 << (i * 2));
  void mandaAlfaBits(limpo | (nova << (i * 2)));
}

/* Os dois IDs de 96 bits do enlace Alfa, em hexa.

   Sao 24 digitos: o desta placa e o do outro lado. Gravam na NVS e valem no
   quadro seguinte -- e a mesma porta dos comandos `proto uid` e `proto par`
   do console. A placa recusa o que nao for hexa de 24 digitos, e a recusa
   aparece no registro em vez de virar gravacao silenciosa. */
function poeHex(el, valor) {
  if (!el || valor === undefined) return;
  if (document.activeElement === el || el.dataset.sujo === '1') return;
  el.value = valor || '';
}

async function gravaId(campo, chave) {
  const el = $(campo);
  if (!el) return;
  const hex = (el.value || '').trim().toUpperCase();
  if (!/^[0-9A-F]{24}$/.test(hex)) {
    log('err', 'ID precisa de 24 digitos hexa');
    return;
  }
  try {
    if (LINK.mode !== 'http') {
      await serialWrite(`proto ${chave === 'auid' ? 'uid' : 'par'} ${hex}
`);
    } else {
      await api('api/config', { [chave]: hex });
    }
    el.dataset.sujo = '0';
    log('sys', `${chave === 'auid' ? 'meu ID' : 'ID do par'}: ${hex}`);
  } catch (e) {
    log('err', `ID: ${e.message}`);
  }
}

/* Varredura dos joysticks, do lado do TRANSMISSOR.
   Os sete joysticks andam sozinhos entre -100 e +100 -- e o mesmo comando da
   caixa da coluna da bancada (`proto joy varre`). Serve para exercitar o
   enlace sem ninguem no controle, e por isso mora junto dos mostradores.

   NAO liga sozinho: o que sai daqui e comando de movimento para a maquina do
   outro lado. Quem liga e quem sabe que ela pode se mexer. */
let simLigado = false;

async function mandaSimJoy() {
  const on = !simLigado;
  simLigado = on;
  pintaSimJoy();
  try {
    if (LINK.mode !== 'http') {
      await serialWrite(`proto joy ${on ? 'varre' : 'para'}
`);
      return;
    }
    await api('api/config', { avarre: on ? '1' : '0' });
  } catch (e) {
    log('err', `joystick simulado: ${e.message}`);
  }
}

function pintaSimJoy() {
  const b = $('simJoy');
  if (!b) return;
  b.dataset.on = simLigado ? '1' : '0';
  b.textContent = simLigado ? 'simulando' : 'simular';
}

function mandaEmergAlfa() {
  const armada = (chavesAlfa & (1 << ALFA_BIT_EMERG)) !== 0;
  void mandaAlfaBits(armada ? chavesAlfa & ~(1 << ALFA_BIT_EMERG)
                            : chavesAlfa | (1 << ALFA_BIT_EMERG));
}

/* Desenha as oito chaves e a emergencia a partir do bitmap. */
function pintaChavesAlfa(bits) {
  for (let i = 0; i < ALFA_CHAVES; i++) {
    const pos = Math.min(2, (bits >> (i * 2)) & 3);
    const el = $('sw' + i);
    const cur = $('swf' + i);
    if (!el || !cur) continue;
    el.dataset.pos = String(pos);
    // Curso do cursor no trilho: ver .sw__track e .sw__cur em style.css.
    cur.style.top = ((2 - pos) * 16).toFixed(1) + 'px';
  }
  const emg = $('emerg');
  if (emg) {
    const armada = (bits & (1 << ALFA_BIT_EMERG)) !== 0;
    emg.dataset.armada = armada ? '1' : '0';
    emg.textContent = armada ? 'EMERGÊNCIA ARMADA' : 'EMERGÊNCIA ACIONADA';
  }
}

/* Mostradores do protocolo Alfa.
   Sete joysticks em -100..+100, com o centro em zero, e as chaves em dois bits
   cada — o mesmo que o quadro do Alfa carrega e o mesmo que o display desenha.
   Sao os joysticks que ESTE lado comanda: no Alfa quem transmite e quem tem o
   estado, e com a varredura ligada o J1 anda sozinho. */
function renderSticksAlfa(s) {
  $('sticks').hidden = false;
  $('rcOff').hidden = true;
  buildSticks('alfa');

  // O quadro do Alfa ja carrega -100 a +100: e a propria escala da tela.
  for (let i = 0; i < ALFA_JOYS; i++) pintaJoy(i, Number(s.aj[i]) || 0);

  // O bitmap que vale e o do firmware, menos enquanto uma troca esta em voo:
  // sobrescrever ali faria a chave voltar sozinha entre o clique e a resposta.
  if (Number.isFinite(s.asw) && Date.now() - chavesEnviadasEm > 1500) {
    chavesAlfa = Number(s.asw) >>> 0;
  }
  pintaChavesAlfa(chavesAlfa);

  // A pagina do Alfa termina nas chaves.
  //
  // Abaixo delas ficavam o comando dos joysticks -- que repete as barras logo
  // acima --, a nota e o bloco de digitos (SNR, tempo no ar, potencia,
  // frequencia, recebidos, perdidos). Esses numeros ja estao na aba da
  // bancada, e aqui competiam com o que a pagina existe para mostrar.
  for (const id of ['joyCmd', 'rcNote', 'gDigits']) {
    const el = $(id);
    if (el) el.hidden = true;
  }

  // Sempre ao vivo: e o estado local, nao algo que chega pelo ar e envelhece.
  $('rcRate').textContent = 'ao vivo';
  if (s.rapido) return;   // enquete de 10 Hz: so as barras

  // O botao de simular so existe no papel de TRANSMISSOR: no receptor os
  // joysticks vem do ar, e nao ha o que varrer.
  const b = $('simJoy');
  if (b) {
    const tx = s.alfa?.papel === 'transmissor';
    b.hidden = !tx;
    if (s.alfa?.varredura !== undefined) {
      simLigado = !!s.alfa.varredura;
      pintaSimJoy();
    }
  }
  $('rcNote').textContent =
    'protocolo Alfa · sete joysticks e 32 bits de chaves, o que este lado comanda';
}

function renderSticks(s) {
  // Com enlace ausente o firmware ainda publica rc[] -- sao os valores de
  // failsafe. Desenha-los e mostrar joysticks de um piloto que nao existe.
  // O Alfa vem nas unidades dele: sete joysticks de -100 a +100 e as chaves em
  // campos de dois bits. Nao passa pela escala de canal do ExpressLRS.
  const alfa = Array.isArray(s.aj) && s.aj.length === ALFA_JOYS;
  if (alfa) return renderSticksAlfa(s);

  for (const id of ['rcNote', 'gDigits']) {
    const el = $(id);
    if (el) el.hidden = false;
  }

  const has = Array.isArray(s.rc) && s.rc.length === 4 && s.linked !== false;
  $('sticks').hidden = !has;
  $('rcOff').hidden = has;
  if (!has) return;

  buildSticks('elrs');

  // A escala vem do DIALETO, nao fixa.
  //
  // O firmware de bancada entrega 10 bits crus do ar (0..1023); o CRSF de um
  // receptor ExpressLRS entrega 11 bits na faixa util 172..1811, com 992 no
  // centro. Dividir os dois por 1023 fazia a barra do CRSF estourar 100% e o
  // joystick parecer travado no fim de curso.
  const crsf = s.rcMax === 2047;
  const LO = crsf ? 172 : 0;
  const HI = crsf ? 1811 : 1023;

  const MEIO = (LO + HI) / 2;
  for (let i = 0; i < 4; i++) {
    pintaJoy(i, ((s.rc[i] - MEIO) / ((HI - LO) / 2)) * 100);
  }
  for (let i = 4; i < ALFA_JOYS; i++) {
    // Sobraram barras de um desenho anterior? Nao acontece com buildSticks
    // trocando o dialeto, e a guarda custa nada.
    const el = $('ch' + i);
    if (el) el.style.width = '0%';
  }

  // Chaves: no CRSF sao CANAIS (5 em diante), nao bits. Uma chave de 2 posicoes
  // fica em 191 ou 1792; o meio da faixa separa as duas sem precisar saber
  // quantas posicoes cada uma tem.
  // Tres faixas, nao duas. Um terco de cada lado e "baixo"/"alto"; o meio e a
  // posicao central, que existe de verdade numa chave de 3 e antes era
  // arredondada para um dos extremos.
  const NOMES = ['BAIXO', 'MEIO', 'ALTO'];
  for (let i = 0; i < 8; i++) {
    let raw = null;
    if (crsf && Array.isArray(s.rcAll)) {
      raw = s.rcAll[4 + i];
    } else {
      // Firmware de bancada: as chaves vem como bits, entao so ha 2 posicoes
      // — o RCDATA em OTA4 nao carrega mais que isso.
      const bits = s.rcSw || 0;
      const on = i === 0 ? (bits >> 6) & 1 : (bits >> (i - 1)) & 1;
      raw = on ? HI : LO;
    }

    const f = Math.max(0, Math.min(1, (raw - LO) / (HI - LO)));
    const pos = f < 1 / 3 ? 0 : f < 2 / 3 ? 1 : 2;

    const el = $('sw' + i);
    el.dataset.pos = String(pos);
    el.title = NOMES[pos] + ' · ' + raw;
    // Curso do cursor dentro do trilho, em px: altura do trilho menos a do
    // cursor (ver .sw__track e .sw__cur em style.css). f = 1 e o topo.
    $('swf' + i).style.top = ((1 - f) * 32).toFixed(1) + 'px';
  }

  // A taxa REAL de RCDATA, e nao a taxa do transmissor.
  //
  // O ELRS salta 80 canais e a bancada senta so no de sync, entao chega uma
  // fracao dos pacotes. Mostrar isso evita que barras lentas sejam lidas como
  // travamento — elas estao certas, o que e baixo e a colheita.
  // rcAge nao existe no ExpressLRS. Sem guarda, (undefined/1000).toFixed(1)
  // escrevia "ultimo ha NaN s" alternando com "ao vivo" a cada segundo.
  const dt = Number.isFinite(s.rcAge) ? s.rcAge : (s.linked ? 0 : Infinity);
  $('rcRate').textContent =
    (dt < 1200 ? 'ao vivo' : 'ultimo ha ' + (dt / 1000).toFixed(1) + ' s');
  if (!s.rcN) return;   // atualizacao rapida: so as barras, sem remexer texto
  $('rcNote').textContent = crsf
    ? 'receptor ExpressLRS seguindo o FHSS · canais a ' + Math.round(1000 / RC_MS()) + ' Hz na tela'
    : s.rcN + ' quadro(s) RCDATA · modo escuta no canal de sync, chega ~1 de cada 80';
}

/* --- transporte: WiFi, ou serial ------------------------------------------

   O painel nasceu falando HTTP com a propria placa que o serve. Isso cobre o
   caso de campo — celular no AP da placa — e nao cobre o de bancada, em que a
   placa esta no USB do PC e o WiFi dela nem precisa estar ligado (o AP de
   2,4 GHz dessensibiliza o proprio receptor nos pares 2G4).

   UM baud para tudo: 420000, o do CRSF do ExpressLRS, que e fixo. A bancada
   foi alinhada nele (platformio.ini, SERIAL_BAUD), entao nao ha o que
   adivinhar — a porta abre e pronto.

   O que ainda varia e o DIALETO, e esse da para ler do conteudo:

     receptor ExpressLRS    quadros CRSF binarios
     firmware de bancada    texto  $T / $R

   Byte de endereco CRSF conhecido no inicio do quadro decide, e a decisao e
   revisada a cada leitura ate a primeira certeza.  */

const LINK = {
  mode: 'http',            // 'http' | 'text' | 'crsf'
  port: null,
  reader: null,
  text: '',
  state: null,
  probing: false,
};

const serialOk = () => 'serial' in navigator;

/* ---- dialeto 1: texto do firmware de bancada ---------------------------- */

function feedLine(line) {
  if (line.startsWith('$T ')) {
    const kv = {};
    for (const tok of line.slice(3).trim().split(/\s+/)) {
      const eq = tok.indexOf('=');
      if (eq > 0) kv[tok.slice(0, eq)] = tok.slice(eq + 1);
    }
    if (kv.rssi === undefined || !kv.band) return;

    const n = (k, d) => (kv[k] === undefined ? d : Number(kv[k]));
    const prev = LINK.state || {};
    LINK.state = Object.assign({}, prev, {
      node: prev.node || 'USB',
      band: kv.band,
      freq: n('freq', 0),
      bw: n('bw', 0),
      sf: n('sf', 0),
      cr: prev.cr || 0,
      power: n('pwr', 0),
      rssi: n('rssi', 0),
      snr: n('snr', 0),
      rx: n('rx', 0),
      lost: n('lost', 0),
      lq: n('lq', 255),
      linked: kv.link === '1',
      toa: prev.toa || 0,
      tx: prev.tx || 0,
      err: prev.err || 0,
      rtt: 0,
      radioOk: true,
      log: [],
    });
    return;
  }

  if (line.startsWith('$R ')) {
    const kv = {};
    for (const tok of line.slice(3).trim().split(/\s+/)) {
      const eq = tok.indexOf('=');
      if (eq > 0) kv[tok.slice(0, eq)] = Number(tok.slice(eq + 1));
    }
    if (!LINK.state) return;
    LINK.state.rc = [kv.a, kv.e, kv.t, kv.r];
    LINK.state.rcMax = 1023;             // 10 bits, escala do ar do OTA4
    LINK.state.rcSw = kv.sw || 0;
    LINK.state.rcAge = kv.age || 0;
    LINK.state.rcN = kv.cnt || 0;
    return;
  }

  // Protocolo em uso, e o estado do enlace Alfa quando ele e o que esta no ar.
  //
  // Linha propria pelo mesmo motivo do $R: o $T tem contrato com o app de
  // alcance e nao carrega campo que so existe num dos protocolos. Sem esta
  // linha o painel servido do PC nao teria como saber que protocolos existem,
  // e o seletor ficaria escondido.
  if (line.startsWith('$A ')) {
    const kv = {};
    for (const tok of line.slice(3).trim().split(/\s+/)) {
      const eq = tok.indexOf('=');
      if (eq > 0) kv[tok.slice(0, eq)] = tok.slice(eq + 1);
    }
    // Mesma regra do $R: sem o $T que abre o estado nao ha o que completar, e
    // renderizar um estado pela metade so pinta "undefined" na tela. As duas
    // linhas saem juntas do printTelemetry, entao nao se perde nada.
    if (!LINK.state) return;
    LINK.state.proto = kv.proto === 'alfa' ? 'alfa' : 'elrs';
    // As opcoes sao conhecidas do painel; a serial so diz qual esta ativa.
    LINK.state.protoOpts = PROTOS;
    if (kv.proto !== 'alfa') {
      delete LINK.state.alfa;
      return;
    }
    const n = (k) => Number(kv[k] || 0);
    LINK.state.alfa = {
      estado: kv.estado || '?',
      canal: n('canal'),
      freq: n('freq'),
      uid: kv.uid || '',
      pareado: kv.par === '1',
      vivo: kv.vivo === '1',
      rx: n('rx'),
      crcRuim: n('crc'),
      idRuim: n('id'),
      quedas: n('quedas'),
      silencio: n('sil'),
    };
    return;
  }

  const t = line.trim();
  if (t) log('rx', t);
}

/* ---- dialeto 2: CRSF do receptor ExpressLRS ----------------------------- */

const CRSF_TYPE_LINK = 0x14;
const CRSF_TYPE_RC = 0x16;
const CRSF_ADDR = new Set([0xC8, 0xEA, 0xEC, 0xEE]);

/* CRC-8/DVB-S2, polinomio 0xD5 — o do CRSF. Tabela porque isso roda por
   quadro, a 50 Hz ou mais. */
const CRSF_CRC = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let b = 0; b < 8; b++) c = c & 0x80 ? ((c << 1) ^ 0xD5) & 0xFF : (c << 1) & 0xFF;
    t[i] = c;
  }
  return t;
})();

function crsfCrc8(b, from, to) {
  let c = 0;
  for (let i = from; i < to; i++) c = CRSF_CRC[(c ^ b[i]) & 0xFF];
  return c;
}

/* 16 canais de 11 bits empacotados em 22 bytes. Portado de tools/serial. */
function crsfUnpack(buf, at) {
  const out = new Array(16);
  let bitPos = 0;
  for (let i = 0; i < 16; i++) {
    const byte = at + (bitPos >> 3);
    const raw = buf[byte] | (buf[byte + 1] << 8) | (buf[byte + 2] << 16);
    out[i] = (raw >> (bitPos & 7)) & 0x7FF;
    bitPos += 11;
  }
  return out;
}

const CRSF = { buf: [], frames: 0, rc: null, link: null };

function crsfFeed(bytes) {
  for (const x of bytes) CRSF.buf.push(x);
  // Buffer solto e sinal de sincronismo perdido; nao vale guardar lixo.
  if (CRSF.buf.length > 2048) CRSF.buf.splice(0, CRSF.buf.length - 512);

  for (;;) {
    while (CRSF.buf.length && !CRSF_ADDR.has(CRSF.buf[0])) CRSF.buf.shift();
    if (CRSF.buf.length < 4) return;

    const len = CRSF.buf[1];
    if (len < 2 || len > 62) { CRSF.buf.shift(); continue; }
    const total = len + 2;
    if (CRSF.buf.length < total) return;

    const b = CRSF.buf;
    // CRC cobre do tipo ate o byte antes do proprio CRC.
    if (crsfCrc8(b, 2, total - 1) !== b[total - 1]) { CRSF.buf.shift(); continue; }

    const kind = b[2];
    if (kind === CRSF_TYPE_RC && len >= 24) {
      CRSF.rc = crsfUnpack(b, 3);
      CRSF.frames++;
    } else if (kind === CRSF_TYPE_LINK && len >= 12) {
      const snr = b[6] < 128 ? b[6] : b[6] - 256;
      CRSF.link = { rssi: -b[3], lq: b[5], snr, rfMode: b[8], power: b[9] };
      CRSF.frames++;
    }
    CRSF.buf.splice(0, total);
  }
}

/* O estado que o render() consome, montado do que o CRSF traz.
   O que o CRSF NAO carrega — banda, SF, tempo no ar — fica de fora em vez de
   sair zerado: um receptor ExpressLRS nao reporta a configuracao do modem, e
   inventar zeros ali faria o painel afirmar coisas que ninguem mediu. */
function crsfState() {
  const L = CRSF.link || {};
  return {
    node: 'ELRS',
    band: '2g4',
    freq: 0, bw: 0, sf: 0, cr: 0,
    power: L.power === undefined ? 0 : L.power,
    rssi: L.rssi === undefined ? 0 : L.rssi,
    snr: L.snr === undefined ? 0 : L.snr,
    lq: L.lq === undefined ? 255 : L.lq,
    rx: CRSF.frames,
    lost: 0,
    linked: !!CRSF.link,
    toa: 0, tx: 0, err: 0, rtt: 0,
    radioOk: true,
    log: [],
    rc: CRSF.rc ? CRSF.rc.slice(0, 4) : undefined,
    // CRSF usa 11 bits: 172..1811 e a faixa util, 992 o centro.
    rcMax: 2047,
    rcAll: CRSF.rc || undefined,
    rcSw: 0,
    rcAge: 0,
    rcN: CRSF.frames,
  };
}

/* ---- abertura, com deteccao de baud ------------------------------------- */

const SERIAL_BAUD = 420000;

async function serialConnect() {
  if (!serialOk()) {
    log('err', 'este navegador nao tem Web Serial (use Chrome ou Edge no PC)');
    return;
  }
  try {
    LINK.port = await navigator.serial.requestPort();
  } catch (e) {
    return;                                   // cancelou o seletor
  }

  try {
    CRSF.buf = []; CRSF.frames = 0; CRSF.rc = null; CRSF.link = null;
    LINK.text = '';
    LINK.state = null;
    LINK.mode = 'auto';
    await LINK.port.open({ baudRate: SERIAL_BAUD, bufferSize: 8192 });
    setTransportUi();
    log('sys', 'serial aberta a ' + SERIAL_BAUD);
    void serialLoop();

    // A bancada so fala se for perguntada. O receptor ELRS fala sozinho, entao
    // mandar isto para ele e inofensivo: nao e quadro CRSF valido e ele ignora.
    await serialWrite('quiet on\n');
    await serialWrite('tel\n');
  } catch (e) {
    log('err', 'serial: ' + (e && e.message ? e.message : e));
    await serialClose(true);
  }
}

async function serialLoop() {
  const dec = new TextDecoder();
  let reader;
  try {
    reader = LINK.port.readable.getReader();
  } catch {
    return;
  }
  LINK.reader = reader;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done || LINK.mode === 'closing' || LINK.mode === 'http') break;

      // Alimenta OS DOIS parsers enquanto o dialeto nao esta decidido. Quem
      // produzir primeiro ganha, e a partir dai so ele roda. Escolher pelo
      // primeiro byte seria fragil: a porta pode abrir no meio de um quadro.
      if (LINK.mode === 'auto' || LINK.mode === 'crsf') {
        crsfFeed(value);
        if (CRSF.frames) {
          if (LINK.mode !== 'crsf') {
            LINK.mode = 'crsf';
            setTransportUi();
            log('sys', 'dialeto CRSF — receptor ExpressLRS');
          }
          render(crsfState());
          continue;
        }
      }

      if (LINK.mode === 'auto' || LINK.mode === 'text') {
        LINK.text += dec.decode(value, { stream: true });
        let i;
        while ((i = LINK.text.indexOf('\n')) >= 0) {
          const line = LINK.text.slice(0, i).replace(/\r$/, '');
          LINK.text = LINK.text.slice(i + 1);
          if (line) feedLine(line);
        }
        if (LINK.text.length > 4096) LINK.text = '';
        if (LINK.state) {
          if (LINK.mode !== 'text') {
            LINK.mode = 'text';
            setTransportUi();
            log('sys', 'dialeto texto — firmware de bancada');
          }
          render(LINK.state);
        }
      }
    }
  } catch (e) {
    log('err', 'leitura parou: ' + (e && e.message ? e.message : e));
  } finally {
    try { reader.releaseLock(); } catch { /* ja solto */ }
  }
}

async function serialWrite(text) {
  if (!LINK.port || !LINK.port.writable) return;
  const w = LINK.port.writable.getWriter();
  try {
    await w.write(new TextEncoder().encode(text));
  } finally {
    w.releaseLock();
  }
}

async function serialClose(full) {
  if (LINK.mode === 'text') {
    // Devolve o console a placa: quem plugar o monitor depois espera achar o
    // firmware falando, nao mudo.
    await serialWrite('quiet off\n').catch(() => undefined);
  }
  const m = LINK.mode;
  LINK.mode = 'closing';
  try { await LINK.reader?.cancel(); } catch { /* ja parou */ }
  LINK.reader = null;
  try { await LINK.port?.close(); } catch { /* ja fechada */ }
  LINK.mode = m;
  if (full) {
    LINK.port = null;
    LINK.mode = 'http';
    LINK.state = null;
    setTransportUi();
  }
}

async function serialDisconnect() {
  await serialClose(true);
  log('sys', 'serial fechada — voltando ao WiFi');
}

function setTransportUi() {
  const ser = LINK.mode === 'crsf' || LINK.mode === 'text' || LINK.mode === 'auto';
  $('btSerial').hidden = ser;
  $('btSerialOff').hidden = !ser;
  $('transport').textContent =
    LINK.mode === 'crsf' ? 'USB · CRSF'
    : LINK.mode === 'text' ? 'USB · bancada'
    : LINK.mode === 'auto' ? 'USB · ouvindo…'
    : 'WiFi · HTTP';
  $('transport').dataset.mode = ser ? 'serial' : 'http';
}

onEl('btSerial', 'click', () => void serialConnect());
onEl('btSerialOff', 'click', () => void serialDisconnect());
if (!serialOk()) $('btSerial').disabled = true;
setTransportUi();
