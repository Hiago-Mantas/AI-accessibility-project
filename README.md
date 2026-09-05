# Leitor Acessível com IA — protótipo

Extensão de navegador (Manifest V3, Chrome/Edge) que extrai o conteúdo
principal de qualquer página — usando a mesma engine do Firefox Reader View
(Readability.js) — e lê em voz alta, seção por seção, com navegação por
teclado. Opcionalmente, reestrutura o texto com um modelo de IA (Claude)
antes de narrar, para lidar melhor com páginas mal organizadas.

## Como instalar (modo desenvolvedor)

1. Abra `chrome://extensions` (ou `edge://extensions`)
2. Ative o "Modo do desenvolvedor" (canto superior direito)
3. Clique em "Carregar sem compactação" e selecione a pasta `leitor-acessivel`
4. Clique no ícone da extensão em qualquer página para abrir o painel lateral

## Como usar

- Clique em **"Ler esta página"** para extrair o conteúdo
- Use **Espaço** para reproduzir/pausar, **← / →** para navegar entre seções
- Clique em qualquer seção na lista para pular direto para ela
- Ajuste a velocidade da voz no controle deslizante

## Reestruturação por IA (opcional)

Clique no ícone de engrenagem (⚙) e cole uma chave de API da Anthropic
(https://console.anthropic.com). Sem chave, a extensão funciona normalmente,
apenas lendo o texto extraído sem reescrevê-lo.

**Importante para uso em produção:** neste protótipo a chave fica salva no
`chrome.storage.local` do navegador e as chamadas à API saem direto do
navegador do usuário. Isso é aceitável para testes pessoais, mas expõe a
chave no tráfego do cliente. Uma versão para outros usuários deveria ter
um backend próprio guardando a chave, com a extensão chamando esse backend.

## Descrição automática de imagens sem alt text

Com uma chave de API configurada, a extensão também detecta `<img>` sem
`alt` (ou com `alt=""`) que não pareçam puramente decorativas (ícones
pequenos, `role="presentation"` e `aria-hidden="true"` são ignorados) e
manda cada uma para a API de visão do Claude, pedindo uma descrição curta
que é inserida na leitura no lugar da imagem.

- Limite de 8 imagens por página no protótipo (controla custo e latência —
  ajustável em `LIMITE_IMAGENS_POR_PAGINA` no `sidepanel.js`)
- Imagens que já têm `alt` preenchido são lidas direto, sem gastar chamada
  de API
- Sem chave de API configurada, a extensão não descreve as imagens, mas
  avisa na leitura que a seção contém imagem sem descrição — em vez de
  simplesmente omitir essa informação
- Imagens atrás de login/CORS podem falhar na descrição (a API busca a
  URL do lado do servidor); nesse caso a seção segue sem travar

## O que já funciona

- Extração de conteúdo robusta mesmo sem tags de SEO/schema, via
  Readability.js (baseado em heurísticas de estrutura HTML, não metadados)
- Divisão automática em seções navegáveis por heading
- Leitor de voz nativo do navegador (Web Speech API), sem custo
- Reestruturação opcional por IA, seção por seção
- Navegação por teclado e painel com foco visível, pensado para uso com
  leitor de tela concorrente (NVDA/VoiceOver) sem duplicar leitura

## Limitações conhecidas (próximos passos de um TCC)

- Não foi testado ainda rodando junto com um leitor de tela real — o passo
  5 do plano original (testar foco/leitura duplicada com NVDA) fica para a
  próxima iteração
- Divisão em seções é heurística (por heading); páginas sem heading nenhum
  caem num único bloco
- Qualidade da voz depende do TTS do sistema operacional
- Sem avaliação com usuários reais ainda — o ponto mais importante para
  virar um TCC de verdade, como conversamos
