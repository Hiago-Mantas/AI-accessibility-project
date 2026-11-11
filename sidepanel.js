// sidepanel.js

const el = {
  btnConfig: document.getElementById("btn-config"),
  painelConfig: document.getElementById("painel-config"),
  inputApiKey: document.getElementById("input-api-key"),
  inputDescreverImagens: document.getElementById("input-descrever-imagens"),
  inputDescricaoDetalhada: document.getElementById("input-descricao-detalhada"),
  inputTraduzir: document.getElementById("input-traduzir"),
  inputLerAutomaticamente: document.getElementById("input-ler-automaticamente"),
  inputLerSemPainel: document.getElementById("input-ler-sem-painel"),
  btnSalvarKey: document.getElementById("btn-salvar-key"),

  estadoInicial: document.getElementById("estado-inicial"),
  estadoCarregando: document.getElementById("estado-carregando"),
  textoCarregando: document.getElementById("texto-carregando"),
  estadoErro: document.getElementById("estado-erro"),
  textoErro: document.getElementById("texto-erro"),
  estadoLeitura: document.getElementById("estado-leitura"),

  btnExtrair: document.getElementById("btn-extrair"),
  btnTentarDeNovo: document.getElementById("btn-tentar-de-novo"),
  btnLerDeNovo: document.getElementById("btn-ler-de-novo"),

  tituloArtigo: document.getElementById("titulo-artigo"),
  metaArtigo: document.getElementById("meta-artigo"),
  listaSecoes: document.getElementById("lista-secoes"),
  textoAtual: document.getElementById("texto-atual"),
  diagnostico: document.getElementById("diagnostico"),

  btnAnterior: document.getElementById("btn-anterior"),
  btnPlayPause: document.getElementById("btn-play-pause"),
  btnProxima: document.getElementById("btn-proxima"),
  inputVelocidade: document.getElementById("input-velocidade"),
  valorVelocidade: document.getElementById("valor-velocidade"),
  anunciador: document.getElementById("anunciador"),
};

let secoes = [];
let indiceAtual = 0;
let falando = false;
let apiKey = null;
let descreverImagens = true; // descrever imagens sem alt pelo backend (Gemini)
let descricaoDetalhada = false; // padrão: uma frase curta por imagem
let traduzirPaginas = true; // traduzir para o português páginas em outro idioma
let lerAutomaticamente = true; // extrair e começar a ler sozinho a cada página aberta
let idiomaLeitura = "pt-BR"; // idioma da voz: o da página quando ela não é traduzida
let errosDescricao = []; // motivos técnicos das falhas (descrição e tradução), mostrados (não falados) no painel
let geracaoFala = 0; // incrementa a cada nova leitura/parada: invalida callbacks de falas canceladas
let trechoAtual = 0; // trecho da seção atual sendo falado: pausar e continuar volta a ele
let abaDaLeitura = null; // aba da página lida: recebe o destaque do trecho falado
// Documento lido (content.js, ID_DOCUMENTO): se o site só muda o endereço
// (pushState, #), o documento é o mesmo e a leitura não recomeça
let documentoDaLeitura = null;

function anunciar(mensagem) {
  // Limpa antes para que a mesma mensagem repetida seja anunciada de novo
  el.anunciador.textContent = "";
  setTimeout(() => {
    el.anunciador.textContent = mensagem;
  }, 50);
}

function mostrarEstado(nome) {
  for (const id of ["estadoInicial", "estadoCarregando", "estadoErro", "estadoLeitura"]) {
    el[id].classList.toggle("oculto", id !== nome);
  }
}

// ---------- configuração da chave de API ----------

