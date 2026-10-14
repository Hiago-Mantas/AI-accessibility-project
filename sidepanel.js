// sidepanel.js

const el = {
  btnConfig: document.getElementById("btn-config"),
  painelConfig: document.getElementById("painel-config"),
  inputApiKey: document.getElementById("input-api-key"),
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

chrome.storage.local.get(["anthropicApiKey"], (dados) => {
  if (dados.anthropicApiKey) {
    apiKey = dados.anthropicApiKey;
    el.inputApiKey.value = dados.anthropicApiKey;
  }
});

el.btnConfig.addEventListener("click", () => {
  const abrindo = el.painelConfig.classList.contains("oculto");
  el.painelConfig.classList.toggle("oculto");
  el.btnConfig.setAttribute("aria-expanded", String(abrindo));
});

el.btnSalvarKey.addEventListener("click", () => {
  apiKey = el.inputApiKey.value.trim() || null;
  chrome.storage.local.set({ anthropicApiKey: apiKey });
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

    secoes = resposta.secoes.filter((s) => s.texto && s.texto.length > 0);

    if (secoes.length === 0) {
      el.textoErro.textContent = "Nenhum conteúdo legível foi encontrado nesta página.";
      mostrarEstado("estadoErro");
      return;
    }

    if (apiKey) {
      await reestruturarComIA();
      await descreverImagensSemAlt();
    } else {
      avisarImagensSemDescricao();
    }

    el.tituloArtigo.textContent = resposta.titulo;
    el.metaArtigo.textContent = [
      resposta.autor,
      `~${resposta.tempoLeituraMin} min de leitura`,
      apiKey ? "reestruturado por IA" : "texto original",
    ]
      .filter(Boolean)
      .join(" · ");

    montarListaSecoes();
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

      const resultado = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ tipo: "DESCREVER_IMAGEM", src, apiKey }, resolve);
      });

      if (resultado && resultado.ok) {
        secao.texto += ` Imagem: ${resultado.descricao}`;
      }
      // se falhar (ex: imagem protegida por login), simplesmente segue sem
      // travar a leitura do resto da seção
    }
  }
}

function avisarImagensSemDescricao() {
  // Sem chave de API não dá pra gerar descrição — mas em vez de ficar
  // silenciosamente sem essa informação, avisa que ela existe e falta.
  for (const secao of secoes) {
    if (secao.imagensSemAlt && secao.imagensSemAlt.length > 0) {
      secao.texto += ` (Esta seção contém ${secao.imagensSemAlt.length === 1 ? "uma imagem" : secao.imagensSemAlt.length + " imagens"} sem texto alternativo. Configure uma chave de API para gerar a descrição automaticamente.)`;
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
  speechSynthesis.cancel();
  el.btnPlayPause.textContent = "▶ Ler";
  el.btnPlayPause.setAttribute("aria-label", "Reproduzir leitura");
}

function lerSecaoAtual() {
  speechSynthesis.cancel();
  if (!secoes[indiceAtual]) return;

  const texto = (secoes[indiceAtual].titulo ? secoes[indiceAtual].titulo + ". " : "") +
    secoes[indiceAtual].texto;
  const utter = new SpeechSynthesisUtterance(texto);
  utter.lang = "pt-BR";
  utter.rate = Number(el.inputVelocidade.value);

  utter.onend = () => {
    if (falando && indiceAtual < secoes.length - 1) {
      indiceAtual += 1;
      exibirSecaoAtual();
      lerSecaoAtual();
    } else {
      pararLeitura();
    }
  };

  speechSynthesis.speak(utter);
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
