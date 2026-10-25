# Backend: descrição de imagens com o Google Gemini

Servidor pequeno (Cloudflare Worker) que recebe uma imagem da extensão e
devolve uma descrição curta em português, gerada pelo Google Gemini.

```
Extensão ──(imagem reduzida, JPEG)──► Backend (guarda a chave) ──► Google Gemini
```

**Por que existe:** a chave do Gemini não pode ficar dentro da extensão,
porque qualquer pessoa que instalasse a extensão conseguiria copiá-la. Aqui
ela fica guardada como **segredo do servidor** e nunca vai para o GitHub.

## Como o projeto economiza tokens

1. **Alt primeiro:** a extensão só manda para a IA as imagens sem texto
   alternativo útil (`alt`, `aria-label` ou `title`). Alt genérico como
   `"imagem"` ou `"IMG_1234.jpg"` conta como ausente.
2. **Imagens decorativas ignoradas:** ícones pequenos, `role="presentation"`
   e `aria-hidden="true"` não são enviados.
3. **Imagem reduzida:** a extensão manda no máximo 768 px, e o backend pede
   ao Gemini a resolução baixa (`MEDIA_RESOLUTION_LOW`): cerca de **270 tokens
   por imagem**, em vez de ~1.100.
4. **Cache:** a mesma imagem não é descrita duas vezes na mesma sessão do
   navegador.
5. **Limite por página:** no máximo 8 imagens por página.
6. **Descrição curta por padrão:** uma frase de até 12 palavras (no máximo
   40 tokens de resposta). A versão detalhada é opcional.

## Rodar no seu computador (para testar)

Precisa do [Node.js](https://nodejs.org) **versão 22 ou mais nova** (o
wrangler não roda no Node 20). Confira com `node -v`.

```bash
cd backend
cp .dev.vars.example .dev.vars   # no Windows: copy .dev.vars.example .dev.vars
```

Abra o `.dev.vars` e cole sua chave do [Google AI Studio](https://aistudio.google.com)
no lugar de `cole-sua-chave-aqui`. Depois:

```bash
npx wrangler dev
```

O backend fica em `http://127.0.0.1:8787`, que já é o endereço configurado
no `config.js` da extensão. Deixe o terminal aberto enquanto testa.

**No Windows:**

- Se o PowerShell disser que "a execução de scripts foi desabilitada", use
  `npx.cmd wrangler dev` no lugar de `npx wrangler dev`.
- Se aparecer `ENOENT ... AppData\Roaming\npm`, crie a pasta que falta com
  `mkdir "$env:APPDATA\npm"` e rode de novo.
- Para editar o `.dev.vars`: botão direito → Abrir com → Bloco de Notas.

## Publicar na internet (grátis)

1. Crie uma conta gratuita na [Cloudflare](https://dash.cloudflare.com/sign-up).
2. Dentro da pasta `backend`:

   ```bash
   npx wrangler login                    # abre o navegador para autorizar
   npx wrangler secret put GEMINI_API_KEY  # cole a chave quando pedir
   npx wrangler deploy
   ```

3. O `deploy` mostra um endereço como
   `https://leitor-acessivel-backend.SEU-USUARIO.workers.dev`.
   Coloque esse endereço em `URL_BACKEND`, no `config.js` da extensão.
4. **Recomendado:** em `chrome://extensions`, copie o ID da extensão e coloque
   em `ORIGENS_PERMITIDAS` no `wrangler.toml`
   (`"chrome-extension://SEU_ID"`). Depois rode `npx wrangler deploy` de novo.
   Assim o backend recusa pedidos que não venham da extensão.

## Configurações (`wrangler.toml`)

| Variável | Para que serve |
|---|---|
| `GEMINI_MODELO` | Modelo usado. Padrão: `gemini-3.5-flash-lite`. |
| `ORIGENS_PERMITIDAS` | IDs de extensão aceitos, separados por vírgula. Vazio = aceita tudo (só para testes). |
| `GEMINI_API_KEY` | **Segredo.** Nunca no arquivo: use `wrangler secret put` ou o `.dev.vars`. |

## Rota

`POST /descrever` com `{ "imagem": "<base64>", "tipo": "image/jpeg", "detalhe": "curto" }`

`detalhe` pode ser `"curto"` (padrão: uma frase de até 12 palavras, como
"Goleiro do Santos durante o treino.") ou `"detalhado"` (até 2 frases, com o
texto visível na imagem). O usuário escolhe no ⚙ da extensão.

| Resposta | Quando |
|---|---|
| `200 { "descricao": "..." }` | Deu certo |
| `400` | Corpo inválido ou tipo de imagem não aceito (aceita JPEG, PNG e WebP) |
| `403` | Origem fora de `ORIGENS_PERMITIDAS` |
| `413` | Imagem grande demais |
| `429` | Cota do plano gratuito do Gemini esgotada |
| `502` | O Gemini falhou ou não devolveu descrição |

## Limitações conhecidas

- O `ORIGENS_PERMITIDAS` barra o uso casual, mas não é uma proteção forte:
  alguém determinado consegue imitar a origem. Um próximo passo seria um
  limite de pedidos por usuário.
- No plano gratuito do Gemini, o Google pode usar as imagens enviadas para
  melhorar os produtos dele. Por isso a extensão avisa isso nas configurações.
