// sidepanel.js

const el = {
  btnConfig: document.getElementById("btn-config"),
  painelConfig: document.getElementById("painel-config"),
  inputApiKey: document.getElementById("input-api-key"),
  inputDescreverImagens: document.getElementById("input-descrever-imagens"),
  inputDescricaoDetalhada: document.getElementById("input-descricao-detalhada"),
  btnSalvarKey: document.getElementById("btn-salvar-key"),

  estadoInicial: document.getElementById("estado-inicial"),
  estadoCarregando: document.getElementById("estado-carregando"),
  textoCarregando: document.getElementById("texto-carregando"),
  estadoErro: document.getElementById("estado-erro"),
  textoErro: document.getElementById("texto-erro"),
  estadoLeitura: document.getElementById("estado-leitura"),

  btnExtrair: document.getElementById("btn-extrair"),
  btnTentarDeNovo: document.getElementById("btn-tentar-de-novo"),

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
let errosDescricao = []; // motivos técnicos das falhas, mostrados (não falados) no painel
let geracaoFala = 0; // incrementa a cada nova leitura/parada: invalida callbacks de falas canceladas
let utteranceAtual = null; // referência viva evita que o Chrome descarte a fala e nunca dispare onend

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

chrome.storage.local.get(["anthropicApiKey", "descreverImagens", "descricaoDetalhada"], (dados) => {
  if (dados.anthropicApiKey) {
    apiKey = dados.anthropicApiKey;
    el.inputApiKey.value = dados.anthropicApiKey;
  }
  descreverImagens = dados.descreverImagens !== false; // ligado por padrão
  el.inputDescreverImagens.checked = descreverImagens;
  descricaoDetalhada = Boolean(dados.descricaoDetalhada);
  el.inputDescricaoDetalhada.checked = descricaoDetalhada;
});

el.btnConfig.addEventListener("click", () => {
  const abrindo = el.painelConfig.classList.contains("oculto");
  el.painelConfig.classList.toggle("oculto");
  el.btnConfig.setAttribute("aria-expanded", String(abrindo));
});

el.btnSalvarKey.addEventListener("click", () => {
  apiKey = el.inputApiKey.value.trim() || null;
  descreverImagens = el.inputDescreverImagens.checked;
  descricaoDetalhada = el.inputDescricaoDetalhada.checked;
  chrome.storage.local.set({ anthropicApiKey: apiKey, descreverImagens, descricaoDetalhada });
  el.painelConfig.classList.add("oculto");
  el.btnConfig.setAttribute("aria-expanded", "false");
});

// ---------- extração de conteúdo ----------

el.btnExtrair.addEventListener("click", iniciarExtracao);
el.btnTentarDeNovo.addEventListener("click", iniciarExtracao);

function iniciarExtracao() {
  pararLeitura();
  mostrarEstado("estadoCarregando");
  el.textoCarregando.textContent = "Extraindo conteúdo da página…";

  chrome.runtime.sendMessage({ tipo: "REQUEST_EXTRACT" }, async (resposta) => {
    if (!resposta || !resposta.ok) {
      el.textoErro.textContent =
        (resposta && resposta.motivo) || "Não foi possível ler esta página.";
      mostrarEstado("estadoErro");
      return;
    }

    // Mantém por enquanto as seções que só têm imagens: elas ganham texto
    // na etapa de descrição e só depois as vazias são descartadas
    errosDescricao = [];
    secoes = resposta.secoes.filter(
      (s) => (s.texto && s.texto.length > 0) || (s.imagensSemAlt && s.imagensSemAlt.length > 0)
    );

    if (secoes.length === 0) {
      el.textoErro.textContent = "Nenhum conteúdo legível foi encontrado nesta página.";
      mostrarEstado("estadoErro");
      return;
    }

    if (apiKey) await reestruturarComIA();
    // As imagens com alt já viraram texto no content.js; só as sem alt vão para a IA
    const usarIA = descreverImagens && Boolean(URL_BACKEND);
    if (usarIA) await descreverImagensSemAlt();
    else avisarImagensSemDescricao();
    secoes = secoes.filter((s) => s.texto && s.texto.length > 0);

    el.tituloArtigo.textContent = resposta.titulo;
    el.metaArtigo.textContent = [
      resposta.autor,
      `~${resposta.tempoLeituraMin} min de leitura`,
      apiKey ? "reestruturado por IA" : "texto original",
      usarIA ? "imagens sem alt descritas por IA" : null,
    ]
      .filter(Boolean)
      .join(" · ");

    montarListaSecoes();
    mostrarDiagnostico();
    indiceAtual = 0;
    exibirSecaoAtual();
    mostrarEstado("estadoLeitura");
    // O botão "Ler esta página" sumiu: leva o foco para o play, senão ele
    // se perde no <body> e o usuário de teclado/leitor de tela fica sem rumo
    el.btnPlayPause.focus();
    anunciar(
      `Conteúdo carregado: ${resposta.titulo}. ${secoes.length} ${secoes.length === 1 ? "seção" : "seções"}.`
    );
  });
}

async function reestruturarComIA() {
  for (let i = 0; i < secoes.length; i++) {
    el.textoCarregando.textContent = `Reestruturando com IA… (${i + 1}/${secoes.length})`;
    const resultado = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          tipo: "CALL_LLM",
          textoOriginal: (secoes[i].titulo ? secoes[i].titulo + ". " : "") + secoes[i].texto,
          apiKey,
        },
        resolve
      );
    });
    // se a chamada falhar (ex: chave inválida), mantém o texto original
    // dessa seção e segue em frente, em vez de travar tudo
    if (resultado && resultado.ok) {
      secoes[i].texto = resultado.texto;
    }
  }
}

