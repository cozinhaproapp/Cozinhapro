// Constantes públicas do projeto Supabase (a anon key é pública por design —
// a mesma usada no app.src.html/login.src.html — não é segredo).
const SUPABASE_URL      = 'https://rqsrwgtprclvbicurqzn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJxc3J3Z3RwcmNsdmJpY3VycXpuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwNzAwMzksImV4cCI6MjA5NTY0NjAzOX0.ufJ2xClTEKCrZ6XSk_tfn8V2EKj0VFw3vpbML4TLd9A';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Exige uma sessão real do CozinhaPro (JWT do Supabase Auth) antes de qualquer
  // chamada paga à IA — sem isso, o endpoint ficava aberto para qualquer origem
  // gerar custo na conta Anthropic sem nenhuma credencial.
  // Nota: login por PIN de operador não gera JWT real hoje (usa a anon key como
  // Bearer), então por enquanto só sessões de admin (login normal) passam por aqui.
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Sessão não autenticada.' });
  try {
    const userCheck = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + token, apikey: SUPABASE_ANON_KEY },
    });
    if (!userCheck.ok) return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  } catch (e) {
    return res.status(401).json({ error: 'Falha ao validar sessão.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada.' });

  try {
    const { texto, tipo_hint, banco_hint, pdf_base64 } = req.body;
    
    // Modo imagens: quando texto está vazio (PDF baseado em imagem),
    // recebe array de imagens JPEG base64 renderizadas pelo browser.
    if (pdf_base64 && (!texto || texto.trim().length < 100)) {
      const promptPdfNativo = `Você é um parser de faturas de cartão de crédito empresarial brasileiro.
Analise esta fatura de cartão e retorne APENAS um objeto JSON válido, sem markdown, sem explicações.

A fatura pode ter múltiplos cartões (identificados por "final XXXX").
Extraia TODOS os lançamentos de compras de TODOS os cartões.
NÃO incluir: pagamentos de fatura, IOF, juros, encargos, totais de seção.

{
  "tipo": "fatura_cartao",
  "banco": "itau",
  "cartao_nome": "Nome do titular",
  "numero_conta": "XXXX.XXXX.XXXX.XXXX",
  "vencimento": "YYYY-MM-DD",
  "total_fatura": 0.0,
  "periodo": {"inicio": "YYYY-MM-DD", "fim": "YYYY-MM-DD"},
  "itens": [{
    "data": "YYYY-MM-DD",
    "cartao_final": "4 últimos dígitos",
    "estabelecimento": "Nome normalizado",
    "categoria_sugerida": "alimentacao|transporte|outros",
    "valor": 0.0,
    "parcelado": false,
    "parcela_atual": null,
    "total_parcelas": null
  }],
  "alertas": []
}

Regras:
- data: usar o ano do vencimento quando só mês/dia aparecer
- estabelecimento: normalizar para legível
- NÃO incluir totais, IOF, juros, pagamentos de fatura`;

      // pdf_base64 aqui é na verdade um array de imagens JPEG base64
      const imagens = Array.isArray(pdf_base64) ? pdf_base64 : [pdf_base64];
      const imgContent = [
        ...imagens.map(b64 => ({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: b64 }
        })),
        { type: 'text', text: promptPdfNativo }
      ];
      const pdfResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 8000,
          messages: [{ role: 'user', content: imgContent }]
        })
      });
      if (!pdfResponse.ok) {
        const errBody = await pdfResponse.text();
        console.error('[parse] Erro API Claude PDF:', pdfResponse.status, errBody.slice(0, 500));
        return res.status(200).json({ error: 'Erro API Claude: ' + pdfResponse.status + ' - ' + errBody.slice(0, 200) });
      }
      const pdfData = await pdfResponse.json();
      console.log('[parse] PDF response status:', pdfResponse.status, 'content blocks:', pdfData.content?.length);
      const pdfText = (pdfData.content || []).find(b => b.type === 'text')?.text || '';
      console.log('[parse] PDF texto extraído (primeiros 300):', pdfText.slice(0, 300));
      if (!pdfText) {
        return res.status(200).json({ error: 'IA não retornou texto. Stop reason: ' + pdfData.stop_reason + ' Error: ' + JSON.stringify(pdfData.error || {}) });
      }
      try {
        let clean = pdfText.replace(/```json|```/g, '').trim();
        // Tentar parsear direto
        try {
          const parsed = JSON.parse(clean);
          return res.status(200).json(parsed);
        } catch(e1) {
          // JSON truncado — tentar fechar arrays/objetos abertos
          const opens = (clean.match(/\{/g)||[]).length - (clean.match(/\}/g)||[]).length;
          const openArr = (clean.match(/\[/g)||[]).length - (clean.match(/\]/g)||[]).length;
          let fixed = clean;
          for (let i = 0; i < openArr; i++) fixed += ']';
          for (let i = 0; i < opens; i++) fixed += '}';
          try {
            const parsed2 = JSON.parse(fixed);
            console.warn('[parse] JSON estava truncado, fechado automaticamente');
            return res.status(200).json(parsed2);
          } catch(e2) {
            return res.status(200).json({ error: 'Falha ao parsear JSON: ' + e2.message + ' | texto: ' + pdfText.slice(0, 300) });
          }
        }
      } catch(e) {
        return res.status(200).json({ error: 'Falha ao parsear JSON: ' + e.message + ' | texto: ' + pdfText.slice(0, 300) });
      }
    }
    
    if (!texto || typeof texto !== 'string' || texto.trim().length === 0) return res.status(400).json({ error: 'Campo "texto" obrigatório e não pode ser vazio.' });

    const textoCortado = texto.length > 90000 ? texto.slice(0, 90000) + '\n[TRUNCADO]' : texto;

    // ─── Detecção de tipo pelo conteúdo ───────────────────────────────────
    const txt = textoCortado.toLowerCase();

    const isEstoque = tipo_hint === 'estoque'
      || txt.includes('preço médio') || txt.includes('preco medio')
      || txt.includes('estoque mínimo') || txt.includes('estoque minimo')
      || txt.includes('ficha técnica') || txt.includes('ficha tecnica')
      || (txt.includes('produto') && txt.includes('quantidade') && txt.includes('unidade') && txt.includes('categoria'));

    const isFechamento = tipo_hint === 'fechamento'
      || txt.includes('fechamento de frente de caixa')
      || txt.includes('conferência de caixa')
      || txt.includes('conferencia de caixa')
      || (txt.includes('faturamento') && txt.includes('forma pgto') && txt.includes('esperado'));

    const isCompras = tipo_hint === 'compras'
      || txt.includes('nota fiscal') || txt.includes('nf-e') || txt.includes('nfc-e')
      || txt.includes('documento auxiliar da nota')
      || (txt.includes('fornecedor') && txt.includes('valor total') && txt.includes('quantidade'));

    const isExtrato = tipo_hint === 'extrato'
      || txt.includes('saldo anterior') || txt.includes('saldo total disponível')
      || txt.includes('recebimento pix') || txt.includes('pagamento pix')
      || txt.includes('extrato de conta') || txt.includes('lançamentos do período')
      || txt.includes('lancamentos do periodo');

    const isVendasPDV = tipo_hint === 'vendas'
      || (txt.includes('tipo do pedido') && txt.includes('entregador'))
      || (txt.includes('canal') && txt.includes('ticket') && txt.includes('data da venda'));

    const isMarketplace = tipo_hint === 'marketplace'
      || (txt.includes('pedido') && txt.includes('valor líquido') && txt.includes('comissão'))
      || (txt.includes('pedidos') && txt.includes('receita') && txt.includes('dias'))
      || txt.includes('competencia') && txt.includes('tipo_lancamento')
      || txt.includes('entrada financeira') && txt.includes('retenção');

    const txtLower2 = txt;
    const isFaturaCartao = tipo_hint === 'fatura_cartao'
      || (txtLower2.includes('lançamentos: compras') && txtLower2.includes('vencimento'))
      || (txtLower2.includes('lancamentos: compras') && txtLower2.includes('vencimento'))
      || (txtLower2.includes('lancamentos') && txtLower2.includes('compras e saques') && txtLower2.includes('vencimento'))
      || (txtLower2.includes('fatura') && txtLower2.includes('limite de cr') && txtLower2.includes('total da fatura'))
      || (txtLower2.includes('resumo da fatura') || txtLower2.includes('total desta fatura'))
      || (txtLower2.includes('mastercard') && txtLower2.includes('vencimento'))
      || (txtLower2.includes('itaú') && txtLower2.includes('vencimento') && txtLower2.includes('lançamentos'))
      || (txtLower2.includes('itau') && txtLower2.includes('vencimento') && txtLower2.includes('lancamentos'))
      || (txtLower2.includes('bradesco') && txtLower2.includes('vencimento') && txtLower2.includes('lancamentos'))
      || (txtLower2.includes('nubank') && txtLower2.includes('vencimento'))
      || (txtLower2.includes('fatura') && txtLower2.includes('cartao') && txtLower2.includes('vencimento'));

    // ─── PROMPT: ESTOQUE ──────────────────────────────────────────────────
    const promptEstoque = `Extraia a lista de insumos/produtos do arquivo de estoque abaixo.
Retorne APENAS um array JSON compacto, sem espaços extras, sem markdown.
Formato de cada item: ["nome",qtd,"unidade",preco_medio,preco_ultimo,estoque_min,"categoria",tem_ficha,id_pdv]
onde:
- nome: string em minúsculo, sem acentos desnecessários
- qtd: float arredondado em 3 casas
- unidade: normalizar para "kg","g","L","ml","und","pct","mç" — sempre minúsculo
- preco_medio: float ou 0 se ausente
- preco_ultimo: float ou 0 se ausente — se for > preco_medio*10, usar 0 e marcar como anômalo
- estoque_min: float
- categoria: string em MAIÚSCULO ou "" se ausente/REF
- tem_ficha: 1 se "SIM", 0 se não
- id_pdv: número inteiro se disponível, 0 se não houver

Regras:
- Ignorar linhas de cabeçalho, totais, subtotais
- Categorias com #REF! ou fórmulas → ""
- Preço último > 1000 quando preço médio < 100 → provavelmente erro, usar 0
- Nomes: remover códigos de produto do início se houver

Exemplo: [111676,"presunto peca",12.132,"kg",21.61,21.70,0.0,"EMBUTIDOS",0,111676]
Comece com [ e termine com ]

ARQUIVO:
${textoCortado}`;

    // ─── PROMPT: FECHAMENTO DE CAIXA ──────────────────────────────────────
    const promptFechamento = `Você é um parser de fechamentos de caixa de restaurantes.
Analise o conteúdo e retorne APENAS um objeto JSON válido, sem markdown, sem explicações.

O arquivo pode ter dois formatos:
FORMATO A: "FECHAMENTO DE FRENTE DE CAIXA" — extrair da seção "FATURAMENTO" as linhas "Vendas/FormaPagamento VALOR"
FORMATO B: "Conferência de caixa" — extrair da tabela "Valores de conferência" a coluna "Valor sistema" (não "Valor informado")

Canais: dinheiro, credito, debito, pix, aiqfome, ifood, fiado, online, transferencia_interna, outro
Mapeamento de nomes comuns:
- "CAIXA (DINHEIRO)" / "Vendas/Dinheiro" → dinheiro
- "CREDITO REDE" / "CREDITO ELO" / "Vendas/Crédito" → credito
- "DEBITO REDE" / "DEBITO ELO" / "Vendas/Débito" → debito
- "PIX" / "Vendas/Pix" → pix
- "ONLINE AIQFOME" / "Vendas/Pago Online Aiqfome" → aiqfome
- "AIQFOME - CONFERIR" → aiqfome (apenas se valor > 0)
- "TRANSFERENCIA" com nome de cliente → pix (pagamento bancário de cliente)
- "Enviada transferência para FRENTE DE CAIXA" → transferencia_interna (ignorar no total)
- "CONTAS A RECEBER" / "Vendas/Fiado" → fiado
- "Pago Online" sem identificação → online (pendente_identificacao: true)
- "ifood" / "iFood" → ifood

Estrutura de retorno:
{
  "tipo": "fechamento_caixa",
  "data": "YYYY-MM-DD",
  "caixa": "salao|delivery|nome_do_caixa",
  "formato": "A|B",
  "total_vendas": 0.0,
  "itens": [{"forma":"","canal":"","valor":0.0,"pendente_identificacao":false}],
  "totais": {"abertura":0,"produtos":0,"servicos":0,"descontos":0,"saidas":0,"cancelamentos":0,"taxa_entrega":0,"taxa_servico":0},
  "retiradas": [{"desc":"","valor":0.0}],
  "transferencias_internas": [{"destino":"","valor":0.0}]
}

Regras:
- Usar SEMPRE valores da seção FATURAMENTO ou coluna "Valor sistema", nunca "Valor informado"
- Retiradas com nome de entregador → categoria "entregadores"
- Transferências entre caixas → transferencias_internas (não somar ao total)
- Dinheiro em caixa (total físico) ≠ Vendas/Dinheiro (o que foi vendido) — usar Vendas/Dinheiro
- "Motivo de acréscimo" com "AIQFOME" ou "IFOOD" → canal_marketplace identificado

ARQUIVO:
${textoCortado}`;

    // ─── PROMPT: COMPRAS / NF ─────────────────────────────────────────────
    const promptCompras = `Você é um parser de notas fiscais e planilhas de compras de restaurantes.
Analise o conteúdo e retorne APENAS um objeto JSON válido, sem markdown.

Detecte o subtipo:
- "nfce": Nota Fiscal de Consumidor Eletrônica (DANFE, tem Chave de acesso 44 dígitos)
- "planilha": Planilha de controle de compras (múltiplas linhas, fornecedores variados)
- "nfe": Nota Fiscal Eletrônica B2B

Estrutura:
{
  "tipo": "compras_nfs",
  "subtipo": "nfce|planilha|nfe",
  "fornecedor": "",
  "cnpj_fornecedor": "",
  "data": "YYYY-MM-DD",
  "data_pagamento": "YYYY-MM-DD ou null",
  "nf_numero": null,
  "chave_acesso": null,
  "valor_bruto": 0.0,
  "desconto": 0.0,
  "valor_pago": 0.0,
  "fator_desconto": 1.0,
  "forma_pagamento": "",
  "itens": [{
    "nomeOriginal": "",
    "nomeNormalizado": "",
    "codigo_fiscal": null,
    "fornecedor": "",
    "categoria": "",
    "quantidade": 0.0,
    "unidade": "",
    "valor_total_bruto": 0.0,
    "valor_total_pago": 0.0,
    "custo_unitario": 0.0,
    "data": "YYYY-MM-DD",
    "data_pagamento": null
  }],
  "alertas": []
}

Regras:
- nomeNormalizado: minúsculo, sem código fiscal no início
- unidade: normalizar para kg, g, L, ml, und, pct
- fator_desconto = valor_pago / valor_bruto (se houver desconto)
- valor_total_pago = valor_total_bruto × fator_desconto
- custo_unitario = valor_total_pago / quantidade
- Para planilhas: cada linha é um item; fornecedor vem da coluna LOCAL/Fornecedor
- Categoria com #REF! → ""
- Para NFC-e: chave_acesso sem espaços (44 dígitos contínuos)
- Alertas: ["preco_anomalo"] se custo_unitario > 500 e não for equipamento/serviço

ARQUIVO:
${textoCortado}`;

    // ─── PROMPT: EXTRATO BANCÁRIO ─────────────────────────────────────────
    const promptExtrato = `Você é um parser de extratos bancários brasileiros de restaurantes.
Analise o conteúdo e retorne APENAS um objeto JSON válido, sem markdown.

Detecte o banco pelo conteúdo:
- "itau": tem "RECEBIMENTO REDE", "SALDO TOTAL DISPONÍVEL DIA", logo itaú
- "sicredi": tem "Cooperativa", "PIX_CRED", "PIX_DEB"
- "mercadopago": tem "Pagamento com Código QR", "Liberação de dinheiro", "mercado pago"
- "outro": qualquer outro banco

CNPJ próprio da empresa (mesmo CNPJ aparecendo como remetente = transferência interna):
Detecte o CNPJ do titular na primeira página e marque transferencias_interna quando ele aparece.

Filtrar (NÃO incluir como itens):
- "SALDO TOTAL DISPONÍVEL DIA" (Itaú)
- "SALDO ANTERIOR"
- "Lançamentos Futuros"
- Linhas de cabeçalho e rodapé

Categorias sugeridas:
- "RECEBIMENTO REDE * CD" → receita_cartao_credito
- "RECEBIMENTO REDE * DB" → receita_cartao_debito
- "IFOOD" / "TED RECEBIDA IFOOD" → receita_ifood
- "PIX RECEBIDO HUB" → receita_aiqfome
- "PIX RECEBIDO" + mesmo CNPJ → transferencia_interna
- "Pix enviado Rmbb" / "Pix enviado" + mesmo CNPJ → transferencia_interna
- "Liberação de dinheiro" (MP) → transferencia_interna
- "BOLETO PAGO" → compras
- "PIX ENVIADO" + CPF pessoa física → pro_labore_ou_salario
- "PAGAMENTOS TRIB" / "RECEITA FEDERAL" / "CEF MATRIZ" → impostos
- "PARCELA GIRO" / "BUSINESS" → financiamento
- "RENDIMENTOS" → receita_financeira
- "SANEPAR" / "COPEL" / "ENERGIA" / "GAS" → utilidades
- "FACEBOOK" / "GOOGLE" → marketing
- "Pagamento com Código QR Pix" (MP/Sicredi) → receita_pix
- "PAGAMENTO PIX" + alto valor + CPF → salario_ou_fornecedor
- "CESTA" / "TARIFA" → tarifa_bancaria

Estrutura:
{
  "tipo": "extrato_bancario",
  "banco": "itau|sicredi|mercadopago|outro",
  "conta": "",
  "periodo": {"inicio": "YYYY-MM-DD", "fim": "YYYY-MM-DD"},
  "saldo_inicial": 0.0,
  "saldo_final": 0.0,
  "cnpj_titular": "",
  "itens": [{
    "data": "YYYY-MM-DD",
    "descricao": "",
    "razao": "",
    "cnpj_cpf": "",
    "valor": 0.0,
    "tipo": "entrada|saida",
    "categoria_sugerida": "",
    "transferencia_interna": false
  }]
}

${banco_hint ? 'Banco informado pelo usuário: ' + banco_hint : ''}

ARQUIVO:
${textoCortado}`;

    // ─── PROMPT: MARKETPLACE ─────────────────────────────────────────────
    const promptMarketplace = `Você é um parser de relatórios de marketplaces de delivery (iFood, AiQfome, etc).
Analise o conteúdo e retorne APENAS um objeto JSON válido, sem markdown.

Detecte o subtipo:
- "financeiro": tem lançamentos por pedido com comissões, taxas, repasses (ex: extrato iFood CSV)
- "diario": resumo diário com Dias/Pedidos/Receita
- "vendas": relatório de vendas com abas (Vendas, Horários, Formas de pagamento)
- "pedidos": pedido a pedido com valor líquido e comissão

Para subtipo "financeiro" — agrupar por pedido_associado:
{
  "tipo": "relatorio_marketplace",
  "canal": "ifood|aiqfome|outro",
  "subtipo": "financeiro",
  "periodo": {"inicio": "YYYY-MM-DD", "fim": "YYYY-MM-DD"},
  "totais": {
    "bruto": 0.0, "comissoes": 0.0, "taxas_transacao": 0.0,
    "retencoes": 0.0, "reembolsos": 0.0, "subsidios": 0.0,
    "cobranças_fixas": 0.0, "liquido": 0.0
  },
  "repasses": [{"data": "YYYY-MM-DD", "valor_estimado": null}],
  "pedidos": [{
    "id_curto": "",
    "data_pedido": "YYYY-MM-DD",
    "data_repasse": "YYYY-MM-DD",
    "valor_bruto": 0.0, "comissao": 0.0, "taxa_transacao": 0.0,
    "subsidio": 0.0, "liquido": 0.0,
    "metodo": "", "bandeira": ""
  }],
  "cobranças_fixas": [{"descricao": "", "valor": 0.0, "categoria": "taxas_marketplace"}],
  "alertas": []
}

Para subtipo "diario":
{
  "tipo": "relatorio_marketplace",
  "canal": "ifood|aiqfome|outro",
  "subtipo": "diario",
  "periodo": {"inicio": "YYYY-MM-DD", "fim": "YYYY-MM-DD"},
  "itens": [{"data": "YYYY-MM-DD", "pedidos": 0, "receita": 0.0, "ticket_medio": 0.0}],
  "totais": {"pedidos": 0, "receita": 0.0, "dias_operacao": 0, "dias_fechado": 0, "ticket_medio_geral": 0.0}
}

Para subtipo "vendas" (XLSX com múltiplas abas):
{
  "tipo": "relatorio_marketplace",
  "canal": "ifood|aiqfome|outro",
  "subtipo": "vendas",
  "periodo": {"inicio": "YYYY-MM-DD", "fim": "YYYY-MM-DD"},
  "loja": "",
  "kpis": {"pedidos": 0, "receita": 0.0, "ticket_medio": 0.0, "novos_clientes": 0},
  "por_dia_semana": [{"dia": "", "pedidos": 0}],
  "por_horario": [{"horario": "", "periodo": "semana|fds", "pedidos": 0}],
  "por_pagamento": [{"forma": "", "pedidos": 0}]
}

Para subtipo "pedidos" (pedido a pedido, com valor líquido e comissão — iFood ou AiQfome):
{
  "tipo": "relatorio_marketplace",
  "canal": "ifood|aiqfome",
  "subtipo": "pedidos",
  "loja": "",
  "itens": [{
    "pedido_id": "",
    "data": "YYYY-MM-DD",
    "loja": "",
    "forma_pagamento": "",
    "atendimento": "delivery|balcao",
    "valor_bruto": 0.0, "valor_liquido": 0.0,
    "taxa_conveniencia": 0.0, "valor_entrega": 0.0,
    "comissao": 0.0, "cupom_valor": 0.0,
    "status": ""
  }]
}

${tipo_hint ? '- Canal/tipo esperado: ' + tipo_hint : ''}

ARQUIVO:
${textoCortado}`;

    // ─── PROMPT: VENDAS PDV ───────────────────────────────────────────────
    const promptVendasPDV = `Você é um parser de relatórios de vendas de sistemas PDV de restaurantes.
Analise o conteúdo e retorne APENAS um objeto JSON válido, sem markdown.

Tipos de pedido comuns: D=Delivery, M=Mesa, F=Ficha, B=Balcão

Mapeamento canal_tipo:
- D ou "DELIVERY" → delivery
- M ou "MESA" ou "SALÃO" → salao
- F ou "FICHA" → ficha
- B ou "BALCÃO" → balcao

Para identificar canal_marketplace a partir do campo "Motivo de acréscimo":
- contém "AIQFOME" → aiqfome
- contém "IFOOD" → ifood
- contém "APP" ou "PAGO ONLINE" sem marketplace → online

Estrutura:
{
  "tipo": "vendas_pdv",
  "periodo": {"inicio": "YYYY-MM-DD", "fim": "YYYY-MM-DD"},
  "itens": [{
    "data": "YYYY-MM-DD",
    "hora": "HH:MM",
    "tipo_pedido": "D|M|F|B",
    "canal_tipo": "delivery|salao|ficha|balcao",
    "canal_marketplace": null,
    "formas_pagamento": [],
    "entregador": null,
    "bairro": null,
    "valor_itens": 0.0,
    "taxa_entrega": 0.0,
    "taxa_servico": 0.0,
    "acrescimo": 0.0,
    "desconto": 0.0,
    "total": 0.0
  }],
  "totais": {
    "pedidos": 0, "faturamento": 0.0, "ticket_medio": 0.0,
    "cancelamentos": 0, "taxa_entrega_total": 0.0, "descontos_total": 0.0
  }
}

ARQUIVO:
${textoCortado}`;

    // ─── PROMPT GERAL (fallback) ──────────────────────────────────────────
    const promptGeral = `Você é um parser de arquivos financeiros para restaurantes.
Analise o conteúdo e retorne APENAS um objeto JSON válido, sem markdown, sem explicações.
Comece com { e termine com }

Tipos possíveis: fechamento_caixa, vendas_pdv, extrato_bancario, compras_nfs, estoque,
relatorio_marketplace, relatorio_cartao_vendas, relatorio_cartao_recebimentos, itens_vendidos, fatura_cartao

Estrutura base:
{
  "tipo": "...",
  "fonte": null,
  "periodo": null,
  "data": null,
  "itens": [],
  "totais": {},
  "alertas": []
}

Itens por tipo:
- fechamento_caixa: [{"forma":"","canal":"dinheiro|credito|debito|pix|aiqfome|ifood|online|fiado|outro","valor":0.0,"pendente_identificacao":false}]
- vendas_pdv: [{"data":"YYYY-MM-DD","canal_tipo":"delivery|salao|ficha|balcao","canal_marketplace":null,"formas_pagamento":[],"total":0.0}]
- extrato_bancario: [{"data":"YYYY-MM-DD","descricao":"","razao":"","valor":0.0,"tipo":"entrada|saida","categoria_sugerida":"","transferencia_interna":false}]
- compras_nfs: [{"nomeNormalizado":"","fornecedor":"","categoria":"","quantidade":0.0,"unidade":"","valor_total_pago":0.0,"custo_unitario":0.0,"data":"YYYY-MM-DD","data_pagamento":null}]
- itens_vendidos: [{"produto":"","nivel":1,"categoria_pai":null,"qtde":0,"valor_total":0.0}]
- fatura_cartao: [{"data":"YYYY-MM-DD","cartao_final":"","estabelecimento":"","categoria_sugerida":"","valor":0.0,"parcelado":false,"revisar":false}]
  IMPORTANTE para fatura_cartao: valor POSITIVO = compra/gasto. valor NEGATIVO = estorno, reembolso, ajuste crédito, cancelamento. Estornos reduzem o valor da fatura — identificar pelo prefixo "ESTORNO", "AJUSTE CRÉDITO", "REEMBOLSO", "CRÉDITO" ou valor que aparece como abatimento.
- relatorio_marketplace: ver estrutura por subtipo (financeiro|diario|vendas|pedidos)
- relatorio_cartao_recebimentos: [{"data":"YYYY-MM-DD","modalidade":"credito|debito|pix","total_bruto":0.0,"taxa":0.0,"total_liquido":0.0,"qtde":0}]

${tipo_hint ? '- Tipo esperado: ' + tipo_hint : ''}

Regras gerais:
- Valores sempre float
- Datas sempre YYYY-MM-DD
- Campos ausentes = null
- Nomes de insumos/produtos em minúsculo
- Fornecedores normalizados (minúsculo, sem espaços extras)
- "Pago Online" sem identificação de marketplace → canal "online", pendente_identificacao: true

ARQUIVO:
${textoCortado}`;

    // ─── Seleciona prompt ─────────────────────────────────────────────────
    let prompt;
    if      (isEstoque)      prompt = promptEstoque;
    else if (isFechamento)   prompt = promptFechamento;
    else if (isCompras)      prompt = promptCompras;
    else if (isExtrato)      prompt = promptExtrato;
    else if (isMarketplace)  prompt = promptMarketplace;
    else if (isVendasPDV)    prompt = promptVendasPDV;
    else                     prompt = promptGeral;

    // ─── Chamada Anthropic ────────────────────────────────────────────────
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.error?.message || 'Erro Anthropic' });
    }

    const data = await response.json();
    const raw  = (data.content?.[0]?.text || '').trim();

    // Limpa markdown se presente
    let jsonStr = raw;
    if (jsonStr.includes('```')) {
      const m = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (m) jsonStr = m[1].trim();
    }

    // ─── Parse da resposta ────────────────────────────────────────────────
    let parsed;

    if (isEstoque) {
      // Estoque retorna array compacto
      const firstBracket = jsonStr.indexOf('[');
      const lastBracket  = jsonStr.lastIndexOf(']');
      if (firstBracket >= 0 && lastBracket > firstBracket) {
        jsonStr = jsonStr.slice(firstBracket, lastBracket + 1);
      }
      const arr = JSON.parse(jsonStr);

      // Normaliza unidades
      const normUnit = u => {
        if (!u) return 'und';
        const s = String(u).toLowerCase().trim();
        if (['kg','kilo','quilograma'].includes(s)) return 'kg';
        if (['g','gr','grama'].includes(s)) return 'g';
        if (['l','lt','litro','litros'].includes(s)) return 'L';
        if (['ml','mililitro'].includes(s)) return 'ml';
        if (['un','und','unid','unidade','uni'].includes(s)) return 'und';
        if (['pct','pacote','pct.'].includes(s)) return 'pct';
        return s;
      };

      const itens = arr.map(r => {
        const precoUlt = parseFloat(r[4]) || 0;
        const precoMed = parseFloat(r[3]) || 0;
        const anomalo  = precoUlt > 0 && precoMed > 0 && precoUlt > precoMed * 10;
        return {
          id_pdv:         parseInt(r[8]) || 0,
          produto:        String(r[0] || '').toLowerCase().trim(),
          quantidade:     Math.round((parseFloat(r[1]) || 0) * 1000) / 1000,
          unidade:        normUnit(r[2]),
          preco_medio:    Math.round((precoMed) * 100) / 100,
          preco_ultimo:   anomalo ? 0 : Math.round(precoUlt * 100) / 100,
          estoque_minimo: parseFloat(r[5]) || 0,
          categoria:      String(r[6] || '').toUpperCase().replace('#REF!','').trim(),
          tem_ficha:      r[7] === 1 || r[7] === true,
          alertas:        anomalo ? ['preco_ultimo_anomalo'] : [],
        };
      });

      parsed = { tipo: 'estoque', fonte: null, periodo: null, data: null, itens, totais: {}, alertas: [] };

    } else {
      // Todos os outros tipos retornam objeto
      const first = jsonStr.indexOf('{');
      const last  = jsonStr.lastIndexOf('}');
      if (first >= 0 && last > first) jsonStr = jsonStr.slice(first, last + 1);
      parsed = JSON.parse(jsonStr);

      // Pós-processamento: normaliza fornecedores em compras_nfs
      if (parsed.tipo === 'compras_nfs' && Array.isArray(parsed.itens)) {
        parsed.itens = parsed.itens.map(it => ({
          ...it,
          fornecedor: (it.fornecedor || '').toLowerCase().trim().replace(/\s+/g, ' '),
          nomeNormalizado: (it.nomeNormalizado || it.produto || '').toLowerCase().trim(),
          unidade: (() => {
            const s = String(it.unidade || 'und').toLowerCase().trim();
            if (['kg','kilo'].includes(s)) return 'kg';
            if (['l','lt','litro'].includes(s)) return 'L';
            if (['un','und','unid'].includes(s)) return 'und';
            return s;
          })(),
          data_pagamento: it.data_pagamento || null,
        }));
      }

      // Pós-processamento: marca pendente_identificacao em fechamento_caixa
      if (parsed.tipo === 'fechamento_caixa' && Array.isArray(parsed.itens)) {
        parsed.itens = parsed.itens.map(it => ({
          ...it,
          pendente_identificacao: it.pendente_identificacao || it.canal === 'online',
        }));
      }
    }

    return res.status(200).json({ resultado: parsed, uso: data.usage || {} });

  } catch (err) {
    return res.status(422).json({ error: 'IA retornou JSON inválido: ' + err.message });
  }
}
