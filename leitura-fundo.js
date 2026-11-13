// leitura-fundo.js (carregado pelo background.js)
// PROTÓTIPO: lê as páginas em voz alta com o painel lateral FECHADO.
//
// O Chrome não deixa extensões abrirem o painel sozinhas, mas a voz das
// extensões (chrome.tts) pode falar sem clique. Então, com o painel
// fechado, o próprio background extrai, traduz, descreve as imagens e lê.
// Quando o painel abre numa janela, ele assume a leitura daquela janela.

const ESPERA_TROCA_MS = 700; // junta eventos em sequência (redirecionamentos, troca rápida de abas)
const LIMITE_IMAGENS_FUNDO = 8;
const IMAGENS_EM_PARALELO = 4;

function registrar(...partes) {
  // Para diagnóstico: chrome://extensions → Leitor Acessível → "service worker"
  console.info("[Leitor Acessível, painel fechado]", ...partes);
}

// ---------- painéis abertos ----------

// O painel se conecta ao abrir (ver conectarAoBackground no sidepanel.js) e
// a conexão cai sozinha quando ele fecha. Janela com painel = painel lê.
const paineisAbertos = new Map(); // porta → windowId

function painelAbertoNaJanela(windowId) {
  return [...paineisAbertos.values()].includes(windowId);
}

chrome.runtime.onConnect.addListener((porta) => {
  if (porta.name !== "painel") return;
  porta.onMessage.addListener((msg) => {
    if (msg.windowId === undefined) return;
    paineisAbertos.set(porta, msg.windowId);
    // O painel vai começar a própria leitura: o fundo se cala
    if (fundo.falando) pararFundo();
  });
  porta.onDisconnect.addListener(() => {
    paineisAbertos.delete(porta);
    // Fechar o painel = silêncio (a fala dele ficaria sem controle)
    chrome.tts.stop();
    fundo.falando = false;
  });
});

// ---------- configuração ----------

async function lerConfiguracao() {
  const dados = await chrome.storage.local.get([
    "lerSemPainel", "traduzirPaginas", "descreverImagens", "descricaoDetalhada", "velocidade",
  ]);
  return {
    lerSemPainel: dados.lerSemPainel !== false, // protótipo: ligado por padrão
    traduzir: dados.traduzirPaginas !== false,
    descrever: dados.descreverImagens !== false,
    detalhe: dados.descricaoDetalhada ? "detalhado" : "curto",
    velocidade: Number(dados.velocidade) || 1,
  };
}

// ---------- estado da leitura de fundo ----------

const fundo = {
  geracao: 0, // incrementa a cada nova leitura/parada: invalida preparo e eventos antigos
  falando: false,
  // Página que está sendo preparada ou lida ({ tabId, documentoId }). O
  // documentoId (content.js) diferencia "abriu outra página" de "a mesma
  // página só mudou o endereço" (pushState, #), que não recomeça a leitura.
  alvo: null,
};

function pararFundo() {
  fundo.geracao += 1;
  fundo.falando = false;
  chrome.tts.stop();
}

// O service worker pode ser desligado pelo Chrome entre uma fala e outra:
// a posição fica guardada na sessão para Alt+Shift+K conseguir continuar
async function guardarPosicao(dados) {
  await chrome.storage.session.set({ leituraFundo: dados });
}

async function posicaoGuardada() {
  return (await chrome.storage.session.get("leituraFundo")).leituraFundo || null;
}

// ---------- preparo da página (o mesmo caminho do painel, resumido) ----------

async function detectarIdiomaFundo(amostra, declarado) {
  const reserva = (declarado || "").split("-")[0].toLowerCase() || "pt";
  if (amostra.trim().length < 20) return reserva;
  try {
    const resultado = await chrome.i18n.detectLanguage(amostra);
    const melhor = resultado && resultado.languages && resultado.languages[0];
    if (resultado.isReliable && melhor && melhor.language !== "und") {
      return melhor.language.split("-")[0].toLowerCase();
    }
  } catch {
    // sem detecção: usa o declarado
  }
  return reserva;
}

async function descreverEmParalelo(lista, detalhe) {
  // Até IMAGENS_EM_PARALELO pedidos ao mesmo tempo: uma página com várias
  // imagens deixava a pessoa vários segundos em silêncio esperando
  const resultados = new Array(lista.length);
  let proxima = 0;
  async function trabalhador() {
    while (proxima < lista.length) {
      const i = proxima++;
      try {
        resultados[i] = `Imagem: ${await descreverImagem(lista[i], detalhe)}`;
      } catch (erro) {
        registrar("imagem sem descrição:", erro.message);
        resultados[i] = "Imagem sem descrição.";
      }
    }
  }
  await Promise.all(Array.from({ length: IMAGENS_EM_PARALELO }, trabalhador));
  return resultados;
}

