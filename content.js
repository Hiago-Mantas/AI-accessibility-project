// content.js
// Roda em toda página. Espera por uma mensagem "EXTRACT_CONTENT" vinda do
// side panel (via background) e responde com o conteúdo já limpo e
// dividido em seções navegáveis.

function imagemEhDecorativa(img) {
  // Heurística simples para não gastar chamada de API com ícones/separadores:
  // imagem pequena ou explicitamente marcada como decorativa/oculta.
  if (img.getAttribute("role") === "presentation" || img.getAttribute("aria-hidden") === "true") {
    return true;
  }
  const largura = img.naturalWidth || parseInt(img.getAttribute("width") || "0", 10);
  const altura = img.naturalHeight || parseInt(img.getAttribute("height") || "0", 10);
  if (largura && altura && (largura < 48 || altura < 48)) return true;
  return false;
}

function extrairSecoes(htmlLimpo) {
  // Transforma o HTML já limpo pelo Readability em uma lista de seções
  // usando os headings como pontos de corte. Isso permite navegação
  // "próxima seção / seção anterior", igual leitores de tela tradicionais.
  const container = document.createElement("div");
  container.innerHTML = htmlLimpo;

  const secoes = [];
  let atual = { titulo: null, textos: [], imagensSemAlt: [] };

  const nos = Array.from(
    container.querySelectorAll("h1, h2, h3, h4, p, li, blockquote, img")
  );

  function fecharSecao() {
    if (atual.titulo || atual.textos.length || atual.imagensSemAlt.length) {
      secoes.push({
        titulo: atual.titulo,
        texto: atual.textos.join(" "),
        imagensSemAlt: atual.imagensSemAlt,
      });
    }
  }

  if (nos.length === 0) {
    // fallback: sem estrutura nenhuma, pega o texto puro
    const texto = container.textContent.trim();
    if (texto) secoes.push({ titulo: null, texto, imagensSemAlt: [] });
    return secoes;
  }

  for (const no of nos) {
    const tag = no.tagName.toLowerCase();

    if (tag === "img") {
      const alt = (no.getAttribute("alt") || "").trim();
      if (alt) {
        // já tem alt text: só incorpora como texto, sem gastar chamada de IA
        atual.textos.push(`Imagem: ${alt}.`);
      } else if (!imagemEhDecorativa(no) && no.src) {
        atual.imagensSemAlt.push(no.src);
      }
      continue;
    }

    const texto = no.textContent.replace(/\s+/g, " ").trim();
    if (!texto) continue;

    if (/^h[1-4]$/.test(tag)) {
      fecharSecao();
      atual = { titulo: texto, textos: [], imagensSemAlt: [] };
    } else {
      atual.textos.push(texto);
    }
  }
  fecharSecao();

  return secoes;
}

function extrairConteudoPagina() {
  // Readability.js exige um clone do documento (ele modifica o DOM que recebe)
  const clone = document.cloneNode(true);
  const reader = new Readability(clone, { charThreshold: 100 });
  const artigo = reader.parse();

  if (!artigo || !artigo.content) {
    return {
      ok: false,
      motivo: "Não foi possível identificar um conteúdo principal legível nesta página.",
    };
  }

  const secoes = extrairSecoes(artigo.content);

  return {
    ok: true,
    titulo: artigo.title || document.title,
    autor: artigo.byline || null,
    tempoLeituraMin: Math.max(1, Math.round((artigo.length || 0) / 1000)),
    secoes,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.tipo === "EXTRACT_CONTENT") {
    try {
      const resultado = extrairConteudoPagina();
      sendResponse(resultado);
    } catch (erro) {
      sendResponse({ ok: false, motivo: "Erro ao processar a página: " + erro.message });
    }
  }
  return true; // resposta assíncrona
});
