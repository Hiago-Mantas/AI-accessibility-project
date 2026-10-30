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

// alt "de enfeite" que não descreve nada: melhor tratar como ausente e
// deixar a IA descrever do que ler "imagem" ou "IMG_1234.jpg" para o usuário
const ALT_GENERICO = /^(imagem|image|img|foto|photo|picture|figura|banner|logo|thumbnail|untitled|sem título)?\s*\d*$/i;
const PARECE_ARQUIVO = /\.(jpe?g|png|gif|webp|avif|svg|bmp)$/i;

function textoAlternativo(img) {
  // Ordem: alt, aria-label, title. Usar o que a página já oferece evita
  // gastar uma chamada de IA (e tokens) com a imagem.
  for (const atributo of ["alt", "aria-label", "title"]) {
    const valor = (img.getAttribute(atributo) || "").trim();
    if (valor && !ALT_GENERICO.test(valor) && !PARECE_ARQUIVO.test(valor)) return valor;
  }
  return "";
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
      const alt = textoAlternativo(no);
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

const TAMANHO_MIN_IMAGEM_GALERIA = 150; // px na tela: ignora miniaturas e ícones

function imagemVisivel(img) {
  const r = img.getBoundingClientRect();
  const estilo = getComputedStyle(img);
  return (
    r.width >= TAMANHO_MIN_IMAGEM_GALERIA &&
    r.height >= TAMANHO_MIN_IMAGEM_GALERIA &&
    estilo.visibility !== "hidden" &&
    Number(estilo.opacity) > 0
  );
}

function dentroDaTela(img) {
  const r = img.getBoundingClientRect();
  return r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
}

function opacidadeEfetiva(el) {
  // Carrosséis costumam esconder o slide pelo elemento pai, não pela imagem
  let opacidade = 1;
  for (let no = el; no && no.nodeType === 1; no = no.parentElement) {
    opacidade *= Number(getComputedStyle(no).opacity);
  }
  return opacidade;
}

function estaNaFrente(img) {
  // Pergunta ao navegador o que está desenhado no centro da parte visível da
  // imagem: descarta slides empilhados atrás de outro e slides cortados pela
  // borda do carrossel. Camadas transparentes por cima (div de clique) não
  // atrapalham, porque procuramos a primeira <img> visível naquele ponto.
  const r = img.getBoundingClientRect();
  const x = (Math.max(r.left, 0) + Math.min(r.right, innerWidth)) / 2;
  const y = (Math.max(r.top, 0) + Math.min(r.bottom, innerHeight)) / 2;
  const primeira = document
    .elementsFromPoint(x, y)
    .find((el) => el.tagName === "IMG" && opacidadeEfetiva(el) > 0.1);
  return primeira === img;
}

function extrairImagensVisiveis() {
  const grandes = Array.from(document.images).filter(
    (img) => (img.currentSrc || img.src) && imagemVisivel(img) && !imagemEhDecorativa(img)
  );
  // Em carrosséis, os outros slides ficam fora da tela, escondidos ou atrás
  // da foto atual: lê só a que a pessoa está vendo agora
  const naTela = grandes.filter(dentroDaTela);
  const naFrente = naTela.filter(estaNaFrente);
  const escolhidas = naFrente.length ? naFrente : naTela.length ? naTela : grandes;
  if (escolhidas.length === 0) return null;

  const textos = [];
  const imagensSemAlt = [];
  const vistas = new Set();
  for (const img of escolhidas) {
    const src = img.currentSrc || img.src;
    if (vistas.has(src)) continue;
    vistas.add(src);
    const alt = textoAlternativo(img);
    if (alt) textos.push(`Imagem: ${alt}.`);
    else imagensSemAlt.push(src);
  }

  return {
    ok: true,
    titulo: document.title,
    autor: null,
    tempoLeituraMin: 1,
    secoes: [{ titulo: "Imagens na tela", texto: textos.join(" "), imagensSemAlt }],
  };
}

function imagemAbertaNaAba() {
  // Aba mostrando uma imagem sozinha (ex.: um .svg aberto direto): não há
  // HTML nem <img>, a "página" é a própria imagem
  if (!(document.contentType || "").startsWith("image/")) return null;
  const nomeArquivo = decodeURIComponent(location.pathname.split("/").pop() || "imagem");
  return {
    ok: true,
    titulo: document.title || nomeArquivo,
    autor: null,
    tempoLeituraMin: 1,
    secoes: [{ titulo: "Imagem aberta nesta aba", texto: "", imagensSemAlt: [location.href] }],
  };
}

function extrairConteudoPagina() {
  const imagemSozinha = imagemAbertaNaAba();
  if (imagemSozinha) return imagemSozinha;

  // Readability.js exige um clone do documento (ele modifica o DOM que recebe)
  const clone = document.cloneNode(true);
  const reader = new Readability(clone, { charThreshold: 100 });
  const artigo = reader.parse();

  if (!artigo || !artigo.content) {
    // Sem texto de artigo (galerias, páginas só de fotos): em vez de desistir,
    // lê as imagens que estão na tela
    const galeria = extrairImagensVisiveis();
    if (galeria) return galeria;
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

function blobParaDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(leitor.result);
    leitor.onerror = () => reject(leitor.error);
    leitor.readAsDataURL(blob);
  });
}

async function lerImagemNaPagina(src) {
  // Plano B do background, quando ele não consegue baixar a imagem sozinho.
  // 1) fetch no contexto da própria página: funciona com blob:, imagens da
  //    mesma origem que exigem login e sites que só entregam a foto para quem
  //    está na página deles
  try {
    const resposta = await fetch(src);
    if (resposta.ok) return await blobParaDataUrl(await resposta.blob());
  } catch (erro) {
    // segue para a tentativa 2
  }
  // 2) a imagem que já está carregada na tela, copiada para um canvas (o
  //    navegador só permite se ela for da mesma origem ou liberada por CORS)
  const img = Array.from(document.images).find((i) => i.currentSrc === src || i.src === src);
  if (img && img.complete && img.naturalWidth) {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.85); // lança erro se o canvas ficou "contaminado"
  }
  throw new Error("imagem não encontrada na página");
}

// O background pode injetar este script de novo numa aba que já o tem
// (ver extrairDaAba): registra o listener uma vez só, senão a página
// responderia em dobro.
if (!globalThis.leitorAcessivelCarregado) {
  globalThis.leitorAcessivelCarregado = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.tipo === "EXTRACT_CONTENT") {
      try {
        const resultado = extrairConteudoPagina();
        sendResponse(resultado);
      } catch (erro) {
        sendResponse({ ok: false, motivo: "Erro ao processar a página: " + erro.message });
      }
    }
    if (msg.tipo === "LER_IMAGEM") {
      lerImagemNaPagina(msg.src)
        .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
        .catch((erro) => sendResponse({ ok: false, motivo: erro.message }));
    }
    return true; // resposta assíncrona
  });
}
