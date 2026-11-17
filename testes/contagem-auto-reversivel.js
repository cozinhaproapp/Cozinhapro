// Smoke v1.07.286 — conclusao automatica de area reversivel + curva ABC que
// nao sobrevive a troca do state. Caso real: Artesano 17/11, contagem Ampla
// com as 10 areas marcadas "fora do escopo" e 9 delas com itens visiveis.
// Extrai as funcoes reais de app.src.html (por chaves, nao por linha).
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.src.html'), 'utf8');

function extrair(nome) {
  const ini = src.indexOf('\nfunction ' + nome + '(');
  if (ini < 0) throw new Error('funcao nao encontrada: ' + nome);
  let i = src.indexOf('{', ini), prof = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') prof++;
    else if (c === '}') { prof--; if (prof === 0) return src.slice(ini, i + 1); }
  }
  throw new Error('fim nao encontrado: ' + nome);
}
function extrairConst(nome) {
  const ini = src.indexOf('\nconst ' + nome + ' =');
  let i = src.indexOf('{', ini), prof = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') prof++;
    else if (src[i] === '}') { prof--; if (prof === 0) return src.slice(ini, i + 2); }
  }
}

const fns = ['_curvaAssinatura','_curvaConsumo','_invalidarCurvaConsumo','_consumoEntreContagens',
  '_movimentouAposUltimaContagem','_calcBaixoGiro','_classeInsumo','_insumosValidosParaContagem',
  '_estadoDaArea','_escopoDaSessao','_cntBaseDoEscopoConfiavel','_cntConcluirAreasSemItens',
  '_cntReabrirAreasAutoComItens'];
const codigo = [
  'var state = {}; var _cntMostrarTodos = false;',
  'function _dataLocalISO(t){ const d=new Date(t); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }',
  'function _agora(){ return new Date("2026-11-17T12:00").getTime(); }',
  'function _catsNaoCMVSet(){ return new Set(); }',
  'function _escopoEfetivo(){ return { escopo:"ampla" }; }',
  'const _CURVA_TTL_MS = 30000; let _curvaCache = { ts:0, mapa:null, resumo:null };',
  extrairConst('ESCOPOS_CONTAGEM'),
  ...fns.map(extrair),
  'this._t = { setState: s => { state = s; }, getState: () => state, ' + fns.join(',') + ' };',
].join('\n');
const ctx = {}; vm.createContext(ctx); vm.runInContext(codigo, ctx);
const T = ctx._t;

let ok = 0, falha = 0;
function check(cond, msg) { if (cond) { ok++; } else { falha++; console.log('  FALHOU:', msg); } }

// ── cenario: 2 grupos. "Estoque" tem um item caro (A) e um barato (C);
// "Temperos" so tem item C. Ultima contagem 09/11, sem compra depois.
function stateReal() {
  const hist = q => [{data:'2026-10-20',qtd:q[0]},{data:'2026-11-02',qtd:q[1]},{data:'2026-11-09',qtd:q[2]}];
  return {
    insumos: [
      { id:1, nome:'Mussarela', custo:40, categoria:'x', historicoContagens: hist([100,60,20]) },
      { id:2, nome:'Oregano',   custo:1,  categoria:'x', historicoContagens: hist([5,5,5]) },
      { id:3, nome:'Pimenta',   custo:1,  categoria:'x', historicoContagens: hist([5,5,5]) },
    ],
    movimentacoes: [{ insumoId:1, data:'2026-10-27', qtd:0, valorTotal:0 }],
    gruposInsumos: [ { id:'g1', nome:'Estoque', insumos:[1,2] }, { id:'g2', nome:'Temperos', insumos:[3] } ],
    catEstoque: [],
  };
}
const rec = { escopo:'ciclo' };
const novaSessao = () => ({ escopo:'ampla', data:'2026-11-16',
  areas:[ { grupoId:'g1', itens:{}, concluida:false }, { grupoId:'g2', itens:{}, concluida:false } ] });