// O Chrome desliga o service worker depois de ~30 s sem atividade. Com o
// painel fechado é ele quem espera a tradução e as descrições: uma página
// grande deixava o service worker ser desligado no meio, e a leitura nunca
// começava. Chamar uma API da extensão de tempos em tempos conta como
// atividade.
const INTERVALO_MANTER_LIGADO_MS = 20 * 1000;

async function manterLigadoDurante(tarefa) {
  const intervalo = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), INTERVALO_MANTER_LIGADO_MS);
  try {
    return await tarefa();
  } finally {
    clearInterval(intervalo);
  }
}

function prepararPagina(tabId, url, config, aoDemorar) {
  return manterLigadoDurante(() => prepararPaginaAgora(tabId, url, config, aoDemorar));
}

async function prepararPaginaAgora(tabId, url, config, aoDemorar) {
  const resposta = await extrairDaAba(tabId, url);
  if (!resposta || !resposta.ok) {
    registrar("página não lida:", (resposta && resposta.motivo) || "sem resposta", url);
    return null;
  }

  let titulo = resposta.titulo || "";
  // Blocos: pedaços do texto ligados aos elementos da página (destaque e
  // rolagem acompanhando o áudio)
  const secoes = resposta.secoes.map((s) => ({
    titulo: s.titulo || "",
    tituloId: s.tituloId || null,
    blocos: (s.blocos || (s.texto ? [{ texto: s.texto, id: null }] : [])).map((b) => ({ ...b })),
    imagensSemAlt: s.imagensSemAlt || [],
    imagensSemAltIds: s.imagensSemAltIds || [],
  }));

  const amostra = [titulo, ...secoes.map((s) => `${s.titulo} ${s.blocos.map((b) => b.texto).join(" ")}`)]
    .join(" ")
    .slice(0, 4000);
  let idioma = await detectarIdiomaFundo(amostra, resposta.idioma);
  const traduzir = idioma !== "pt" && config.traduzir && Boolean(URL_BACKEND);

  // Imagens sem alt (no máximo LIMITE_IMAGENS_FUNDO na página). SVG precisa
  // do painel para virar PNG, então aqui fica como "sem descrição".
  const imagens = [];
  if (config.descrever && URL_BACKEND) {
    for (const [indice, secao] of secoes.entries()) {
      secao.imagensSemAlt.forEach((src, j) => {
        if (imagens.length < LIMITE_IMAGENS_FUNDO) imagens.push({ indice, src, id: secao.imagensSemAltIds[j] || null });
      });
    }
  }

  // Sem o painel não há "Traduzindo…" na tela: avisa por voz que está
  // preparando, senão parece que nada aconteceu
  if (traduzir || imagens.length) aoDemorar();
  registrar(`preparando "${titulo}": idioma ${idioma}, ${traduzir ? "com" : "sem"} tradução, ${imagens.length} imagem(ns) para descrever`);

  // Tradução e descrições ao mesmo tempo (as descrições já vêm em português)
  const [traducao, descricoes] = await Promise.all([
    traduzir
      ? traduzirTextos([titulo, ...secoes.flatMap((s) => [s.titulo, ...s.blocos.map((b) => b.texto)])], idioma).catch((erro) => {
          registrar("tradução falhou, lendo no original:", erro.message);
          return null;
        })
      : null,
    descreverEmParalelo(imagens.map((i) => i.src), config.detalhe),
  ]);

  if (traducao) {
    const [tituloTraduzido, ...resto] = traducao;
    titulo = tituloTraduzido;
    let i = 0;
    for (const s of secoes) {
      s.titulo = resto[i++];
      for (const bloco of s.blocos) bloco.texto = resto[i++];
    }
    idioma = "pt";
  }
  imagens.forEach(({ indice, id }, i) => {
    secoes[indice].blocos.push({ texto: descricoes[i], id });
  });

  // Trechos falados, cada um com o id do elemento da página de onde veio
  const trechos = [{ texto: `${titulo}.`, id: null }];
  for (const s of secoes) {
    if (s.titulo) trechos.push({ texto: `${s.titulo}.`, id: s.tituloId });
    for (const bloco of s.blocos) {
      for (const texto of dividirEmTrechos(bloco.texto)) trechos.push({ texto, id: bloco.id });
    }
  }
  // Sem o painel não há aviso na tela: se a tradução falhou, a leitura
  // começa dizendo por que a página vai ser lida no idioma original
  if (traduzir && !traducao) {
    trechos.unshift({ texto: "Não foi possível traduzir a página. Lendo no idioma original.", id: null, aviso: true });
  }
  return { trechos, lang: idioma === "pt" ? "pt-BR" : idioma, documentoId: resposta.documentoId || null };
}

