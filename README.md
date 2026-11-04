# Leitor Acessível com IA — protótipo

[![Baixar o Leitor Acessível (.zip)](https://img.shields.io/badge/Baixar-Leitor%20Acess%C3%ADvel%20%28.zip%29-2ea44f?style=for-the-badge&logo=github)](https://github.com/Hiago-Mantas/AI-accessibility-project/archive/refs/heads/main.zip)

<sub>Baixa a versão mais recente do branch `main` (extensão + backend).</sub>

Extensão de navegador (Manifest V3, Chrome/Edge) que extrai o conteúdo
principal de qualquer página — usando a mesma engine do Firefox Reader View
(Readability.js) — e lê em voz alta, seção por seção, com navegação por
teclado. Opcionalmente, reestrutura o texto com um modelo de IA (Claude)
antes de narrar, para lidar melhor com páginas mal organizadas.

## Como instalar (modo desenvolvedor)

1. Clique no botão **Baixar** acima e descompacte o arquivo. Vai aparecer a
   pasta `AI-accessibility-project-main`
2. Abra `chrome://extensions` (ou `edge://extensions`)
3. Ative o "Modo do desenvolvedor" (canto superior direito)
4. Clique em "Carregar sem compactação" e selecione a pasta
   `AI-accessibility-project-main`
5. Clique no ícone da extensão em qualquer página para abrir o painel lateral

A descrição de imagens já funciona: a extensão usa o backend publicado na
Cloudflare, sem precisar abrir terminal nem configurar chave. Detalhes em
[backend/README.md](backend/README.md).

## Como usar

- Clique em **"Ler esta página"** para extrair o conteúdo
- Use **Espaço** para reproduzir/pausar, **← / →** para navegar entre seções
- Clique em qualquer seção na lista para pular direto para ela
- Ajuste a velocidade da voz no controle deslizante
- Clique em **"↻ Ler a página de novo"** para extrair a página outra vez e
  pedir à IA novas descrições das imagens (descarta as descrições guardadas;
  útil se a página mudou ou se uma descrição saiu ruim)

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

A extensão lê o texto alternativo que a página já oferece e só usa IA
quando ele falta:

1. **Alt primeiro:** imagens com `alt`, `aria-label` ou `title` são lidas
   direto, sem IA. Alt genérico (`"imagem"`, `"IMG_1234.jpg"`) conta como
   ausente.
2. **Decorativas ignoradas:** imagens que aparecem com menos de 48 px na
   tela (ícones, inclusive os reduzidos por CSS, e pixels de rastreamento),
   imagens escondidas e as marcadas com `role="presentation"`/`"none"` ou
   dentro de um bloco `aria-hidden="true"` não são lidas nem enviadas.
3. **IA só para o resto:** as imagens sem alt são reduzidas no navegador e
   enviadas ao [backend do projeto](backend/README.md), que pede a descrição
   ao Google Gemini. A chave do Gemini fica só no backend, nunca na extensão.
4. **Economia:** cerca de 270 tokens por imagem, cache da mesma imagem na
   sessão e no máximo 8 imagens por página (`LIMITE_IMAGENS_POR_PAGINA` no
   `sidepanel.js`).
5. **Descrição curta por padrão:** uma frase, como "Goleiro do Santos durante
   o treino." Descrições detalhadas podem ser ligadas no ⚙.

Páginas sem texto de artigo (galerias de fotos) também funcionam: a
extensão lê só a foto que está visível na tela, ignorando os outros slides
do carrossel (escondidos, empilhados atrás ou cortados pela borda).

Se o navegador não conseguir baixar a imagem direto (sites que só entregam
a foto para quem está na página deles, imagens `blob:`), a própria página
entrega a imagem para a extensão.

Imagens SVG (comuns em gráficos e ícones) são desenhadas pelo painel e
convertidas em PNG antes de ir para a IA, porque o Gemini não aceita SVG.
Uma imagem aberta sozinha numa aba (por exemplo, um `.svg` ou `.jpg` aberto
direto) também é descrita.

Se a descrição falhar (imagem protegida, backend fora do ar, cota esgotada), a
leitura avisa "Imagem sem descrição" em vez de omitir a imagem, e o motivo
técnico aparece em letras pequenas no painel.

**Configuração:** o endereço do backend fica em `config.js`
(`URL_BACKEND`) e aponta para o backend publicado na Cloudflare. Rodar o
backend no computador (`npx wrangler dev`) só é preciso para testar
mudanças nele (veja [backend/README.md](backend/README.md)). A descrição
pode ser desligada no ⚙ do painel.

**Privacidade:** imagens sem alt são enviadas ao backend e ao Google
Gemini. No plano gratuito, o Google pode usá-las para melhorar os produtos
dele. A extensão avisa isso nas configurações.

## Tradução de páginas em outro idioma

Páginas em inglês, espanhol ou qualquer outro idioma são traduzidas para o
português antes da leitura, pelo mesmo [backend](backend/README.md) (rota
`/traduzir`, Google Gemini).

- **Idioma detectado pelo texto:** o Chrome identifica o idioma pelo próprio
  conteúdo, sem internet. O `lang` do HTML só é usado quando ele não tem
  certeza, porque muitos sites o deixam errado ou vazio. Páginas em
  português não gastam nada.
- **Economia:** a página vai em poucos pedidos (lotes de até 6.000
  caracteres) e o mesmo texto não é traduzido duas vezes na sessão do
  navegador. Texto custa bem menos que imagem: uma página inicial inteira
  fica em poucos milhares de tokens.
- **Sem tradução:** com a opção desligada no ⚙, ou se a tradução falhar, a
  página é lida no idioma original com uma voz desse idioma (antes era lida
  com voz em português, com sotaque). O motivo da falha aparece em letras
  pequenas no painel.
- **"↻ Ler a página de novo"** também descarta as traduções guardadas.

**Privacidade:** o texto da página é enviado ao backend e ao Google Gemini.
A extensão avisa isso nas configurações.

## Páginas HTML abertas do computador (`file:///`)

Por segurança, o Chrome não deixa extensões lerem arquivos do computador
sem permissão. Para usar o Leitor Acessível num `.html` local:

1. Abra `chrome://extensions`
2. Clique em **Detalhes** no Leitor Acessível
3. Ligue **"Permitir acesso a URLs de arquivo"**

Com isso, o texto e as imagens do arquivo são lidos normalmente, inclusive
a descrição por IA das imagens sem alt. Se a permissão estiver desligada,
o painel explica como ligá-la.

Alternativa sem mexer na permissão: abrir a pasta por um servidor local
(Live Server do VS Code, ou `python -m http.server 8000` e acessar
`http://localhost:8000/arquivo.html`).

## O que já funciona

- Extração de conteúdo robusta mesmo sem tags de SEO/schema, via
  Readability.js (baseado em heurísticas de estrutura HTML, não metadados)
- Divisão automática em seções navegáveis por heading
- Leitor de voz nativo do navegador (Web Speech API), sem custo
- Tradução automática para o português de páginas em outro idioma
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