const configuracaoCarregada = new Promise((pronto) => chrome.storage.local.get(
  ["anthropicApiKey", "descreverImagens", "descricaoDetalhada", "traduzirPaginas", "lerAutomaticamente", "lerSemPainel", "velocidade"],
  (dados) => {
  if (dados.anthropicApiKey) {
    apiKey = dados.anthropicApiKey;
    el.inputApiKey.value = dados.anthropicApiKey;
  }
  descreverImagens = dados.descreverImagens !== false; // ligado por padrão
  el.inputDescreverImagens.checked = descreverImagens;
  descricaoDetalhada = Boolean(dados.descricaoDetalhada);
  el.inputDescricaoDetalhada.checked = descricaoDetalhada;
  traduzirPaginas = dados.traduzirPaginas !== false; // ligado por padrão
  el.inputTraduzir.checked = traduzirPaginas;
  lerAutomaticamente = dados.lerAutomaticamente !== false; // ligado por padrão
  el.inputLerAutomaticamente.checked = lerAutomaticamente;
  el.inputLerSemPainel.checked = dados.lerSemPainel !== false; // protótipo: ligado por padrão
  if (dados.velocidade) {
    el.inputVelocidade.value = dados.velocidade;
    el.valorVelocidade.textContent = `${Number(dados.velocidade).toFixed(1)}×`;
  }
  pronto();
}));

el.btnConfig.addEventListener("click", () => {
  const abrindo = el.painelConfig.classList.contains("oculto");
  el.painelConfig.classList.toggle("oculto");
  el.btnConfig.setAttribute("aria-expanded", String(abrindo));
});

el.btnSalvarKey.addEventListener("click", () => {
  apiKey = el.inputApiKey.value.trim() || null;
  descreverImagens = el.inputDescreverImagens.checked;
  descricaoDetalhada = el.inputDescricaoDetalhada.checked;
  traduzirPaginas = el.inputTraduzir.checked;
  lerAutomaticamente = el.inputLerAutomaticamente.checked;
  chrome.storage.local.set({
    anthropicApiKey: apiKey, descreverImagens, descricaoDetalhada, traduzirPaginas, lerAutomaticamente,
    lerSemPainel: el.inputLerSemPainel.checked, // usado pela leitura de fundo (leitura-fundo.js)
  });
  el.painelConfig.classList.add("oculto");
  el.btnConfig.setAttribute("aria-expanded", "false");
});

// ---------- extração de conteúdo ----------

el.btnExtrair.addEventListener("click", () => pedirLeitura());
el.btnTentarDeNovo.addEventListener("click", () => pedirLeitura());
el.btnLerDeNovo.addEventListener("click", lerDeNovo);

let imagensDaPagina = []; // endereços das imagens sem alt da última leitura
let textosDaPagina = []; // textos originais enviados para tradução na última leitura

async function lerDeNovo() {
  // Descarta as descrições guardadas das imagens desta página (nos dois
  // estilos, curto e detalhado) e as traduções, para a IA fazer tudo outra
  // vez, e extrai a página de novo (ela pode ter mudado desde a última leitura)
  const chaves = imagensDaPagina
    .flatMap((src) => ["curto", "detalhado"].map((detalhe) => `descricao:${detalhe}:${src}`))
    .concat(textosDaPagina.map((texto) => `traducao:${texto}`));
  if (chaves.length) await chrome.storage.session.remove(chaves);
  pedirLeitura();
}

// ---------- leitura automática ----------

// Uma extração por vez: a tradução e as descrições de imagem levam alguns
// segundos e mexem nas seções. Se a pessoa trocar de página no meio, a nova
// leitura espera a atual terminar (e a atual não chega a ser lida).
let extraindo = false;
let leituraPendente = null;

function pedirLeitura(opcoes = {}) {
  if (extraindo) {
    leituraPendente = opcoes;
    pararLeitura();
    return;
  }
  extraindo = true;
  iniciarExtracao(opcoes).finally(() => {
    extraindo = false;
    if (leituraPendente) {
      const proxima = leituraPendente;
      leituraPendente = null;
      pedirLeitura(proxima);
    }
  });
}

let minhaJanela = null; // o painel é de uma janela: só segue as abas dela
let esperaTroca = null;

