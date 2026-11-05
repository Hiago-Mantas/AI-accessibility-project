// backend/worker.js
// Servidor (Cloudflare Worker) que usa o Google Gemini para descrever
// imagens sem alt text e traduzir páginas para o português. A chave da API
// fica só aqui, como segredo do Worker: nunca vai para a extensão nem para
// o repositório.
//
// POST /descrever  { imagem: "<base64>", tipo: "image/jpeg", detalhe: "curto" | "detalhado" }
//   200 → { descricao: "..." }
// POST /traduzir   { textos: ["...", ...], origem: "en" }
//   200 → { traducoes: ["...", ...] }  (mesma ordem e quantidade)
// Erros: 4xx/5xx → { erro: "..." }

const MODELO_PADRAO = "gemini-3.5-flash-lite"; // o mais leve que lê imagens bem
const TIPOS_ACEITOS = ["image/jpeg", "image/png", "image/webp"];
const TAMANHO_MAX_BASE64 = 2_000_000; // ~1,5 MB: a extensão já reduz a imagem antes

const REGRAS_COMUNS =
  "Você escreve textos alternativos (alt text) para pessoas com deficiência visual. " +
  "Responda em português do Brasil. Não comece com 'A imagem mostra'. " +
  "Não identifique pessoas reais pelo rosto. ";

const ESTILOS = {
  // Padrão: o essencial, rápido de ouvir (e menos tokens de resposta)
  curto: {
    instrucao:
      REGRAS_COMUNS +
      "Use UMA frase curta, de no máximo 12 palavras, só com o essencial: quem ou o que " +
      "aparece e o contexto. Exemplo: 'Goleiro do Santos durante o treino.' " +
      "Não liste marcas, cores ou detalhes de roupa. Cite texto da imagem só se ele for " +
      "a informação principal, como um cartaz ou um aviso.",
    maxTokens: 40,
  },
  detalhado: {
    instrucao:
      REGRAS_COMUNS +
      "Use no máximo 2 frases curtas: o que a imagem mostra e, se houver, o texto visível nela.",
    maxTokens: 120,
  },
};

// Tradução: a extensão manda vários trechos de uma vez (menos pedidos) e
// em lotes, então estes limites valem por pedido
const MAX_TEXTOS = 60;
const MAX_CARACTERES = 12_000;

const INSTRUCAO_TRADUCAO =
  "Você traduz textos de páginas web para o português do Brasil, para serem lidos em voz alta " +
  "para pessoas com deficiência visual. Recebe uma lista JSON de textos e devolve uma lista JSON " +
  "com a tradução de cada um, na mesma ordem e com a mesma quantidade de itens. Traduza de forma " +
  "natural e fiel, sem resumir, explicar ou acrescentar nada. Mantenha nomes de marcas, produtos, " +
  "pessoas e empresas como estão. Se um texto já estiver em português, devolva-o igual.";

function responder(status, corpo) {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function origemPermitida(request, env) {
  // ORIGENS_PERMITIDAS: lista separada por vírgula, ex.
  // "chrome-extension://abcdef...". Vazia = aceita qualquer origem (só para testes).
  const permitidas = (env.ORIGENS_PERMITIDAS || "").split(",").map((o) => o.trim()).filter(Boolean);
  return permitidas.length === 0 || permitidas.includes(request.headers.get("Origin"));
}

// Quando o modelo principal está sobrecarregado ("high demand") ou com a cota
// do dia esgotada, tenta estes, nesta ordem. Cada modelo tem fila e cota
// próprias no plano gratuito do Gemini.
const MODELOS_RESERVA_PADRAO = "gemini-3.1-flash-lite,gemini-2.5-flash-lite";
const TENTATIVAS_POR_MODELO = 2;
const ESPERA_ENTRE_TENTATIVAS_MS = 1000;

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pedirAoModelo(env, modelo, corpo) {
  const resposta = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify(corpo),
    }
  );
  const dados = await resposta.json().catch(() => ({}));
  return { status: resposta.status, ok: resposta.ok, dados };
}

