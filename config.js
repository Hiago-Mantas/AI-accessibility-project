// config.js
// Endereço do backend que descreve imagens sem alt text (pasta backend/).
// Não é segredo: a chave do Gemini fica só no servidor.
//   - publicado na Cloudflare (padrão): funciona sem terminal
//   - para testar mudanças no backend no computador, troque por
//     "http://127.0.0.1:8787" e rode `npx wrangler dev` na pasta backend
// Deixe vazio ("") para desligar a descrição de imagens.
const URL_BACKEND = "https://leitor-acessivel-backend.hiagomantas0.workers.dev";
