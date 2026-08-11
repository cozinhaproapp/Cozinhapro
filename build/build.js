#!/usr/bin/env node
// CozinhaPro — build de ofuscação (v1).
//
// Lê os arquivos-fonte legíveis (app.src.html, login.src.html), ofusca o
// maior bloco <script> de cada um, e escreve o resultado como app.html /
// login.html — os arquivos que de fato vão pro Vercel.
//
// IMPORTANTE — configurações escolhidas de propósito:
// - renameGlobals: false — o app inteiro depende de onclick="funcName(...)"
//   no HTML apontando pra funções globais pelo nome. Se o obfuscator
//   renomeasse funções/consts de nível superior, todo onclick pararia de
//   funcionar silenciosamente (o botão simplesmente não faria nada).
// - controlFlowFlattening: false — com ~2,3MB de JS num arquivo só, control
//   flow flattening pesado pode deixar o carregamento da página lento. Vale
//   reavaliar depois de medir o impacto real, mas por ora prioriza não
//   quebrar/lentificar um sistema em uso diário.
// - deadCodeInjection: false — mesma lógica: não inflar o arquivo sem medir
//   o ganho de proteção real.
//
// Uso: node build.js
// Requer: npm install (uma vez, instala javascript-obfuscator).

const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = path.join(__dirname, '..'); // pasta cozinhapro/

const ARQUIVOS = [
  { src: 'app.src.html', out: 'app.html' },
  { src: 'login.src.html', out: 'login.html' },
];

const OBFUSCATOR_OPTIONS = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  renameGlobals: false,          // crítico — ver comentário acima
  identifierNamesGenerator: 'hexadecimal',
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  splitStrings: false,
  selfDefending: false,          // selfDefending quebra fácil com re-formatação/minify externo; não vale o risco aqui
  disableConsoleOutput: false,   // manter console.error/warn visíveis pra facilitar suporte/depuração em produção
};

function extrairMaiorScript(html) {
  const regex = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g;
  let match, maior = null, maiorTamanho = -1, maiorMatch = null;
  while ((match = regex.exec(html))) {
    const conteudo = match[1];
    if (conteudo.includes('src=')) continue; // script externo (import), não deve acontecer com esse regex mas por garantia
    const tamanho = Buffer.byteLength(conteudo, 'utf-8');
    if (tamanho > maiorTamanho) { maiorTamanho = tamanho; maior = conteudo; maiorMatch = match; }
  }
  if (maior === null) throw new Error('Nenhum bloco <script> encontrado.');
  return { conteudo: maior, indexInicio: maiorMatch.index + maiorMatch[0].indexOf(maior), tamanho: maior.length };
}

function build(srcNome, outNome) {
  const srcPath = path.join(ROOT, srcNome);
  const outPath = path.join(ROOT, outNome);
  if (!fs.existsSync(srcPath)) {
    console.warn(`[build] AVISO: ${srcNome} não encontrado, pulando.`);
    return;
  }
  const html = fs.readFileSync(srcPath, 'utf-8');
  const { conteudo, indexInicio } = extrairMaiorScript(html);

  console.log(`[build] ${srcNome}: ofuscando bloco de ${(conteudo.length / 1024).toFixed(0)} KB...`);
  const resultado = JavaScriptObfuscator.obfuscate(conteudo, OBFUSCATOR_OPTIONS).getObfuscatedCode();

  const novoHtml = html.slice(0, indexInicio) + resultado + html.slice(indexInicio + conteudo.length);
  fs.writeFileSync(outPath, novoHtml, 'utf-8');
  console.log(`[build] ${outNome} gerado (${(novoHtml.length / 1024).toFixed(0)} KB, era ${(html.length / 1024).toFixed(0)} KB no fonte).`);
}

console.log('=== CozinhaPro build (ofuscação) ===');
for (const { src, out } of ARQUIVOS) build(src, out);
console.log('=== build concluído ===');