// 1. Curva calculada com state vazio NAO pode valer depois que o state chega.
T.setState({ insumos:[], movimentacoes:[], gruposInsumos:[] });
const c0 = T._curvaConsumo();
check(c0.resumo.total === 0, 'curva com state vazio tem total 0');
T.setState(stateReal());
const c1 = T._curvaConsumo();
check(c1.resumo.total > 0, 'troca do state invalida a curva dentro do TTL');
check(T._classeInsumo('1') === 'A', 'mussarela classe A');

// 2. Sessao travada (todas as areas concluidaAuto) e reaberta onde ha item.
const sTrav = novaSessao();
sTrav.areas.forEach(a => { a.concluida = true; a.concluidaAuto = true; });
const reab = T._cntReabrirAreasAutoComItens(sTrav, rec);
check(reab === 1, 'reabre so a area com item visivel (1), reabriu ' + reab);
check(sTrav.areas[0].concluida === false && !sTrav.areas[0].concluidaAuto, 'Estoque volta a pendente');
check(sTrav.areas[1].concluida === true && sTrav.areas[1].concluidaAuto === true, 'Temperos continua fora do escopo');

// 3. Area concluida a mao nunca e reaberta.
const sMao = novaSessao(); sMao.areas[0].concluida = true;
check(T._cntReabrirAreasAutoComItens(sMao, rec) === 0, 'area concluida a mao nao e tocada');
check(sMao.areas[0].concluida === true, 'area a mao continua concluida');

// 4. Caso de 16/09 preservado: Temperos em Ampla fecha sozinho; Estoque nao.
const s4 = novaSessao();
check(T._cntConcluirAreasSemItens(s4, rec) === 1, 'fecha sozinho so o Temperos');
check(s4.areas[1].concluidaAuto === true && !s4.areas[0].concluida, 'Temperos auto, Estoque pendente');
check(T._cntConcluirAreasSemItens(s4, rec) === 0, 'varredura idempotente');

// 5. Curva sem dado (todo mundo C por falta de dado) nao fecha nada.
const semDado = stateReal();
semDado.insumos.forEach(i => { i.historicoContagens = []; });
T.setState(semDado);
check(T._cntBaseDoEscopoConfiavel() === false, 'curva sem valor nao e base confiavel');
const s5 = novaSessao();
check(T._cntConcluirAreasSemItens(s5, rec) === 0, 'curva vazia nao fecha nenhuma area');

// 6. Insumos ainda nao carregados: nada fecha, nem grupo "vazio".
T.setState({ insumos:[], movimentacoes:[], gruposInsumos: stateReal().gruposInsumos });
const s6 = novaSessao();
check(T._cntConcluirAreasSemItens(s6, rec) === 0, 'sem insumos carregados nada fecha');

// 7. Grupo vazio por cadastro fecha mesmo com curva sem dado.
const cad = stateReal();
cad.insumos.forEach(i => { i.historicoContagens = []; });
cad.insumos[2].consumoDireto = true;   // Temperos so tem item de consumo direto
T.setState(cad);
const s7 = novaSessao();
check(T._cntConcluirAreasSemItens(s7, rec) === 1 && s7.areas[1].concluidaAuto, 'grupo vazio por cadastro fecha sozinho');

// 8. Pontos do fonte.
check(/_cntReabrirAreasAutoComItens\(sessao, rec\);\s*const _fech = _cntConcluirAreasSemItens/.test(src), 'abrirContagem reabre antes de fechar');
check(/sessao\.escopo = escopoNovo;[\s\S]{0,200}_cntReabrirAreasAutoComItens\(sessao, rec\)/.test(src), 'troca de data revarre as areas');

console.log(`contagem-auto-reversivel: ${ok} ok, ${falha} falha(s)`);
process.exit(falha ? 1 : 0);
