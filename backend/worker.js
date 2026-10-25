// backend/worker.js
// Servidor (Cloudflare Worker) que descreve imagens sem alt text usando o
// Google Gemini. A chave da API fica só aqui, como segredo do Worker: nunca
// vai para a extensão nem para o repositório.
//
// POST /descrever  { imagem: "<base64>", tipo: "image/jpeg", detalhe: "curto" | "detalhado" }
//   200 → { descricao: "..." }
//   4xx/5xx → { erro: "..." }

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/descrever") return responder(404, { erro: "Rota não encontrada." });
    if (request.method !== "POST") return responder(405, { erro: "Use POST." });
    if (!origemPermitida(request, env)) return responder(403, { erro: "Origem não permitida." });
    if (!env.GEMINI_API_KEY) return responder(500, { erro: "GEMINI_API_KEY não configurada no servidor." });

    let pedido;
    try {
      pedido = await request.json();
    } catch {
      return responder(400, { erro: "Corpo da requisição não é JSON válido." });
    }
    const { imagem, tipo } = pedido || {};
    const estilo = ESTILOS[pedido && pedido.detalhe] || ESTILOS.curto;
    if (typeof imagem !== "string" || !imagem) return responder(400, { erro: "Campo 'imagem' ausente." });
    if (!TIPOS_ACEITOS.includes(tipo)) return responder(400, { erro: `Tipo de imagem não aceito: ${tipo}` });
    if (imagem.length > TAMANHO_MAX_BASE64) return responder(413, { erro: "Imagem grande demais." });

    const modelo = env.GEMINI_MODELO || MODELO_PADRAO;
    const respostaGemini = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
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
        }),
      }
    );

    const dados = await respostaGemini.json().catch(() => ({}));
    if (!respostaGemini.ok) {
      const motivo = (dados.error && dados.error.message) || `HTTP ${respostaGemini.status}`;
      // 429 = cota do plano gratuito esgotada: repassa para a extensão avisar
      return responder(respostaGemini.status === 429 ? 429 : 502, { erro: `Gemini: ${motivo}` });
    }

    const partes = (dados.candidates && dados.candidates[0] && dados.candidates[0].content &&
      dados.candidates[0].content.parts) || [];
    const descricao = partes.map((p) => p.text || "").join("").trim();
    if (!descricao) return responder(502, { erro: "O Gemini não devolveu descrição." });
    return responder(200, { descricao });
  },
};