function paginaSaindo(windowId) {
  // A pessoa saiu da página que estava sendo lida: cala na hora, sem
  // esperar a próxima carregar
  if (lerAutomaticamente && windowId === minhaJanela) pararLeitura();
}

function documentoDaAba(tabId) {
  return chrome.tabs
    .sendMessage(tabId, { tipo: "QUAL_DOCUMENTO" })
    .then((r) => (r && r.documentoId) || null)
    .catch(() => null);
}

function paginaMudou(windowId, tabId, { trocouDeAba = false } = {}) {
  if (!lerAutomaticamente || windowId !== minhaJanela) return;
  // Junta eventos em sequência (redirecionamentos, troca rápida de abas)
  clearTimeout(esperaTroca);
  esperaTroca = setTimeout(async () => {
    // "Carregou" de novo, mas é o mesmo documento (o site só mudou o
    // endereço): a leitura continua. Antes ela recomeçava a cada mudança e,
    // em sites que mudam o endereço sem parar, nunca saía do "Carregando".
    if (!trocouDeAba && tabId === abaDaLeitura) {
      const documento = await documentoDaAba(tabId);
      if (documento && documento === documentoDaLeitura) return;
    }
    pedirLeitura({ automatico: true });
  }, 700);
}

// Página nova na aba ativa, ou troca de aba
chrome.tabs.onUpdated.addListener((tabId, mudanca, aba) => {
  if (aba.active && mudanca.status === "complete") paginaMudou(aba.windowId, tabId);
});
chrome.tabs.onActivated.addListener((info) => {
  paginaSaindo(info.windowId);
  paginaMudou(info.windowId, info.tabId, { trocouDeAba: true });
});

// Alt+Shift+K (background.js): pausa ou continua de qualquer lugar
chrome.runtime.onMessage.addListener((msg, remetente) => {
  if (msg.tipo === "ALTERNAR_LEITURA" && !el.estadoLeitura.classList.contains("oculto")) alternarLeitura();
  if (msg.tipo === "ROLAGEM_USUARIO" && remetente.tab && remetente.tab.id === abaDaLeitura) {
    pularParaATela(msg.ids);
  }
  // A página lida saiu de verdade (outro endereço, recarregar): cala na hora
  if (msg.tipo === "PAGINA_SAINDO" && remetente.tab && remetente.tab.id === abaDaLeitura &&
      msg.documentoId === documentoDaLeitura) {
    paginaSaindo(remetente.tab.windowId);
  }
});

function pularParaATela(ids) {
  // A pessoa rolou a página: a leitura vai para o trecho que está no topo
  // da tela. Pausado, só muda o ponto de onde vai continuar.
  if (el.estadoLeitura.classList.contains("oculto")) return;
  for (const id of ids) {
    for (let s = 0; s < secoes.length; s++) {
      const t = trechosDaSecao(secoes[s]).findIndex((trecho) => trecho.id === id);
      if (t === -1) continue;
      if (s === indiceAtual && t === trechoAtual) return; // já está lendo este
      indiceAtual = s;
      trechoAtual = t;
      exibirSecaoAtual();
      if (falando) lerSecaoAtual(t);
      else destacarNaPagina(id);
      return;
    }
  }
}

// Ao abrir o painel (clique no ícone ou Alt+Shift+L), já lê a página atual.
// O Chrome não deixa extensões abrirem o painel sozinhas: é preciso um
// clique ou atalho, então "iniciar com o navegador" começa por aqui.
function conectarAoBackground() {
  // Avisa o background que o painel desta janela está aberto: a leitura de
  // fundo (painel fechado) se cala e deixa o painel ler. A conexão cai
  // sozinha quando o painel fecha; se cair porque o background foi
  // reiniciado pelo Chrome, reconecta.
  const porta = chrome.runtime.connect({ name: "painel" });
  porta.postMessage({ windowId: minhaJanela });
  porta.onDisconnect.addListener(() => setTimeout(conectarAoBackground, 500));
}

