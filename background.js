// background.js (service worker)

importScripts("config.js", "fala.js", "leitura-fundo.js"); // URL_BACKEND, dividirEmTrechos, leitura com o painel fechado

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Permite abrir o painel lateral clicando no ícone (comportamento padrão MV3).
// O atalho Alt+Shift+L (_execute_action no manifest) faz o mesmo que o clique.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Alt+Shift+K: pausa ou continua a leitura sem precisar levar o foco até o
// painel (útil com a leitura automática, enquanto a pessoa navega na página).
// Com o painel fechado, quem responde é a leitura de fundo (leitura-fundo.js).
chrome.commands.onCommand.addListener((comando, tab) => {
  if (comando !== "alternar-leitura") return;
  if (tab && painelAbertoNaJanela(tab.windowId)) {
    chrome.runtime.sendMessage({ tipo: "ALTERNAR_LEITURA" }).catch(() => {});
  } else {
    alternarLeituraDeFundo(tab);
  }
});

// Ponte: o side panel não tem acesso direto ao DOM da página, então pede
// ao background para repassar a extração ao content script da aba ativa.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.tipo === "REQUEST_EXTRACT") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) {
        sendResponse({ ok: false, motivo: "Nenhuma aba ativa encontrada." });
        return;
      }
      // tabId: o painel usa para destacar na página o trecho que está lendo
      extrairDaAba(tabs[0].id, tabs[0].url).then((resposta) => sendResponse(resposta && { ...resposta, tabId: tabs[0].id }));
    });
    return true; // resposta assíncrona
  }

  if (msg.tipo === "CALL_LLM") {
    chamarClaude(msg.textoOriginal, msg.apiKey)
      .then((textoLimpo) => sendResponse({ ok: true, texto: textoLimpo }))
      .catch((erro) => sendResponse({ ok: false, motivo: erro.message }));
    return true; // resposta assíncrona
  }

  if (msg.tipo === "TRADUZIR") {
    traduzirTextos(msg.textos, msg.origem)
      .then((traducoes) => sendResponse({ ok: true, traducoes }))
      .catch((erro) => sendResponse({ ok: false, motivo: erro.message }));
    return true; // resposta assíncrona
  }

  if (msg.tipo === "DESCREVER_IMAGEM") {
    descreverImagem(msg.src, msg.detalhe === "detalhado" ? "detalhado" : "curto", msg.pngConvertido)
      .then((descricao) => sendResponse({ ok: true, descricao }))
      // svg: o painel converte para PNG e pede de novo (ver descreverPeloBackend)
      .catch((erro) => sendResponse({ ok: false, motivo: erro.message, svg: erro.svg }));
    return true; // resposta assíncrona
  }
});

function documentoDaAba(tabId) {
  // Identidade do documento aberto na aba (ver ID_DOCUMENTO no content.js);
  // null se a aba não tem o content script (página interna, ainda carregando)
  return chrome.tabs
    .sendMessage(tabId, { tipo: "QUAL_DOCUMENTO" })
    .then((r) => (r && r.documentoId) || null)
    .catch(() => null);
}

function pedirExtracao(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { tipo: "EXTRACT_CONTENT" }, (resposta) => {
      // lastError precisa ser lido, senão o Chrome registra erro no console
      resolve(chrome.runtime.lastError ? null : resposta);
    });
  });
}

const MOTIVO_PAGINA_INTERNA =
  "Não foi possível acessar esta página. Páginas internas do navegador (como chrome:// e a Chrome Web Store) não podem ser lidas por extensões.";
const MOTIVO_ARQUIVO_LOCAL =
  'Para ler arquivos do seu computador (endereço file:///), ative "Permitir acesso a URLs de arquivo": ' +
  'abra chrome://extensions, clique em "Detalhes" no Leitor Acessível e ligue essa opção.';

async function motivoDaFalha(url) {
  // Sem a permissão de arquivos, o Chrome esconde o endereço da aba de um
  // arquivo local (url fica vazia), então não dá para ter certeza: se a
  // permissão está desligada, explica como ligá-la junto com o aviso geral
  if (url && url.startsWith("file:")) return MOTIVO_ARQUIVO_LOCAL;
  if (!url && !(await chrome.extension.isAllowedFileSchemeAccess())) {
    return `${MOTIVO_PAGINA_INTERNA} Se for um arquivo do seu computador: ${MOTIVO_ARQUIVO_LOCAL}`;
  }
  return MOTIVO_PAGINA_INTERNA;
}

async function extrairDaAba(tabId, url) {
  let resposta = await pedirExtracao(tabId);
  if (resposta) return resposta;

  // Abas que já estavam abertas antes de instalar/recarregar a extensão não
  // recebem o content script automaticamente: injeta agora e tenta de novo.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["readability.js", "content.js"],
    });
    resposta = await pedirExtracao(tabId);
    if (resposta) return resposta;
  } catch (erro) {
    // Páginas internas (chrome://, Web Store, visualizador de PDF) não
    // permitem injeção: cai na mensagem abaixo
  }

  return { ok: false, motivo: await motivoDaFalha(url) };
}

