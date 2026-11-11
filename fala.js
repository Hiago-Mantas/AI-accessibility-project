// fala.js
// Usado pelo painel (sidepanel.js) e pela leitura de fundo (leitura-fundo.js).

const TAMANHO_MAX_TRECHO = 500;

function dividirEmTrechos(texto) {
  // A seção é lida em trechos, quebrando no fim das frases: assim pausar e
  // continuar volta ao trecho em que parou, e não ao começo da seção.
  const frases = texto.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)\s*/g) || [texto];
  const trechos = [];
  let atual = "";

  function empurrar(pedaco) {
    if ((atual + pedaco).length > TAMANHO_MAX_TRECHO && atual) {
      trechos.push(atual.trim());
      atual = "";
    }
    atual += pedaco;
  }

  for (const frase of frases) {
    if (frase.length <= TAMANHO_MAX_TRECHO) {
      empurrar(frase);
    } else {
      // frase gigante (ex: lista sem pontuação): quebra por palavras
      for (const palavra of frase.split(/(?<=\s)/)) empurrar(palavra);
    }
  }
  if (atual.trim()) trechos.push(atual.trim());
  return trechos;
}