// ---------- fala ----------

function falarTrechos(trechos, inicio, lang, velocidade, tabId, documentoId) {
  // Toda a página na fila da voz de uma vez: lê sem pausas entre os trechos
  const geracao = ++fundo.geracao;
  fundo.falando = true;
  for (let i = inicio; i < trechos.length; i++) {
    chrome.tts.speak(trechos[i].texto, {
      lang: trechos[i].aviso ? "pt-BR" : lang, // avisos da extensão são em português
      rate: velocidade,
      enqueue: i !== inicio, // o primeiro substitui o que estiver falando
      onEvent: (evento) => {
        if (evento.type === "error") registrar("erro da voz:", evento.errorMessage || "sem detalhe", `(idioma ${lang})`);
        if (geracao !== fundo.geracao) return;
        if (evento.type === "start") {
          guardarPosicao({ tabId, documentoId, trechos, lang, posicao: i });
          // A página acompanha o áudio: destaca o trecho e rola até ele
          if (trechos[i].id) destacarNaAba(tabId, trechos[i].id);
        } else if (i === trechos.length - 1 && (evento.type === "end" || evento.type === "error")) {
          fundo.falando = false;
          guardarPosicao({ tabId, documentoId, trechos, lang, posicao: 0 });
          destacarNaAba(tabId, null);
        }
      },
    });
  }
}

function falarAviso(texto, config) {
  // Avisos curtos; a leitura de verdade (enqueue: false) os substitui
  chrome.tts.speak(texto, { lang: "pt-BR", rate: config.velocidade });
}

function avisarCarregando(config) {
  falarAviso("Carregando a página.", config);
}

async function lerNoFundo(tab, documentoId) {
  if (!tab || !tab.active) return;
  if (painelAbertoNaJanela(tab.windowId)) return registrar("painel aberto nesta janela: o painel lê");
  const config = await lerConfiguracao();
  if (!config.lerSemPainel) return registrar("leitura com o painel fechado está desligada no ⚙");

  pararFundo();
  fundo.alvo = { tabId: tab.id, documentoId };
  const geracao = fundo.geracao;
  const pagina = await prepararPagina(tab.id, tab.url, config, () => avisarCarregando(config));
  // Mudou de página (ou abriu o painel) enquanto esta era preparada: não lê
  if (!pagina || geracao !== fundo.geracao || painelAbertoNaJanela(tab.windowId)) return;
  fundo.alvo = { tabId: tab.id, documentoId: pagina.documentoId };
  registrar(`lendo ${pagina.trechos.length} trecho(s)`);
  falarTrechos(pagina.trechos, 0, pagina.lang, config.velocidade, tab.id, pagina.documentoId);
}

function destacarNaAba(tabId, id) {
  chrome.tabs.sendMessage(tabId, { tipo: "DESTACAR", id }).catch(() => {});
}

// O áudio acompanha a rolagem: a pessoa rolou a página (content.js avisa
// quais trechos estão no topo da tela) e a leitura pula para lá
chrome.runtime.onMessage.addListener((msg, remetente) => {
  if (msg.tipo !== "ROLAGEM_USUARIO" || !remetente.tab) return;
  if (painelAbertoNaJanela(remetente.tab.windowId)) return; // o painel cuida
  pularParaATelaNoFundo(remetente.tab, msg.ids, msg.documentoId);
});

// A página que estava sendo lida saiu de verdade (content.js, "pagehide"):
// cala na hora, sem esperar a próxima carregar
chrome.runtime.onMessage.addListener((msg, remetente) => {
  if (msg.tipo !== "PAGINA_SAINDO" || !remetente.tab || !fundo.alvo) return;
  if (fundo.alvo.tabId === remetente.tab.id && fundo.alvo.documentoId === msg.documentoId) {
    pararFundo();
    fundo.alvo = null;
  }
});

async function pularParaATelaNoFundo(tab, ids, documentoId) {
  const guardada = await posicaoGuardada();
  if (!guardada || guardada.tabId !== tab.id || guardada.documentoId !== documentoId) return;
  const posicao = ids
    .map((id) => guardada.trechos.findIndex((t) => t.id === id))
    .find((i) => i !== -1);
  if (posicao === undefined || posicao === guardada.posicao) return;
  if (await chrome.tts.isSpeaking()) {
    const config = await lerConfiguracao();
    falarTrechos(guardada.trechos, posicao, guardada.lang, config.velocidade, tab.id, documentoId);
  } else {
    // Pausado: só muda o ponto de onde Alt+Shift+K vai continuar
    await guardarPosicao({ ...guardada, posicao });
    destacarNaAba(tab.id, guardada.trechos[posicao].id);
  }
}