// ---------- descrição de imagens sem alt text (backend + Gemini) ----------

const LADO_MAX_IMAGEM = 768; // px: o Gemini usa resolução baixa, mandar maior só gasta banda

function falhaNaEtapa(etapa, erro) {
  return new Error(`[${etapa}] ${(erro && erro.message) || erro}`);
}

function paraBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binario = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binario += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binario);
}

function resumirEndereco(src) {
  // Só para o diagnóstico: mostra o tipo e o fim do endereço, sem poluir
  if (src.startsWith("data:")) return src.slice(0, src.indexOf(",")).slice(0, 30);
  if (src.startsWith("blob:")) return "blob: (imagem gerada pela página)";
  try {
    const url = new URL(src);
    const arquivo = url.pathname.split("/").pop().slice(0, 40);
    return url.protocol === "file:" ? `arquivo local …/${arquivo}` : `${url.host}/…/${arquivo}`;
  } catch {
    return src.slice(0, 50);
  }
}

function pedirImagemAPagina(src) {
  // Plano B: o content script lê a imagem de dentro da página (ver
  // lerImagemNaPagina em content.js) e devolve como data URL
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return reject(new Error("aba não encontrada"));
      chrome.tabs.sendMessage(tabs[0].id, { tipo: "LER_IMAGEM", src }, (resposta) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resposta || !resposta.ok) return reject(new Error((resposta && resposta.motivo) || "sem resposta"));
        resolve(resposta.dataUrl);
      });
    });
  });
}

async function baixarImagem(src) {
  // 1ª tentativa: daqui do background, que pode acessar qualquer site
  let falhaDireta;
  try {
    const resposta = await fetch(src);
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
    return await resposta.blob();
  } catch (erro) {
    falhaDireta = erro;
  }
  // 2ª tentativa: pela própria página (blob:, imagem que exige estar no site)
  try {
    const dataUrl = await pedirImagemAPagina(src);
    return await (await fetch(dataUrl)).blob();
  } catch (erro) {
    throw falhaNaEtapa(
      "baixar a imagem",
      `${resumirEndereco(src)}: direto: ${falhaDireta.message}; pela página: ${erro.message}`
    );
  }
}

function pareceSvg(blob, src) {
  return /svg/i.test(blob.type) || /^data:image\/svg/i.test(src) || /\.svg(\?|#|$)/i.test(src);
}

async function prepararImagem(src, pngConvertido) {
  // Baixa no navegador (funciona com sites que bloqueiam acesso externo e
  // com arquivos locais) e reduz para JPEG antes de enviar ao backend.
  // pngConvertido: SVG que o painel já desenhou e transformou em PNG.
  const blob = pngConvertido ? await (await fetch(pngConvertido)).blob() : await baixarImagem(src);

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (erro) {
    if (!pngConvertido && pareceSvg(blob, src)) {
      // O service worker não consegue desenhar SVG (e o Gemini não aceita
      // SVG): devolve o conteúdo para o painel converter em PNG
      const falha = falhaNaEtapa("converter o SVG", "o painel precisa desenhá-lo");
      falha.svg = await blob.text();
      throw falha;
    }
    throw falhaNaEtapa("abrir a imagem (formato não suportado)", erro);
  }
  const escala = Math.min(1, LADO_MAX_IMAGEM / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(bitmap.width * escala)),
    Math.max(1, Math.round(bitmap.height * escala))
  );
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  return paraBase64(await jpeg.arrayBuffer());
}

async function descreverImagem(src, detalhe, pngConvertido) {
  if (!URL_BACKEND) throw new Error("Backend não configurado (config.js).");

  // A mesma imagem costuma aparecer de novo (recarregar a página, voltar
  // nela): reaproveita a descrição em vez de gastar tokens outra vez
  const chaveCache = src.length <= 2000 ? `descricao:${detalhe}:${src}` : null;
  if (chaveCache) {
    const guardado = await chrome.storage.session.get(chaveCache);
    if (guardado[chaveCache]) return guardado[chaveCache];
  }

  const imagem = await prepararImagem(src, pngConvertido);

  let resposta;
  try {
    resposta = await fetch(`${URL_BACKEND}/descrever`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imagem, tipo: "image/jpeg", detalhe }),
    });
  } catch (erro) {
    throw falhaNaEtapa("falar com o backend (ele está rodando?)", erro);
  }
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw falhaNaEtapa("backend", dados.erro || `HTTP ${resposta.status}`);

  if (chaveCache) await chrome.storage.session.set({ [chaveCache]: dados.descricao });
  return dados.descricao;
}

// Lotes menores que o limite do backend (60 textos / 12.000 caracteres)
const LOTE_MAX_TEXTOS = 40;
const LOTE_MAX_CARACTERES = 6000;
const LOTES_EM_PARALELO = 3;

