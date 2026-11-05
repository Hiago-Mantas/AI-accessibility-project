// content.js
// Roda em toda página. Espera por uma mensagem "EXTRACT_CONTENT" vinda do
// side panel (via background) e responde com o conteúdo já limpo e
// dividido em seções navegáveis.

const TAMANHO_MIN_IMAGEM = 48; // px: abaixo disso é ícone, separador ou pixel de rastreamento

function marcadaComoDecorativa(img) {
  const papel = img.getAttribute("role");
  if (papel === "presentation" || papel === "none") return true;
  // aria-hidden num elemento pai também esconde a imagem do leitor de tela
  return Boolean(img.closest('[aria-hidden="true"]'));
}

function imagemOriginal(img) {
  // A cópia limpa pelo Readability não está desenhada na tela: a imagem de
  // verdade, com o tamanho real, é a da página, achada pelo endereço
  if (img.ownerDocument === document) return img;
  const src = img.getAttribute("src") && img.src;
  return Array.from(document.images).find((i) => i.currentSrc === src || i.src === src) || null;
}

function imagemEhDecorativa(img) {
  // Não gasta IA (nem tokens) com ícones, separadores e imagens escondidas
  const original = imagemOriginal(img);
  if (marcadaComoDecorativa(img) || (original && marcadaComoDecorativa(original))) return true;

  if (original) {
    const r = original.getBoundingClientRect();
    // Desenhada na tela: vale o tamanho em que aparece (um ícone grande
    // reduzido por CSS continua sendo ícone)
    if (r.width && r.height) return r.width < TAMANHO_MIN_IMAGEM || r.height < TAMANHO_MIN_IMAGEM;
    // Não desenhada (display: none, aba fechada): a pessoa não está vendo
    if (original.complete && getComputedStyle(original).display === "none") return true;
  }

  // Sem como medir na tela: usa o tamanho do arquivo ou os atributos
  const alvo = original || img;
  const largura = alvo.naturalWidth || parseInt(alvo.getAttribute("width") || "0", 10);
  const altura = alvo.naturalHeight || parseInt(alvo.getAttribute("height") || "0", 10);
  return Boolean(largura && altura && (largura < TAMANHO_MIN_IMAGEM || altura < TAMANHO_MIN_IMAGEM));
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

// Tags que ficam "dentro da linha": o texto delas continua o bloco em volta
// (sem espaço extra). As outras começam um bloco novo, separado por espaço.
const TAGS_EM_LINHA = new Set([
  "a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "dfn", "em", "i", "kbd",
  "label", "mark", "q", "s", "samp", "small", "span", "strong", "sub", "sup",
  "time", "u", "var", "font",
]);
const TAGS_SEM_TEXTO = new Set(["script", "style", "noscript", "template", "svg", "button", "select", "textarea"]);

function blocoDe(no) {
  let el = no.parentElement;
  while (el && TAGS_EM_LINHA.has(el.tagName.toLowerCase())) el = el.parentElement;
  return el;
}

function extrairSecoes(htmlLimpo) {
  // Transforma o HTML limpo em uma lista de seções usando os headings como
  // pontos de corte. Isso permite navegação "próxima seção / seção
  // anterior", igual leitores de tela tradicionais.
  // DOMParser cria um documento "inerte": diferente de innerHTML, não faz o
  // navegador baixar de novo todas as imagens do artigo
  const container = new DOMParser().parseFromString(htmlLimpo, "text/html").body;

  const secoes = [];
  let atual = { titulo: null, textos: [], imagensSemAlt: [] };
  // Texto do bloco que está sendo lido. Percorre TODOS os textos, não só
  // <p> e <li>: sites de empresa põem muito conteúdo em <div> e <span>
  // (cards, notícias, números), que antes eram pulados.
  let pedaco = "";
  let blocoDoPedaco = null;

  function fecharPedaco() {
    const texto = pedaco.replace(/\s+/g, " ").trim();
    if (texto) atual.textos.push(texto);
    pedaco = "";
    blocoDoPedaco = null;
  }

  function fecharSecao() {
    fecharPedaco();
    if (atual.titulo || atual.textos.length || atual.imagensSemAlt.length) {
      secoes.push({
        titulo: atual.titulo,
        texto: atual.textos.join(" "),
        imagensSemAlt: atual.imagensSemAlt,
      });
    }
  }

  const caminhante = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let no = caminhante.nextNode();
  while (no) {
    if (no.nodeType === Node.TEXT_NODE) {
      const bloco = blocoDe(no);
      if (bloco !== blocoDoPedaco) {
        fecharPedaco();
        blocoDoPedaco = bloco;
      }
      pedaco += no.data;
      no = caminhante.nextNode();
      continue;
    }

    const tag = no.tagName.toLowerCase();

    if (tag === "img") {
      fecharPedaco();
      const alt = textoAlternativo(no);
      if (alt) {
        // já tem alt text: só incorpora como texto, sem gastar chamada de IA
        atual.textos.push(`Imagem: ${alt}.`);
      } else if (!imagemEhDecorativa(no) && no.src) {
        atual.imagensSemAlt.push(no.src);
      }
    } else if (/^h[1-4]$/.test(tag)) {
      const titulo = no.textContent.replace(/\s+/g, " ").trim();
      if (titulo) {
        fecharSecao();
        atual = { titulo, textos: [], imagensSemAlt: [] };
      }
      no = pularFilhos(caminhante);
      continue;
    } else if (TAGS_SEM_TEXTO.has(tag)) {
      no = pularFilhos(caminhante);
      continue;
    }
    no = caminhante.nextNode();
  }
  fecharSecao();

  return secoes;
}

function pularFilhos(caminhante) {
  // Vai para o próximo nó depois deste elemento, sem entrar nos filhos dele
  let proximo = caminhante.nextSibling();
  while (!proximo && caminhante.parentNode()) proximo = caminhante.nextSibling();
  return proximo;
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

// Partes do site que se repetem em toda página (menus, rodapé, avisos de
// cookies): ficam de fora da leitura da página inteira
const FORA_DA_LEITURA = [
  "nav", "aside", "footer", "form", "dialog", "iframe",
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  '[role="complementary"]', '[role="dialog"]', '[role="alertdialog"]',
  '[role="search"]', '[aria-hidden="true"]', "[hidden]",
].join(",");

// Se o Readability pegar menos que isso do texto visível do conteúdo
// principal, ou dos títulos dele, escolheu só um pedaço (comum em páginas
// iniciais de empresas, feitas de vários blocos curtos lado a lado)
const COBERTURA_MINIMA = 0.5;
const TITULOS_PARA_COMPARAR = 3; // com menos títulos que isso, vale só o texto

function raizDoConteudo() {
  return document.querySelector('main, [role="main"]') || document.body;
}

function copiaLimpaDaPaginaInteira() {
  // Copia o conteúdo principal sem menus, rodapé e o que está escondido na
  // tela. Na cópia o navegador não sabe o que está visível, então a
  // conferência é feita na página de verdade, elemento por elemento (a cópia
  // tem exatamente a mesma ordem de elementos)
  const raiz = raizDoConteudo();
  const copia = raiz.cloneNode(true);
  const originais = raiz.querySelectorAll("*");
  const copias = copia.querySelectorAll("*");
  const remover = [];
  for (let i = 0; i < originais.length; i++) {
    const el = originais[i];
    if (!el.checkVisibility({ visibilityProperty: true })) remover.push(copias[i]);
  }
  remover.forEach((el) => el.remove());
  copia.querySelectorAll(FORA_DA_LEITURA).forEach((el) => el.remove());
  // Sem <main>, o cabeçalho do site (logo e menu) também sai
  if (raiz === document.body) copia.querySelectorAll("header").forEach((el) => el.remove());
  return copia;
}

function normalizar(texto) {
  return (texto || "").replace(/\s+/g, " ").trim();
}

function tamanhoDoTexto(texto) {
  return normalizar(texto).length;
}

function coberturaDosTitulos(paginaInteira, artigo) {
  // Quantos dos títulos da página o Readability manteve. O título principal
  // ele tira do texto e devolve à parte (artigo.title), então conta também.
  // Títulos que são só um link ("Leia também: ...") são chamadas para outras
  // páginas: o Readability faz bem em tirar, então não entram na conta.
  const titulos = Array.from(paginaInteira.querySelectorAll("h1, h2, h3, h4"))
    .filter((h) => !h.closest("a") && normalizar(h.textContent) !== normalizar(Array.from(h.querySelectorAll("a")).map((a) => a.textContent).join(" ")))
    .map((h) => normalizar(h.textContent))
    .filter(Boolean);
  if (titulos.length < TITULOS_PARA_COMPARAR) return 1;
  const textoArtigo = normalizar(artigo.textContent) + " " + normalizar(artigo.title);
  return titulos.filter((t) => textoArtigo.includes(t)).length / titulos.length;
}

function extrairConteudoPagina() {
  const imagemSozinha = imagemAbertaNaAba();
  if (imagemSozinha) return imagemSozinha;

  // Readability.js exige um clone do documento (ele modifica o DOM que recebe)
  const clone = document.cloneNode(true);
  const reader = new Readability(clone, { charThreshold: 100 });
  const artigo = reader.parse();

  // O Readability foi feito para artigos: escolhe o maior bloco de texto e
  // descarta o resto. Em páginas iniciais de empresas isso deixa de fora
  // banners, cards e notícias. Compara com o texto e os títulos visíveis e,
  // se ele pegou pouco, lê a página inteira.
  const paginaInteira = copiaLimpaDaPaginaInteira();
  const textoPagina = tamanhoDoTexto(paginaInteira.innerText || paginaInteira.textContent);
  const textoArtigo = artigo && artigo.content ? tamanhoDoTexto(artigo.textContent) : 0;
  const artigoCompleto =
    textoArtigo > 0 &&
    textoArtigo >= textoPagina * COBERTURA_MINIMA &&
    coberturaDosTitulos(paginaInteira, artigo) >= COBERTURA_MINIMA;

  if (artigoCompleto) {
    return {
      ok: true,
      titulo: artigo.title || document.title,
      autor: artigo.byline || null,
      tempoLeituraMin: Math.max(1, Math.round((artigo.length || 0) / 1000)),
      secoes: extrairSecoes(artigo.content),
    };
  }

  if (textoPagina >= 100) {
    const secoes = extrairSecoes(paginaInteira.innerHTML);
    if (secoes.length) {
      return {
        ok: true,
        titulo: (artigo && artigo.title) || document.title,
        autor: (artigo && artigo.byline) || null,
        tempoLeituraMin: Math.max(1, Math.round(textoPagina / 1000)),
        secoes,
      };
    }
  }

  // Sem texto (galerias, páginas só de fotos): em vez de desistir, lê as
  // imagens que estão na tela
  const galeria = extrairImagensVisiveis();
  if (galeria) return galeria;

  if (textoArtigo > 0) {
    return {
      ok: true,
      titulo: artigo.title || document.title,
      autor: artigo.byline || null,
      tempoLeituraMin: 1,
      secoes: extrairSecoes(artigo.content),
    };
  }
  return {
    ok: false,
    motivo: "Não foi possível identificar um conteúdo principal legível nesta página.",
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
        // Idioma declarado pela página (ex.: "en-US"): o painel confirma
        // pelo próprio texto, porque muitos sites declaram errado ou nada
        resultado.idioma = document.documentElement.lang || null;
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
