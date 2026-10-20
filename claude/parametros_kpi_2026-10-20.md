# Parâmetros de KPI do sistema — Chama Piloto

Referência única dos cortes de indicadores (faixas verde/amarelo/vermelho) e da
composição da DRE usados no app (`app.src.html`). Origem: decisões dos painéis de
controle (Artesano), consolidadas nesta sessão. Fonte de verdade no código: o
objeto `REF` + helpers (`faixaStatus`, `cmvStatus`, `cmvCor*`, `faixaCor*`),
declarados logo antes de `DRE_CAT_MAP`.

> Mudar qualquer faixa = **uma linha no `REF`**. Não há mais thresholds espalhados.

## Faixas de KPI (`REF`)

| Indicador | Fórmula | 🟢 verde | 🟡 amarelo | 🔴 vermelho | Origem |
|---|---|---|---|---|---|
| **CMV %** | `cmv / receita_bruta` | ≤ 28 | 28–35 | > 35 | **Rodrigo, 20/10** (mantém o 35 do sistema; sobrepõe o 32 do painel 12/10) |
| **Mão de obra %** | `salarios / receita_bruta` *(já sem pró-labore)* | ≤ 25 | 25–30 | > 30 | painel 12/10 |
| **Prime cost %** | `(cmv + salarios) / receita_bruta` *(já sem pró-labore)* | ≤ 50 | 50–55 | > 55 | painel 12/10 |
| **Ocupação (aluguel) %** | `aluguel / receita_bruta` | ≤ 7 | — | > 7 | painel 12/10 |
| **Marketing %** | `marketing / receita_bruta` | 3–5 | < 3 ou 5–6 | > 6 | painel 12/10 |
| **Energia+gás+água %** | `energia / receita_bruta` *(energia já soma os três)* | ≤ 5 | — | > 5 | painel 12/10 |
| **Margem líquida %** | `lucro_liq / receita_bruta` | ≥ 10 | 5–10 | < 5 | faixa que a análise da DRE já usava (formalizada) |
| Margem bruta % | `lucro_bruto / receita_bruta` | — | — | — | **sem faixa decidida** (exibido sem cor) |
| Custos fixos % | `(aluguel+energia+admin+salarios) / receita_bruta` | — | — | — | **sem faixa decidida** (exibido sem cor) |
| Resultado operacional % | `ro / receita_bruta` | ≥ 15 | 10–15 | < 10 | painel 12/10 — **não implementado** (depende da estrutura da DRE; ver abaixo) |

Constante relacionada: `PL_MENSAL = 3560` (pró-labore do dono; usada só pela etapa
futura de MO/prime "sem pró-labore" — hoje não é necessária porque `salarios` já
exclui o pró-labore).

## CMV por prato (ficha técnica)

Mesma faixa do CMV agregado: 🟢 ≤28% · 🟡 28–35% · 🔴 >35%. Aplicada em Custos,
Precificação, Dashboard, DRE e alertas — todas via `cmvStatus()`.

## Composição da DRE

Receita bruta → (−) **deduções** (DAS/impostos, taxa Rede, comissões iFood/AiQfome)
→ Receita líquida → (−) **CMV** (insumos + embalagem) → (−) **variáveis** (marketing,
tecnologia, frete, apoio, manutenção, outros) → (−) **mão de obra** (`salarios`:
salário, benefícios, FGTS/INSS, sindicato, terceiros) → (−) **fixos** (aluguel,
energia/gás/água, contabilidade/associações/administrativo) → **EBITDA / resultado
operacional** → (+/−) resultado financeiro, impostos, financiamento → **Lucro líquido**
→ (−) investimentos, distribuições → **Caixa disponível**.

### Decisão sobre o pró-labore (20/10)
- **Mantido abaixo da linha**, como distribuição (`pro_labore → distribuicao → null`
  no `DRE_CAT_MAP`), **não** como custo de mão de obra.
- Consequência boa: os KPIs de **MO% e prime cost já são "sem pró-labore"** por
  construção, batendo direto com as faixas 12/10.
- Não foi adotado o modelo do painel (pró-labore do dono como custo, reduzindo o
  resultado operacional) para **não mudar números históricos** e porque exigiria
  distinguir o pró-labore do dono do da Bibyana (campo que não existe hoje).
- Por isso o **Resultado operacional %** não foi fiado como KPI: dependeria de
  definir qual linha do app = "resultado operacional" do painel.

## Fora do sistema: tetos da Família

Os tetos por categoria e o teto de retirada da família **não pertencem ao Chama
Piloto** — são do Dinzo (finanças pessoais). Registrados aqui só para constar:
Mercado 1.800 · Carro 3.250 · Saúde 1.600 · Educação 1.850 · Roupas 1.570 ·
Assinaturas 900 · Alimentação fora 900 · Casa 700 · Lazer 350 · Viagens 300 ·
Cuidado pessoal 150 · Pets 80 · Outros 50 → soma 13.520; teto de retirada = soma +
1.500 de reserva ≈ 15.020.

## Estado de implementação no código

- **Centralização + faixas de CMV (28/35):** branch `claude/cozinhapro-kpi-faixas-ref`
  (PR aberto). Efeito líquido vs. `main`: só centralização — o comportamento do CMV
  (28/35) não muda.
- **Indicadores novos com faixa na DRE** (MO%, prime, ocupação, marketing, utilidades
  + cor em CMV% e margem líquida): branch `claude/cozinhapro-kpi-nivel2-indicadores`
  (empilhada; sem PR ainda).
- **Resultado operacional %** e reestruturação da DRE para pró-labore-como-custo:
  não feitos (decisão acima).