function montarLotes(textos) {
  const lotes = [];
  let atual = [];
  let caracteres = 0;
  for (const texto of textos) {
    if (atual.length && (atual.length >= LOTE_MAX_TEXTOS || caracteres + texto.length > LOTE_MAX_CARACTERES)) {
      lotes.push(atual);
      atual = [];
      caracteres = 0;
    }
    atual.push(texto);
    caracteres += texto.length;
  }
  if (atual.length) lotes.push(atual);
  return lotes;
}

function quebrarTextoLongo(texto) {
  // Um texto maior que o lote é dividido em frases para caber
  if (texto.length <= LOTE_MAX_CARACTERES) return [texto];
  const frases = texto.match(/[^.!?]+[.!?]*\s*/g) || [texto];
  const partes = [];
  let atual = "";
  for (const frase of frases) {
    if (atual && (atual + frase).length > LOTE_MAX_CARACTERES) {
      partes.push(atual);
      atual = "";
    }
    // frase sozinha maior que o lote (texto sem pontuação): corta no tamanho
    for (let i = 0; i < frase.length; i += LOTE_MAX_CARACTERES) {
      const pedaco = frase.slice(i, i + LOTE_MAX_CARACTERES);
      if (atual && (atual + pedaco).length > LOTE_MAX_CARACTERES) {
        partes.push(atual);
        atual = "";
      }
      atual += pedaco;
    }
  }
  if (atual) partes.push(atual);
  return partes;
}

async function traduzirTextos(textos, origem) {
  // Traduz para o português. Textos já traduzidos nesta sessão do navegador
  // vêm do cache (sem gastar tokens); os outros vão ao backend em lotes.
  if (!URL_BACKEND) throw new Error("Backend não configurado (config.js).");
  const chave = (texto) => (texto.length <= 2000 ? `traducao:${texto}` : null);
  const chaves = textos.map(chave).filter(Boolean);
  const guardados = chaves.length ? await chrome.storage.session.get(chaves) : {};
  const resultado = textos.map((t) => (chave(t) && guardados[chave(t)]) || null);

  // Textos que faltam, quebrados em partes se forem grandes demais
  const pendentes = []; // { indice, partes }
  textos.forEach((texto, i) => {
    if (resultado[i] === null && texto.trim()) pendentes.push({ indice: i, partes: quebrarTextoLongo(texto) });
    else if (resultado[i] === null) resultado[i] = texto;
  });
  const todasAsPartes = [...new Set(pendentes.flatMap((p) => p.partes))];
  const traduzidas = new Map();

  async function traduzirLote(lote) {
    let resposta;
    try {
      resposta = await fetch(`${URL_BACKEND}/traduzir`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ textos: lote, origem }),
      });
    } catch (erro) {
      throw falhaNaEtapa("falar com o backend (ele está rodando?)", erro);
    }
    const dados = await resposta.json().catch(() => ({}));
    if (!resposta.ok) throw falhaNaEtapa("backend", dados.erro || `HTTP ${resposta.status}`);
    lote.forEach((parte, i) => traduzidas.set(parte, dados.traducoes[i]));
  }

  // Até LOTES_EM_PARALELO pedidos ao mesmo tempo: a página vai bloco por
  // bloco (para o destaque acompanhar o áudio) e pode dar vários lotes
  const lotes = montarLotes(todasAsPartes);
  let proximo = 0;
  async function trabalhador() {
    while (proximo < lotes.length) await traduzirLote(lotes[proximo++]);
  }
  await Promise.all(Array.from({ length: Math.min(LOTES_EM_PARALELO, lotes.length) }, trabalhador));

  const paraGuardar = {};
  for (const { indice, partes } of pendentes) {
    resultado[indice] = partes.map((p) => traduzidas.get(p)).join(" ");
    if (chave(textos[indice])) paraGuardar[chave(textos[indice])] = resultado[indice];
  }
  if (Object.keys(paraGuardar).length) await chrome.storage.session.set(paraGuardar);
  return resultado;
}

async function chamarClaude(textoOriginal, apiKey) {
  if (!apiKey) {
    throw new Error("Nenhuma chave de API configurada.");
  }

  const resposta = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system:
        "Você reestrutura trechos de texto extraídos de páginas web para leitura em voz alta por pessoas com deficiência visual. " +
        "Reescreva o texto recebido em frases curtas e claras, na ordem lógica de leitura, removendo ruído " +
        "(like 'clique aqui', menus, repetições). Não invente informação nova. Não use markdown. Responda só com o texto final.",
      messages: [{ role: "user", content: textoOriginal }],
    }),
  });

  if (!resposta.ok) {
    const corpo = await resposta.text();
    throw new Error(`Erro na API (${resposta.status}): ${corpo.slice(0, 200)}`);
  }

  const dados = await resposta.json();
  const blocoTexto = dados.content.find((b) => b.type === "text");
  return blocoTexto ? blocoTexto.text : textoOriginal;
}