async function chamarGemini(env, corpo) {
  // Devolve o texto da resposta, ou um Response de erro pronto para a extensão
  const modelos = [env.GEMINI_MODELO || MODELO_PADRAO].concat(
    (env.GEMINI_MODELOS_RESERVA ?? MODELOS_RESERVA_PADRAO).split(",").map((m) => m.trim()).filter(Boolean)
  );

  let ultimaFalha = null;
  for (const modelo of [...new Set(modelos)]) {
    for (let tentativa = 1; tentativa <= TENTATIVAS_POR_MODELO; tentativa++) {
      const { status, ok, dados } = await pedirAoModelo(env, modelo, corpo);
      if (ok) {
        const partes = (dados.candidates && dados.candidates[0] && dados.candidates[0].content &&
          dados.candidates[0].content.parts) || [];
        return { texto: partes.map((p) => p.text || "").join("").trim() };
      }
      ultimaFalha = { status, motivo: `${modelo}: ${(dados.error && dados.error.message) || `HTTP ${status}`}` };
      // 429 = cota do modelo esgotada: tentar de novo não adianta, vai para o próximo
      if (status === 429) break;
      // 500/503 = sobrecarga passageira do Google: espera e tenta de novo
      if (status === 500 || status === 503) {
        if (tentativa < TENTATIVAS_POR_MODELO) await esperar(ESPERA_ENTRE_TENTATIVAS_MS * tentativa);
        continue;
      }
      // Outros erros (pedido inválido, chave errada) seriam iguais em
      // qualquer modelo: devolve logo
      return { erro: responder(502, { erro: `Gemini: ${ultimaFalha.motivo}` }) };
    }
  }
  // 429 = cota esgotada em todos: repassa para a extensão avisar
  const codigo = ultimaFalha && ultimaFalha.status === 429 ? 429 : 503;
  return { erro: responder(codigo, { erro: `Gemini indisponível no momento (${ultimaFalha && ultimaFalha.motivo}). Tente de novo em alguns minutos.` }) };
}

async function descrever(pedido, env) {
  const { imagem, tipo } = pedido || {};
  const estilo = ESTILOS[pedido && pedido.detalhe] || ESTILOS.curto;
  if (typeof imagem !== "string" || !imagem) return responder(400, { erro: "Campo 'imagem' ausente." });
  if (!TIPOS_ACEITOS.includes(tipo)) return responder(400, { erro: `Tipo de imagem não aceito: ${tipo}` });
  if (imagem.length > TAMANHO_MAX_BASE64) return responder(413, { erro: "Imagem grande demais." });

  const { erro, texto } = await chamarGemini(env, {
    systemInstruction: { parts: [{ text: estilo.instrucao }] },
    contents: [
      {
        role: "user",
        parts: [{ inline_data: { mime_type: tipo, data: imagem } }, { text: "Descreva esta imagem." }],
      },
    ],
    generationConfig: {
      maxOutputTokens: estilo.maxTokens,
      // Resolução baixa: ~270 tokens por imagem em vez de ~1.100, com
      // descrição praticamente igual para alt text
      mediaResolution: "MEDIA_RESOLUTION_LOW",
    },
  });
  if (erro) return erro;
  if (!texto) return responder(502, { erro: "O Gemini não devolveu descrição." });
  return responder(200, { descricao: texto });
}

async function traduzir(pedido, env) {
  const textos = pedido && pedido.textos;
  if (!Array.isArray(textos) || textos.length === 0 || !textos.every((t) => typeof t === "string")) {
    return responder(400, { erro: "Campo 'textos' deve ser uma lista de textos." });
  }
  const caracteres = textos.reduce((soma, t) => soma + t.length, 0);
  if (textos.length > MAX_TEXTOS || caracteres > MAX_CARACTERES) {
    return responder(413, { erro: `No máximo ${MAX_TEXTOS} textos e ${MAX_CARACTERES} caracteres por pedido.` });
  }
  const origem = typeof pedido.origem === "string" ? pedido.origem.slice(0, 10) : "";

  const { erro, texto } = await chamarGemini(env, {
    systemInstruction: { parts: [{ text: INSTRUCAO_TRADUCAO }] },
    contents: [
      {
        role: "user",
        parts: [{ text: (origem ? `Idioma de origem: ${origem}.\n` : "") + JSON.stringify(textos) }],
      },
    ],
    generationConfig: {
      // Resposta em JSON garantida: uma lista de textos
      responseMimeType: "application/json",
      responseSchema: { type: "ARRAY", items: { type: "STRING" } },
      // Português costuma ser um pouco mais longo que o inglês: ~1 token a
      // cada 3 caracteres, com folga
      maxOutputTokens: Math.min(8192, Math.ceil(caracteres / 2) + 256),
    },
  });
  if (erro) return erro;

  let traducoes;
  try {
    traducoes = JSON.parse(texto);
  } catch {
    return responder(502, { erro: "O Gemini não devolveu uma lista válida (resposta cortada?)." });
  }
  if (!Array.isArray(traducoes) || traducoes.length !== textos.length) {
    return responder(502, { erro: "O Gemini devolveu uma quantidade diferente de traduções." });
  }
  return responder(200, { traducoes: traducoes.map(String) });
}

const ROTAS = { "/descrever": descrever, "/traduzir": traduzir };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const rota = ROTAS[url.pathname];
    if (!rota) return responder(404, { erro: "Rota não encontrada." });
    if (request.method !== "POST") return responder(405, { erro: "Use POST." });
    if (!origemPermitida(request, env)) return responder(403, { erro: "Origem não permitida." });
    if (!env.GEMINI_API_KEY) return responder(500, { erro: "GEMINI_API_KEY não configurada no servidor." });

    let pedido;
    try {
      pedido = await request.json();
    } catch {
      return responder(400, { erro: "Corpo da requisição não é JSON válido." });
    }
    return rota(pedido, env);
  },
};
