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

async function prepararPagina(tabId, url, config, aoDemorar) {
  const resposta = await extrairDaAba(tabId, url);
  if (!resposta || !resposta.ok) {
    registrar("página não lida:", (resposta && resposta.motivo) || "sem resposta", url);
    return null;
  }

  let titulo = resposta.titulo || "";
  const secoes = resposta.secoes.map((s) => ({
    titulo: s.titulo || "",
    texto: s.texto || "",
    imagensSemAlt: s.imagensSemAlt || [],
  }));

  const amostra = [titulo, ...secoes.map((s) => `${s.titulo} ${s.texto}`)].join(" ").slice(0, 4000);
  let idioma = await detectarIdiomaFundo(amostra, resposta.idioma);
  const traduzir = idioma !== "pt" && config.traduzir && Boolean(URL_BACKEND);

  // Imagens sem alt (no máximo LIMITE_IMAGENS_FUNDO na página). SVG precisa
  // do painel para virar PNG, então aqui fica como "sem descrição".
  const imagens = [];
  if (config.descrever && URL_BACKEND) {
    for (const [indice, secao] of secoes.entries()) {
      for (const src of secao.imagensSemAlt) {
        if (imagens.length < LIMITE_IMAGENS_FUNDO) imagens.push({ indice, src });
      }
    }
  }

  // Sem o painel não há "Traduzindo…" na tela: avisa por voz que está
  // preparando, senão parece que nada aconteceu
  if (traduzir || imagens.length) aoDemorar();
  registrar(`preparando "${titulo}": idioma ${idioma}, ${traduzir ? "com" : "sem"} tradução, ${imagens.length} imagem(ns) para descrever`);

  // Tradução e descrições ao mesmo tempo (as descrições já vêm em português)
  const [traducao, descricoes] = await Promise.all([
    traduzir
      ? traduzirTextos([titulo, ...secoes.flatMap((s) => [s.titulo, s.texto])], idioma).catch((erro) => {
          registrar("tradução falhou, lendo no original:", erro.message);
          return null;
        })
      : null,
    descreverEmParalelo(imagens.map((i) => i.src), config.detalhe),
  ]);

  if (traducao) {
    const [tituloTraduzido, ...resto] = traducao;
    titulo = tituloTraduzido;
    secoes.forEach((s, i) => {
      s.titulo = resto[2 * i];
      s.texto = resto[2 * i + 1];
    });
    idioma = "pt";
  }
  imagens.forEach(({ indice }, i) => {
    secoes[indice].texto += ` ${descricoes[i]}`;
  });

  const trechos = [`${titulo}.`];
  for (const s of secoes) {
    const texto = (s.titulo ? s.titulo + ". " : "") + s.texto;
    if (texto.trim()) trechos.push(...dividirEmTrechos(texto));
  }
  return { trechos, lang: idioma === "pt" ? "pt-BR" : idioma };
}

// ---------- fala ----------

function falarTrechos(trechos, inicio, lang, velocidade, tabId, url) {
  // Toda a página na fila da voz de uma vez: lê sem pausas entre os trechos
  const geracao = ++fundo.geracao;
  fundo.falando = true;
  for (let i = inicio; i < trechos.length; i++) {
    chrome.tts.speak(trechos[i], {
      lang,
      rate: velocidade,
      enqueue: i !== inicio, // o primeiro substitui o que estiver falando
      onEvent: (evento) => {
        if (evento.type === "error") registrar("erro da voz:", evento.errorMessage || "sem detalhe", `(idioma ${lang})`);
        if (geracao !== fundo.geracao) return;
        if (evento.type === "start") {
          guardarPosicao({ tabId, url, trechos, lang, posicao: i });
        } else if (i === trechos.length - 1 && (evento.type === "end" || evento.type === "error")) {
          fundo.falando = false;
          guardarPosicao({ tabId, url, trechos, lang, posicao: 0 });
        }
      },
    });
  }
}

function avisarCarregando(config) {
  // A leitura de verdade (enqueue: false) substitui este aviso quando chegar
  chrome.tts.speak("Carregando a página.", { lang: "pt-BR", rate: config.velocidade });
}

async function lerNoFundo(tab) {
  if (!tab || !tab.active) return;
  if (painelAbertoNaJanela(tab.windowId)) return registrar("painel aberto nesta janela: o painel lê");
  const config = await lerConfiguracao();
  if (!config.lerSemPainel) return registrar("leitura com o painel fechado está desligada no ⚙");

  pararFundo();
  const geracao = fundo.geracao;
  const pagina = await prepararPagina(tab.id, tab.url, config, () => avisarCarregando(config));
  // Mudou de página (ou abriu o painel) enquanto esta era preparada: não lê
  if (!pagina || geracao !== fundo.geracao || painelAbertoNaJanela(tab.windowId)) return;
  registrar(`lendo ${pagina.trechos.length} trecho(s)`);
  falarTrechos(pagina.trechos, 0, pagina.lang, config.velocidade, tab.id, tab.url);
}

// ---------- eventos do navegador ----------

let esperaTrocaFundo = null;

function agendarLeituraDeFundo(tabId) {
  clearTimeout(esperaTrocaFundo);
  esperaTrocaFundo = setTimeout(async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    lerNoFundo(tab);
  }, ESPERA_TROCA_MS);
}

chrome.tabs.onUpdated.addListener((tabId, mudanca, aba) => {
  if (!aba.active || painelAbertoNaJanela(aba.windowId)) return;
  // Saiu da página: cala na hora, sem esperar a próxima carregar
  if (mudanca.status === "loading" && fundo.falando) pararFundo();
  if (mudanca.status === "complete") agendarLeituraDeFundo(tabId);
});

chrome.tabs.onActivated.addListener((info) => {
  if (painelAbertoNaJanela(info.windowId)) return;
  if (fundo.falando) pararFundo();
  agendarLeituraDeFundo(info.tabId);
});

// Ao abrir o navegador: avisa que está ativo (a primeira página costuma ser
// a nova aba, que não tem o que ler)
chrome.runtime.onStartup.addListener(async () => {
  const config = await lerConfiguracao();
  if (!config.lerSemPainel) return;
  chrome.tts.speak("Leitor Acessível ativo. Abra uma página para ouvir.", {
    lang: "pt-BR",
    rate: config.velocidade,
  });
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
  if (guardada && tab && guardada.tabId === tab.id && guardada.url === tab.url) {
    falarTrechos(guardada.trechos, guardada.posicao, guardada.lang, config.velocidade, tab.id, tab.url);
  } else if (tab) {
    // Alt+Shift+K funciona mesmo com a leitura de fundo desligada nas
    // configurações: é a pessoa pedindo para ouvir esta página
    pararFundo();
    const geracao = fundo.geracao;
    const pagina = await prepararPagina(tab.id, tab.url, config, () => avisarCarregando(config));
    if (pagina && geracao === fundo.geracao) {
      falarTrechos(pagina.trechos, 0, pagina.lang, config.velocidade, tab.id, tab.url);
    }
  }
}
