# Spec: Modos de raciocínio (RaR, CoVe) e análise em etapas

**Versão:** 1.0
**Status:** Implementada (v1.0)
**Autor:** ParreiraClaw Agent
**Data:** 2026-10-22
**Reviewers:** Parreira

---

## 1. Resumo

Três técnicas de engenharia de prompt viram recursos do tocador:

| Técnica | Onde | Custo |
|---|---|---|
| **RaR** (*Rephrase and Respond*, duas etapas): o LLM reescreve e detalha a pergunta antes da resposta | modo `reformular` | +1 pedido |
| **CoVe** (*Chain-of-Verification*): rascunho → perguntas de verificação → respostas independentes (sem ver o rascunho) → resposta revisada | modo `verificado` | +3 pedidos (+1 quando não há o que verificar) |
| **Análise em etapas** (raciocínio guiado por conhecimento): entender → decompor → resolver as partes citando a origem dos fatos → limites → síntese | skill `analise-em-etapas` (módulo `refinamento`) | o da skill |

## 2. Escolha do modo

Precedência: `modo=<nome>` na mensagem (só ela; o token sai do texto) → `/modo <nome>` (salvo por usuário em
`user_settings`) → `modo_padrao` do `perfil.yaml` (ou `MODO_PADRAO`) → `normal`.
Apelidos: `rar` = reformular; `cove`, `verificar` = verificado; `padrao` = normal.

## 3. Requisitos

| ID | Requisito |
|---|---|
| RF-01 | RaR: a pergunta reformulada é acrescentada à mensagem atual só na requisição; o histórico salvo guarda a original |
| RF-02 | CoVe: as perguntas de verificação (até 4) são respondidas num pedido que NÃO contém o rascunho, para não repetir os erros dele |
| RF-03 | CoVe não roda sobre o loop criador ↔ crítico (que já é uma revisão) |
| RF-04 | Falha de qualquer etapa = segue com o que tem (pergunta original ou rascunho), com aviso no log |
| RF-05 | Os guardrails de saída rodam sobre a resposta final (depois da revisão) |
| RF-06 | Metadata da resposta: `mode` e `verification: { questions, changed }` |
| RF-07 | Etapas usam o LLM principal com a tarefa `raciocinio` (o orquestrador escolhe o modelo) |

## Referências

- MACEDO, Sandeco. *Prompts em Ação: Engenharia de Prompts para Leigos*. 2024. (Chain-of-Verification, Knowledge-Driven CoT).
- MACEDO, Sandeco. *Prompts em Ação, vol. 2: Guardrails*. 2025. (Rephrase and Respond).
- Detalhes e artigos originais: [CREDITOS.md](../CREDITOS.md).
