// background.js (service worker)

importScripts("config.js"); // URL_BACKEND

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Permite abrir o painel lateral clicando no ícone (comportamento padrão MV3)
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Ponte: o side panel não tem acesso direto ao DOM da página, então pede
// ao background para repassar a extração ao content script da aba ativa.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.tipo === "REQUEST_EXTRACT") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) {
        sendResponse({ ok: false, motivo: "Nenhuma aba ativa encontrada." });
        return;
      }
      extrairDaAba(tabs[0].id).then(sendResponse);
    });
    return true; // resposta assíncrona
  }

  if (msg.tipo === "CALL_LLM") {
    chamarClaude(msg.textoOriginal, msg.apiKey)
      .then((textoLimpo) => sendResponse({ ok: true, texto: textoLimpo }))
      .catch((erro) => sendResponse({ ok: false, motivo: erro.message }));
    return true; // resposta assíncrona
  }

  if (msg.tipo === "DESCREVER_IMAGEM") {
    descreverImagem(msg.src, msg.detalhe === "detalhado" ? "detalhado" : "curto")
      .then((descricao) => sendResponse({ ok: true, descricao }))
      .catch((erro) => sendResponse({ ok: false, motivo: erro.message }));
    return true; // resposta assíncrona
  }
});

function pedirExtracao(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { tipo: "EXTRACT_CONTENT" }, (resposta) => {
      // lastError precisa ser lido, senão o Chrome registra erro no console
      resolve(chrome.runtime.lastError ? null : resposta);
    });
  });
}

async function extrairDaAba(tabId) {
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

  return {
    ok: false,
    motivo:
      "Não foi possível acessar esta página. Páginas internas do navegador (como chrome:// e a Chrome Web Store) não podem ser lidas por extensões.",
  };
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

async function prepararImagem(src) {
  // Baixa no navegador (funciona com sites que bloqueiam acesso externo e
  // com arquivos locais) e reduz para JPEG antes de enviar ao backend
  const blob = await baixarImagem(src);

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (erro) {
    throw falhaNaEtapa("abrir a imagem (formato não suportado, ex.: SVG?)", erro);
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

async function descreverImagem(src, detalhe) {
  if (!URL_BACKEND) throw new Error("Backend não configurado (config.js).");

  // A mesma imagem costuma aparecer de novo (recarregar a página, voltar
  // nela): reaproveita a descrição em vez de gastar tokens outra vez
  const chaveCache = src.length <= 2000 ? `descricao:${detalhe}:${src}` : null;
  if (chaveCache) {
    const guardado = await chrome.storage.session.get(chaveCache);
    if (guardado[chaveCache]) return guardado[chaveCache];
  }

  const imagem = await prepararImagem(src);

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