// ---------- descrição de imagens sem alt text ----------

const LIMITE_IMAGENS_POR_PAGINA = 8; // controla custo/latência das chamadas de visão

async function descreverImagensSemAlt() {
  let processadas = 0;

  for (const secao of secoes) {
    if (!secao.imagensSemAlt || secao.imagensSemAlt.length === 0) continue;

    for (const src of secao.imagensSemAlt) {
      if (processadas >= LIMITE_IMAGENS_POR_PAGINA) {
        secao.texto += " (Há mais imagens sem descrição nesta página além do limite processado.)";
        return;
      }
      processadas += 1;
      el.textoCarregando.textContent = `Descrevendo imagens sem texto alternativo… (${processadas})`;

      const descricao = await descreverPeloBackend(src);
      // Se falhar (imagem protegida, SVG, backend fora do ar, cota esgotada),
      // avisa que a imagem existe em vez de omiti-la e segue com o resto
      secao.texto += descricao
        ? ` Imagem: ${descricao}`
        : " Imagem sem descrição: não foi possível analisá-la.";
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
      secao.texto += ` (Esta seção contém ${secao.imagensSemAlt.length === 1 ? "uma imagem" : secao.imagensSemAlt.length + " imagens"} sem texto alternativo. Ative a descrição de imagens nas configurações para ouvi-la.)`;
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
    ? `Detalhes técnicos da falha na descrição: ${unicos.join(" | ")}`
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

function alternarLeitura() {
  if (falando) {
    pararLeitura();
  } else {
    falando = true;
    el.btnPlayPause.textContent = "⏸ Pausar";
    el.btnPlayPause.setAttribute("aria-label", "Pausar leitura");
    lerSecaoAtual();
  }
}

function pararLeitura() {
  falando = false;
  geracaoFala += 1;
  speechSynthesis.cancel();
  el.btnPlayPause.textContent = "▶ Ler";
  el.btnPlayPause.setAttribute("aria-label", "Reproduzir leitura");
}

const TAMANHO_MAX_TRECHO = 200;

function dividirEmTrechos(texto) {
  // O Chrome corta falas longas (~15s) em várias vozes, então a seção é
  // lida em trechos curtos, preferindo quebrar no fim das frases.
  const frases = texto.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)\s*/g) || [texto];
  const trechos = [];
  let atual = "";

  function empurrar(pedaco) {
    if ((atual + pedaco).length > TAMANHO_MAX_TRECHO && atual) {
      trechos.push(atual.trim());
      atual = "";
    }
    atual += pedaco;
  }

  for (const frase of frases) {
    if (frase.length <= TAMANHO_MAX_TRECHO) {
      empurrar(frase);
    } else {
      // frase gigante (ex: lista sem pontuação): quebra por palavras
      for (const palavra of frase.split(/(?<=\s)/)) empurrar(palavra);
    }
  }
  if (atual.trim()) trechos.push(atual.trim());
  return trechos;
}

function lerSecaoAtual() {
  speechSynthesis.cancel();
  const geracao = ++geracaoFala;
  const secao = secoes[indiceAtual];
  if (!secao) return;

  const trechos = dividirEmTrechos((secao.titulo ? secao.titulo + ". " : "") + secao.texto);
  let proximo = 0;

  function falarProximoTrecho() {
    // Callback de uma leitura que já foi cancelada (navegou/pausou): ignora,
    // senão ela avançaria de seção sozinha.
    if (geracao !== geracaoFala || !falando) return;

    if (proximo >= trechos.length) {
      if (indiceAtual < secoes.length - 1) {
        indiceAtual += 1;
        exibirSecaoAtual();
        lerSecaoAtual();
      } else {
        pararLeitura();
      }
      return;
    }

    const utter = new SpeechSynthesisUtterance(trechos[proximo++]);
    utter.lang = "pt-BR";
    // lida a cada trecho: mudar a velocidade vale a partir da próxima frase
    utter.rate = Number(el.inputVelocidade.value);
    utter.onend = falarProximoTrecho;
    utter.onerror = (evento) => {
      // "interrupted"/"canceled" vêm do nosso próprio cancel(); outros erros
      // pulam o trecho em vez de travar a leitura
      if (evento.error !== "interrupted" && evento.error !== "canceled") falarProximoTrecho();
    };
    utteranceAtual = utter;
    speechSynthesis.speak(utter);
  }

  falarProximoTrecho();
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
