# Como o Leitor Acessível funciona

Dois diagramas: o primeiro mostra **as partes do sistema** e como elas se
comunicam; o segundo mostra **o passo a passo de uma leitura**, do clique
até a voz.

As imagens (PNG) para slides e documento ficam em [`docs/diagramas/`](diagramas/).

## 1. Arquitetura (componentes)

![Arquitetura do Leitor Acessível](diagramas/arquitetura.png)

<details>
<summary>Código do diagrama (Mermaid)</summary>

```mermaid
flowchart LR
  U(["Pessoa usuária<br/>clique, Alt+Shift+L / K, rolagem"])

  subgraph CH["Navegador Chrome (extensão)"]
    subgraph PG["Página web aberta"]
      CS["<b>content.js + readability.js</b><br/>• extrai o conteúdo (Readability ou página inteira)<br/>• divide em seções e blocos (data-leitor-id)<br/>• usa o alt das imagens primeiro<br/>• destaca o trecho lido e rola até ele<br/>• avisa quando a pessoa rola"]
    end
    SP["<b>Painel lateral</b><br/>sidepanel.html / sidepanel.js<br/>• controles e configurações (⚙)<br/>• detecta o idioma<br/>• organiza tradução e descrições<br/>• fila de leitura"]
    SW["<b>Service worker</b><br/>background.js + leitura-fundo.js + fala.js<br/>• ponte entre painel e página<br/>• baixa e reduz as imagens<br/>• tradução em lotes, com cache<br/>• leitura com o painel fechado<br/>• atalhos de teclado"]
    TTS[["chrome.tts<br/>voz do sistema"]]
    ST[("chrome.storage<br/>configurações e cache")]
  end

  subgraph CF["Cloudflare Workers"]
    BE["<b>Backend</b> (backend/worker.js)<br/>POST /descrever · POST /traduzir<br/>guarda a chave GEMINI_API_KEY<br/>tenta modelos reserva se um falhar"]
  end
  GM[["Google Gemini API"]]
  AN[["API Anthropic<br/>(opcional)"]]

  U --> SP
  U --> CS
  SP <-->|mensagens| SW
  SW <-->|mensagens| CS
  SP -->|destacar trecho| CS
  SP --> TTS
  SW --> TTS
  SP <--> ST
  SW <--> ST
  SW -->|"imagem reduzida (JPEG) e textos"| BE
  BE -->|"descrição e tradução"| SW
  BE <-->|"HTTPS + chave secreta"| GM
  SW -.->|"reestruturar texto<br/>(chave da própria pessoa)"| AN
```

</details>

**Leitura do diagrama:**

- **content.js** roda dentro de cada página: é o único que enxerga o HTML.
  Extrai o texto, liga cada trecho ao elemento da página (`data-leitor-id`)
  e cuida do destaque e da rolagem.
- **Painel lateral** é a interface (botões, lista de seções, ⚙). Com ele
  aberto, é ele quem organiza a leitura.
- **Service worker** fica sempre ativo em segundo plano: faz a ponte com a
  página, baixa as imagens, conversa com o backend e, **com o painel
  fechado**, faz a leitura sozinho (`leitura-fundo.js`).
- **chrome.tts** é a voz do sistema operacional, usada porque pode falar
  sem clique (necessário para a leitura automática).
- **Backend na Cloudflare** guarda a chave do Gemini, que nunca vai para a
  extensão. Só recebe imagens sem alt e textos para traduzir.
- **API Anthropic** é opcional: só é usada se a pessoa colar a própria
  chave no ⚙, para reestruturar o texto.

## 2. Sequência de uma leitura

Exemplo: uma página em inglês com uma imagem sem texto alternativo, lida
com o painel aberto.

![Sequência de uma leitura](diagramas/sequencia.png)

<details>
<summary>Código do diagrama (Mermaid)</summary>

```mermaid
sequenceDiagram
  autonumber
  actor P as Pessoa
  participant PL as Painel lateral
  participant SW as Service worker
  participant CS as Página (content.js)
  participant BE as Backend (Cloudflare)
  participant GM as Google Gemini
  participant V as Voz (chrome.tts)

  P->>PL: abre o painel (clique ou Alt+Shift+L)<br/>ou abre outra página
  PL->>SW: REQUEST_EXTRACT
  SW->>CS: EXTRACT_CONTENT
  Note over CS: marca os elementos (data-leitor-id)<br/>Readability (se pegou pouco, lê a página inteira)<br/>seções e blocos, imagens com alt viram texto
  CS-->>SW: seções, imagens sem alt, idioma, id do documento
  SW-->>PL: conteúdo extraído
  PL->>PL: detecta o idioma (chrome.i18n)
  opt página em outro idioma
    PL->>SW: TRADUZIR (blocos de texto)
    SW->>BE: POST /traduzir (em lotes)
    BE->>GM: traduzir para o português
    GM-->>BE: traduções (lista JSON)
    BE-->>SW: traduções
    SW-->>PL: blocos traduzidos (e guardados em cache)
  end
  loop cada imagem sem alt (até 8)
    PL->>SW: DESCREVER_IMAGEM
    SW->>SW: baixa e reduz a imagem (até 768 px)
    SW->>BE: POST /descrever
    BE->>GM: descrever (resolução baixa)
    GM-->>BE: frase curta em português
    BE-->>SW: descrição
    SW-->>PL: "Imagem: ..."
  end
  PL->>V: coloca a página inteira na fila da voz
  loop cada trecho falado
    V-->>PL: começou o trecho
    PL->>CS: DESTACAR (parágrafo)
    CS->>CS: destaca e rola a página até ele
  end
  opt a pessoa rola a página
    P->>CS: rola (mouse, teclado ou toque)
    CS->>PL: ROLAGEM_USUARIO (parágrafo no topo da tela)
    PL->>V: recomeça a fila a partir desse parágrafo
  end
  Note over PL,SW: Com o painel fechado, o service worker (leitura-fundo.js)<br/>faz o papel do painel neste mesmo fluxo
```

</details>

**Pontos importantes do fluxo:**

1. **Alt primeiro:** imagens que já têm texto alternativo viram texto na
   própria página (passo 4) e não gastam IA. Só as sem alt vão ao Gemini.
2. **Economia:** a tradução vai em lotes e fica em cache; a imagem é
   reduzida e enviada em resolução baixa; no máximo 8 imagens por página.
3. **Sem pausas:** a página inteira entra de uma vez na fila da voz, que
   emenda um trecho no outro.
4. **Página e áudio juntos:** cada trecho falado destaca o parágrafo na
   página; rolar a página faz a leitura pular para o que está na tela.
5. **Falhas não travam a leitura:** sem tradução a página é lida no idioma
   original; sem descrição a leitura avisa "Imagem sem descrição".