Promise.all([configuracaoCarregada, chrome.windows.getCurrent()]).then(([, janela]) => {
  minhaJanela = janela.id;
  conectarAoBackground();
  if (lerAutomaticamente) pedirLeitura({ automatico: true });
});

function mostrarFalha(motivo, automatico) {
  if (automatico) {
    // Na leitura automática (ex.: nova aba, página interna do Chrome) não
    // dispara alerta para o leitor de tela a cada troca: volta ao início
    el.estadoInicial.querySelector("p").textContent =
      `${motivo} Abra outra página para a leitura automática continuar.`;
    mostrarEstado("estadoInicial");
    return;
  }
  el.textoErro.textContent = motivo;
  mostrarEstado("estadoErro");
}

function extrairPagina() {
  return new Promise((resolve) => chrome.runtime.sendMessage({ tipo: "REQUEST_EXTRACT" }, resolve));
}

async function iniciarExtracao({ automatico = false } = {}) {
  pararLeitura();
  mostrarEstado("estadoCarregando");
  el.textoCarregando.textContent = "Extraindo conteúdo da página…";

  const resposta = await extrairPagina();
  if (!resposta || !resposta.ok) {
    mostrarFalha((resposta && resposta.motivo) || "Não foi possível ler esta página.", automatico);
    return;
  }

  // Mantém por enquanto as seções que só têm imagens: elas ganham texto
  // na etapa de descrição e só depois as vazias são descartadas
  errosDescricao = [];
  textosDaPagina = [];
  abaDaLeitura = resposta.tabId ?? null;
  documentoDaLeitura = resposta.documentoId || null;
  for (const secao of resposta.secoes) {
    secao.blocos = secao.blocos || (secao.texto ? [{ texto: secao.texto, id: null }] : []);
    secao.imagensSemAltIds = secao.imagensSemAltIds || [];
  }
  imagensDaPagina = resposta.secoes.flatMap((s) => s.imagensSemAlt || []);
  secoes = resposta.secoes.filter(
    (s) => (s.texto && s.texto.length > 0) || (s.imagensSemAlt && s.imagensSemAlt.length > 0)
  );

  if (secoes.length === 0) {
    mostrarFalha("Nenhum conteúdo legível foi encontrado nesta página.", automatico);
    return;
  }

  // Traduz antes do resto: a reestruturação e as descrições de imagem já
  // saem em português
  idiomaLeitura = "pt-BR";
  const idioma = await detectarIdioma(resposta);
  let traduzida = false;
  if (idioma !== "pt") {
    if (traduzirPaginas && URL_BACKEND) traduzida = await traduzirPagina(resposta, idioma);
    if (!traduzida) idiomaLeitura = idioma; // lê no original, com voz do idioma
  }

  if (apiKey) await reestruturarComIA();
  // As imagens com alt já viraram texto no content.js; só as sem alt vão para a IA
  const usarIA = descreverImagens && Boolean(URL_BACKEND);
  if (usarIA) await descreverImagensSemAlt();
  else avisarImagensSemDescricao();
  secoes = secoes.filter((s) => s.texto && s.texto.length > 0);
  // A pessoa já foi para outra página enquanto esta era preparada: não lê
  if (leituraPendente) return;

  el.tituloArtigo.textContent = resposta.titulo;
  el.metaArtigo.textContent = [
    resposta.autor,
    `~${resposta.tempoLeituraMin} min de leitura`,
    traduzida ? `traduzido do ${nomeDoIdioma(idioma)}` : idioma !== "pt" ? `lido em ${nomeDoIdioma(idioma)}` : null,
    apiKey ? "reestruturado por IA" : "texto original",
    usarIA ? "imagens sem alt descritas por IA" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  montarListaSecoes();
  mostrarDiagnostico();
  indiceAtual = 0;
  trechoAtual = 0;
  exibirSecaoAtual();
  mostrarEstado("estadoLeitura");
  // O botão "Ler esta página" sumiu: leva o foco para o play, senão ele
  // se perde no <body> e o usuário de teclado/leitor de tela fica sem rumo.
  // Na leitura automática o foco fica onde está (na página), senão cada
  // página aberta tiraria a pessoa do lugar.
  if (!automatico) el.btnPlayPause.focus();
  if (lerAutomaticamente) {
    // A voz já começa a ler; o anúncio falaria por cima dela
    alternarLeitura();
  } else {
    anunciar(
      `Conteúdo carregado: ${resposta.titulo}. ${secoes.length} ${secoes.length === 1 ? "seção" : "seções"}.`
    );
  }
}

// ---------- blocos: pedaços do texto ligados aos elementos da página ----------

function juntarTexto(secao) {
  // O texto da seção (mostrado no painel e enviado à IA) é a soma dos blocos
  secao.texto = secao.blocos.map((b) => b.texto).join(" ");
}

function acrescentarBloco(secao, texto, id = null) {
  secao.blocos.push({ texto, id });
  juntarTexto(secao);
}

function trechosDaSecao(secao) {
  // O que a voz fala, em trechos curtos, cada um com o id do elemento da
  // página de onde veio (para destacar e rolar até ele)
  const trechos = [];
  if (secao.titulo) trechos.push({ texto: `${secao.titulo}.`, id: secao.tituloId });
  for (const bloco of secao.blocos) {
    for (const texto of dividirEmTrechos(bloco.texto)) trechos.push({ texto, id: bloco.id });
  }
  return trechos;
}

function destacarNaPagina(id) {
  if (abaDaLeitura === null) return;
  chrome.tabs.sendMessage(abaDaLeitura, { tipo: "DESTACAR", id }).catch(() => {});
}

// ---------- tradução ----------

function detectarIdioma(resposta) {
  // O Chrome identifica o idioma pelo próprio texto, sem internet. O "lang"
  // do HTML só é usado se ele não tiver certeza: muitos sites o deixam
  // errado (ex.: "en" em página em português) ou vazio.
  const declarado = (resposta.idioma || "").split("-")[0].toLowerCase() || null;
  const amostra = [resposta.titulo, ...secoes.map((s) => `${s.titulo || ""} ${s.texto || ""}`)]
    .join(" ")
    .slice(0, 4000);
  return new Promise((resolve) => {
    if (!chrome.i18n.detectLanguage || amostra.trim().length < 20) return resolve(declarado || "pt");
    chrome.i18n.detectLanguage(amostra, (resultado) => {
      const melhor = resultado && resultado.languages && resultado.languages[0];
      if (resultado && resultado.isReliable && melhor && melhor.language !== "und") {
        resolve(melhor.language.split("-")[0].toLowerCase());
      } else {
        resolve(declarado || "pt");
      }
    });
  });
}

function nomeDoIdioma(codigo) {
  try {
    return new Intl.DisplayNames(["pt-BR"], { type: "language" }).of(codigo).toLowerCase();
  } catch {
    return codigo;
  }
}

async function traduzirPagina(resposta, idioma) {
  el.textoCarregando.textContent = `Traduzindo a página do ${nomeDoIdioma(idioma)} para o português…`;
  // Tudo num pedido só (o background divide em lotes): título da página e,
  // de cada seção, o título e cada bloco, nesta ordem. Bloco por bloco para
  // a tradução continuar ligada aos elementos da página (destaque e rolagem).
  const textos = [resposta.titulo || "", ...secoes.flatMap((s) => [s.titulo || "", ...s.blocos.map((b) => b.texto)])];
  const resultado = await pedirDescricao({ tipo: "TRADUZIR", textos, origem: idioma });
  if (!resultado || !resultado.ok) {
    // Sem tradução a página ainda é lida, no idioma original
    errosDescricao.push(`[tradução] ${(resultado && resultado.motivo) || "sem resposta do background"}`);
    return false;
  }
  textosDaPagina = textos.filter((t) => t.trim());
  const [titulo, ...resto] = resultado.traducoes;
  resposta.titulo = titulo;
  let i = 0;
  for (const secao of secoes) {
    const tituloTraduzido = resto[i++];
    if (secao.titulo) secao.titulo = tituloTraduzido;
    for (const bloco of secao.blocos) bloco.texto = resto[i++];
    juntarTexto(secao);
  }
  return true;
}

async function reestruturarComIA() {
  for (let i = 0; i < secoes.length; i++) {
    // Seção sem texto (só título ou só imagens): nada para reestruturar,
    // não gasta uma chamada de IA
    if (!secoes[i].texto || !secoes[i].texto.trim()) continue;
    el.textoCarregando.textContent = `Reestruturando com IA… (${i + 1}/${secoes.length})`;
    const resultado = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          tipo: "CALL_LLM",
          // Só o corpo: o título é falado à parte em lerSecaoAtual. Se fosse
          // junto, a resposta já viria com ele e o título seria lido 2 vezes.
          textoOriginal: secoes[i].texto,
          apiKey,
        },
        resolve
      );
    });
    // se a chamada falhar (ex: chave inválida), mantém o texto original
    // dessa seção e segue em frente, em vez de travar tudo
    if (resultado && resultado.ok) {
      // O texto reescrito não tem mais os blocos da página: fica um bloco
      // só, ligado ao começo da seção
      const primeiro = secoes[i].blocos.find((b) => b.id);
      secoes[i].blocos = [{ texto: resultado.texto, id: primeiro ? primeiro.id : secoes[i].tituloId }];
      juntarTexto(secoes[i]);
    }
  }
}