// ---------- eventos do navegador ----------

let esperaTrocaFundo = null;

function agendarLeituraDeFundo(tabId, { trocouDeAba = false } = {}) {
  clearTimeout(esperaTrocaFundo);
  esperaTrocaFundo = setTimeout(async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    const documentoId = await documentoDaAba(tabId);
    // "Carregou" de novo, mas é o mesmo documento (o site só mudou o
    // endereço): a leitura continua. Antes ela recomeçava a cada mudança e,
    // em sites que mudam o endereço sem parar, nunca saía do "Carregando".
    const mesmaPagina =
      !trocouDeAba && documentoId && fundo.alvo &&
      fundo.alvo.tabId === tabId && fundo.alvo.documentoId === documentoId;
    if (mesmaPagina) return registrar("mesma página, só o endereço mudou: a leitura continua");
    lerNoFundo(tab, documentoId);
  }, ESPERA_TROCA_MS);
}

chrome.tabs.onUpdated.addListener((tabId, mudanca, aba) => {
  if (!aba.active || painelAbertoNaJanela(aba.windowId)) return;
  if (mudanca.status === "complete") agendarLeituraDeFundo(tabId);
});

chrome.tabs.onActivated.addListener((info) => {
  if (painelAbertoNaJanela(info.windowId)) return;
  if (fundo.falando) pararFundo();
  agendarLeituraDeFundo(info.tabId, { trocouDeAba: true });
});

// Ao abrir o navegador: a página inicial (ou as abas restauradas) costuma
// terminar de carregar ANTES de a extensão ficar pronta, e o aviso "a aba
// carregou" se perde. Por isso, ao iniciar, a extensão procura a aba ativa
// e lê por conta própria, sem esperar esse aviso.
const ESPERA_MAX_ABA_INICIAL_MS = 15 * 1000;

function podeSerLida(url) {
  return /^(https?|file):/i.test(url || "");
}

async function abaAtivaAoIniciar() {
  const [focada] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (focada) return focada;
  const [qualquer] = await chrome.tabs.query({ active: true });
  return qualquer || null;
}

async function lerAoIniciar() {
  const config = await lerConfiguracao();
  if (!config.lerSemPainel) return;
  // Espera a aba ativa terminar de carregar (até 15 s)
  const limite = Date.now() + ESPERA_MAX_ABA_INICIAL_MS;
  let aba = await abaAtivaAoIniciar();
  while (aba && aba.status !== "complete" && Date.now() < limite) {
    await new Promise((r) => setTimeout(r, 500));
    aba = await abaAtivaAoIniciar();
  }
  if (aba && podeSerLida(aba.url) && !painelAbertoNaJanela(aba.windowId)) {
    registrar("navegador aberto: lendo a aba", aba.url);
    falarAviso("Leitor Acessível ativo.", config);
    agendarLeituraDeFundo(aba.id, { trocouDeAba: true });
  } else {
    // Nova aba ou página interna do Chrome: não há o que ler ainda
    falarAviso("Leitor Acessível ativo. Abra uma página para ouvir.", config);
  }
}

chrome.runtime.onStartup.addListener(lerAoIniciar);
// Ao instalar a extensão, também já se apresenta e lê a aba aberta
chrome.runtime.onInstalled.addListener((detalhes) => {
  if (detalhes.reason === "install") lerAoIniciar();
});

// Alt+Shift+K com o painel fechado: pausa, continua de onde parou ou, se
// não há leitura guardada desta página, lê a página atual
async function alternarLeituraDeFundo(tab) {
  const falandoAgora = await chrome.tts.isSpeaking();
  if (falandoAgora) {
    pararFundo(); // a posição já está guardada pelo último "start"
    return;
  }
  const guardada = await posicaoGuardada();
  const config = await lerConfiguracao();
  const documentoId = tab ? await documentoDaAba(tab.id) : null;
  if (guardada && tab && guardada.tabId === tab.id && guardada.documentoId === documentoId) {
    falarTrechos(guardada.trechos, guardada.posicao, guardada.lang, config.velocidade, tab.id, documentoId);
  } else if (tab) {
    // Alt+Shift+K funciona mesmo com a leitura de fundo desligada nas
    // configurações: é a pessoa pedindo para ouvir esta página
    pararFundo();
    const geracao = fundo.geracao;
    const pagina = await prepararPagina(tab.id, tab.url, config, () => avisarCarregando(config));
    if (pagina && geracao === fundo.geracao) {
      fundo.alvo = { tabId: tab.id, documentoId: pagina.documentoId };
      falarTrechos(pagina.trechos, 0, pagina.lang, config.velocidade, tab.id, pagina.documentoId);
    }
  }
}
