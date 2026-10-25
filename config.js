// config.js
// Endereço do backend que descreve imagens sem alt text (pasta backend/).
// Não é segredo: a chave do Gemini fica só no servidor.
//   - testando no computador: "http://127.0.0.1:8787" (npx wrangler dev)
//   - depois de publicar: o endereço que o wrangler mostrar, ex.
//     "https://leitor-acessivel-backend.SEU-USUARIO.workers.dev"
// Deixe vazio ("") para desligar a descrição de imagens.
const URL_BACKEND = "http://127.0.0.1:8787";