// ---------- descrição de imagens sem alt text ----------

const LIMITE_IMAGENS_POR_PAGINA = 8; // controla custo/latência das chamadas de visão

async function descreverImagensSemAlt() {
  let processadas = 0;

  for (const secao of secoes) {
    if (!secao.imagensSemAlt || secao.imagensSemAlt.length === 0) continue;

    for (const [j, src] of secao.imagensSemAlt.entries()) {
      if (processadas >= LIMITE_IMAGENS_POR_PAGINA) {
        acrescentarBloco(secao, "(Há mais imagens sem descrição nesta página além do limite processado.)");
        return;
      }
      processadas += 1;
      el.textoCarregando.textContent = `Descrevendo imagens sem texto alternativo… (${processadas})`;

      const descricao = await descreverPeloBackend(src);
      // Se falhar (imagem protegida, SVG, backend fora do ar, cota esgotada),
      // avisa que a imagem existe em vez de omiti-la e segue com o resto
      acrescentarBloco(
        secao,
        descricao ? `Imagem: ${descricao}` : "Imagem sem descrição: não foi possível analisá-la.",
        secao.imagensSemAltIds[j] || null
      );
    }
  }
}

const LADO_SVG = 768; // px: tamanho em que o SVG é desenhado antes de ir para a IA

