// background.js (service worker)

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
      chrome.tabs.sendMessage(tabs[0].id, { tipo: "EXTRACT_CONTENT" }, (resposta) => {
        if (chrome.runtime.lastError) {
          sendResponse({
            ok: false,
            motivo:
              "Não foi possível acessar esta página (pode ser uma página interna do navegador, ou ela ainda não terminou de carregar).",
          });
          return;
        }
        sendResponse(resposta);
      });
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
    descreverImagem(msg.src, msg.apiKey)
      .then((descricao) => sendResponse({ ok: true, descricao }))
      .catch((erro) => sendResponse({ ok: false, motivo: erro.message }));
    return true; // resposta assíncrona
  }
});

async function descreverImagem(src, apiKey) {
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
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: src } },
            {
              type: "text",
              text:
                "Descreva esta imagem em até 2 frases curtas, como um texto alternativo (alt text) " +
                "para pessoa com deficiência visual. Seja objetivo: o que a imagem mostra e, se houver, " +
                "texto visível nela. Não comece com 'a imagem mostra' ou similar, vá direto ao conteúdo.",
            },
          ],
        },
      ],
    }),
  });

  if (!resposta.ok) {
    const corpo = await resposta.text();
    throw new Error(`Erro na API de visão (${resposta.status}): ${corpo.slice(0, 200)}`);
  }

  const dados = await resposta.json();
  const blocoTexto = dados.content.find((b) => b.type === "text");
  return blocoTexto ? blocoTexto.text.trim() : "Não foi possível descrever esta imagem.";
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