function pedirDescricao(mensagem) {
  return new Promise((resolve) => chrome.runtime.sendMessage(mensagem, resolve));
}

async function svgParaPng(textoSvg) {
  // O background (service worker) não desenha SVG; esta página consegue.
  // Como <img>, scripts dentro do SVG não rodam.
  const url = URL.createObjectURL(new Blob([textoSvg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise((ok, falha) => {
      img.onload = ok;
      img.onerror = () => falha(new Error("SVG inválido"));
      img.src = url;
    });
    // SVG sem width/height não tem tamanho próprio: usa o padrão
    const largura = img.naturalWidth || LADO_SVG;
    const altura = img.naturalHeight || LADO_SVG;
    const escala = LADO_SVG / Math.max(largura, altura); // amplia ícones pequenos também
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(largura * escala);
    canvas.height = Math.round(altura * escala);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; // fundo transparente viraria preto no JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function descreverPeloBackend(src) {
  const detalhe = descricaoDetalhada ? "detalhado" : "curto";
  let resultado = await pedirDescricao({ tipo: "DESCREVER_IMAGEM", src, detalhe });

  if (resultado && !resultado.ok && resultado.svg) {
    try {
      const pngConvertido = await svgParaPng(resultado.svg);
      resultado = await pedirDescricao({ tipo: "DESCREVER_IMAGEM", src, detalhe, pngConvertido });
    } catch (erro) {
      resultado = { ok: false, motivo: `[converter o SVG] ${erro.message}` };
    }
  }

  if (resultado && resultado.ok) return resultado.descricao;
  // a mensagem já diz a etapa: baixar a imagem, falar com o backend, etc.
  const motivo = (resultado && resultado.motivo) || "sem resposta do background";
  console.error(`Leitor Acessível: falha na descrição de imagem: ${motivo}`, src);
  errosDescricao.push(motivo);
  return null;
}

function avisarImagensSemDescricao() {
  // Sem chave de API não dá pra gerar descrição — mas em vez de ficar
  // silenciosamente sem essa informação, avisa que ela existe e falta.
  for (const secao of secoes) {
    if (secao.imagensSemAlt && secao.imagensSemAlt.length > 0) {
      acrescentarBloco(secao, `(Esta seção contém ${secao.imagensSemAlt.length === 1 ? "uma imagem" : secao.imagensSemAlt.length + " imagens"} sem texto alternativo. Ative a descrição de imagens nas configurações para ouvi-la.)`);
    }
  }
}

// ---------- navegação entre seções ----------

function montarListaSecoes() {
  el.listaSecoes.innerHTML = "";
  secoes.forEach((secao, i) => {
    const botao = document.createElement("button");
    botao.className = "item-secao";
    botao.textContent = secao.titulo || `Trecho ${i + 1}`;
    botao.addEventListener("click", () => irPara(i));
    el.listaSecoes.appendChild(botao);
  });
}

function mostrarDiagnostico() {
  const unicos = [...new Set(errosDescricao)];
  el.diagnostico.textContent = unicos.length
    ? `Detalhes técnicos das falhas: ${unicos.join(" | ")}`
    : "";
  el.diagnostico.classList.toggle("oculto", unicos.length === 0);
}

function exibirSecaoAtual() {
  el.textoAtual.textContent = secoes[indiceAtual].texto;
  // Não move o foco para o texto: isso faria o leitor de tela ler a seção
  // inteira por cima da voz da extensão.
  Array.from(el.listaSecoes.children).forEach((botao, i) => {
    botao.setAttribute("aria-current", String(i === indiceAtual));
    if (i === indiceAtual) botao.scrollIntoView({ block: "nearest" });
  });
}

el.btnAnterior.addEventListener("click", () => irPara(indiceAtual - 1));
el.btnProxima.addEventListener("click", () => irPara(indiceAtual + 1));

function irPara(novoIndice) {
  if (novoIndice < 0 || novoIndice >= secoes.length) return;
  indiceAtual = novoIndice;
  trechoAtual = 0;
  exibirSecaoAtual();
  if (falando) {
    lerSecaoAtual();
  } else {
    // Pausado: a voz da extensão está calada, então só anuncia onde o
    // usuário chegou (curto), sem ler o conteúdo.
    const titulo = secoes[indiceAtual].titulo;
    anunciar(`Seção ${indiceAtual + 1} de ${secoes.length}${titulo ? ": " + titulo : ""}`);
  }
}

// ---------- síntese de voz ----------

el.btnPlayPause.addEventListener("click", alternarLeitura);
el.inputVelocidade.addEventListener("input", () => {
  el.valorVelocidade.textContent = `${Number(el.inputVelocidade.value).toFixed(1)}×`;
});
// A página inteira já está na fila da voz com a velocidade antiga: ao soltar
// o controle, refaz a fila a partir do trecho atual com a nova velocidade
el.inputVelocidade.addEventListener("change", () => {
  // Guarda para a próxima vez e para a leitura com o painel fechado
  chrome.storage.local.set({ velocidade: Number(el.inputVelocidade.value) });
  if (falando) lerSecaoAtual(trechoAtual);
});

function alternarLeitura() {
  if (falando) {
    pararLeitura();
  } else {
    falando = true;
    el.btnPlayPause.textContent = "⏸ Pausar";
    el.btnPlayPause.setAttribute("aria-label", "Pausar leitura");
    lerSecaoAtual(trechoAtual); // continua de onde parou
  }
}

function pararLeitura() {
  falando = false;
  geracaoFala += 1;
  chrome.tts.stop();
  el.btnPlayPause.textContent = "▶ Ler";
  el.btnPlayPause.setAttribute("aria-label", "Reproduzir leitura");
}

function lerSecaoAtual(trechoInicial = 0) {
  // Coloca de uma vez na fila da voz todos os trechos, da seção atual até o
  // fim da página. Antes cada trecho só era pedido quando o anterior
  // terminava, e a voz do sistema fazia uma pausa entre eles; com a fila
  // cheia ela emenda um no outro, como uma leitura contínua.
  // chrome.tts (voz das extensões) em vez da Web Speech API: o Chrome só
  // deixa uma página falar depois que o usuário clica nela, e a leitura
  // automática começa sem clique. As vozes são as mesmas do sistema.
  chrome.tts.stop();
  const geracao = ++geracaoFala;
  const velocidade = Number(el.inputVelocidade.value);
  let primeiro = true;

  for (let s = indiceAtual; s < secoes.length; s++) {
    const trechos = trechosDaSecao(secoes[s]);
    trechos.forEach((trecho, t) => {
      if (s === indiceAtual && t < trechoInicial) return;
      const ultimoDaPagina = s === secoes.length - 1 && t === trechos.length - 1;
      chrome.tts.speak(trecho.texto, {
        lang: idiomaLeitura,
        rate: velocidade,
        enqueue: !primeiro, // o primeiro substitui o que estiver falando
        onEvent: (evento) => {
          // Evento de uma fila que já foi cancelada (navegou/pausou): ignora
          if (geracao !== geracaoFala) return;
          if (evento.type === "start") {
            // A voz chegou neste trecho: acompanha no painel e na página
            // (destaca o trecho e rola até ele)
            trechoAtual = t;
            if (indiceAtual !== s) {
              indiceAtual = s;
              exibirSecaoAtual();
            }
            if (trecho.id) destacarNaPagina(trecho.id);
          } else if (ultimoDaPagina && (evento.type === "end" || evento.type === "error")) {
            trechoAtual = 0;
            pararLeitura();
            destacarNaPagina(null);
          }
        },
      });
      primeiro = false;
    });
  }
  if (primeiro) pararLeitura(); // nada para ler
}

// ---------- atalhos de teclado ----------

document.addEventListener("keydown", (evento) => {
  const tag = evento.target.tagName;
  const dentroDeCampo = ["INPUT", "TEXTAREA", "SELECT"].includes(tag);
  if (dentroDeCampo || el.estadoLeitura.classList.contains("oculto")) return;
  // Não rouba combinações do navegador/leitor de tela (ex: NVDA usa Insert/Ctrl)
  if (evento.ctrlKey || evento.altKey || evento.metaKey) return;
  // Em botões e links, Espaço é a ativação nativa: deixa o navegador agir
  if (evento.code === "Space" && ["BUTTON", "A"].includes(tag)) return;

  if (evento.code === "Space") {
    evento.preventDefault();
    alternarLeitura();
  } else if (evento.code === "ArrowLeft") {
    irPara(indiceAtual - 1);
  } else if (evento.code === "ArrowRight") {
    irPara(indiceAtual + 1);
  }
});
