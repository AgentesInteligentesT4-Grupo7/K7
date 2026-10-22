# Créditos e referências

Várias funcionalidades do ParreiraClaw foram desenhadas a partir do material do **Prof. Sandeco Macedo**
(Instituto Federal de Goiás e Universidade Federal de Goiás). Os textos de prompts e skills deste projeto
foram reescritos para o contexto do tocador; os livros e prompts originais não são reproduzidos aqui.

## Fontes do Prof. Sandeco Macedo

**Livros**

- MACEDO, Sandeco. *Prompts em Ação: Engenharia de Prompts para Leigos*. 2024.
- MACEDO, Sandeco. *Prompts em Ação, vol. 2: Guardrails*. 2025.
- MACEDO, Sandeco. *RAG: Retrieval-Augmented Generation*. 2025.

**Repositório de prompts**

- MACEDO, Sandeco. *prompts*. GitHub: <https://github.com/sandeco/prompts>.
- Canal Sandeco (YouTube).

## O que veio de onde

| Recurso do ParreiraClaw | Onde está | Base |
|---|---|---|
| Controles de texto 1–10 (complexidade, tom, sentimento, perspectiva, foco, surpresa, detalhe, originalidade, abstração) | `src/personas/TextControls.ts`, spec personas-styles §5.4 | *Prompts em Ação* (níveis de controle); prompt **PROMPT MATRIX** do repositório |
| Estilos de texto e padrões de escrita de prompts (papel e público, delimitadores, few-shot, instruções afirmativas, tarefa em passos, deixa de início) | `estilos/`, skills `criador-de-fitas` e `criador-de-prompts` | *Prompts em Ação* |
| Guardrails de entrada e saída, ações em caso de falha, detecção de injeção com avaliador em JSON, dados pessoais, palavras proibidas, restrição de tópico e abstenção | `src/guardrails/`, spec guardrails | *Prompts em Ação, vol. 2: Guardrails*; prompt **PROMPT INJECTION DETECT** |
| Base de conhecimento: fatiamento com sobreposição, busca híbrida, RRF, RAG-Fusion, HyDE, Adaptive RAG e CRAG | `src/modules/conhecimento/`, spec knowledge-base | *RAG: Retrieval-Augmented Generation* |
| Chain-of-Verification (modo `verificado`) | `src/agent/Reasoning.ts`, spec reasoning | *Prompts em Ação* |
| Rephrase and Respond (modo `reformular`) | `src/agent/Reasoning.ts`, spec reasoning | *Prompts em Ação, vol. 2* |
| Análise em etapas (Knowledge-Driven CoT) | skill `analise-em-etapas` | *Prompts em Ação* |
| Loop criador ↔ crítico | skill `idealizador-analisador` | prompt **REFLEXION** (idealizador/analisador) |
| Criador de prompts em rodadas (A: prompt revisado, B: sugestões, C: perguntas) | skill `criador-de-prompts` | *Prompts em Ação* (gerador de prompts); prompt **PROMPT ITERATIVO** |
| Debate entre agentes com feedback humano como guardrail (manter, descartar, nova ideia) e tabela de notas | `src/modules/refinamento/Debate.ts`, spec debate | *Prompts em Ação, vol. 2*; prompt **MULTIAGENTES EM DEBATE** |
| Combinar as melhores posições com uma variação nova | opção `combinar` do debate | prompt **PROMPT EVOLUTIVO** |

## Artigos originais das técnicas

As técnicas apresentadas nos livros vêm destes trabalhos:

- **Chain-of-Verification:** Dhuliawala et al., *Chain-of-Verification Reduces Hallucination in Large Language Models*, 2023.
- **Rephrase and Respond:** Deng et al., *Rephrase and Respond: Let Large Language Models Ask Better Questions for Themselves*, 2023.
- **Knowledge-Driven CoT:** Wang et al., *Knowledge-Driven CoT: Exploring Faithful Reasoning in LLMs for Knowledge-intensive Question Answering*, 2023.
- **Debate entre agentes:** Du et al., *Improving Factuality and Reasoning in Language Models through Multiagent Debate*, 2023.
- **RAG:** Lewis et al., *Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks*, 2020.
- **Reciprocal Rank Fusion:** Cormack, Clarke e Büttcher, *Reciprocal Rank Fusion Outperforms Condorcet and Individual Rank Learning Methods*, 2009.
- **RAG-Fusion:** Raudaschl, 2023.
- **HyDE:** Gao et al., *Precise Zero-Shot Dense Retrieval without Relevance Labels*, 2022.
- **CRAG:** Yan et al., *Corrective Retrieval Augmented Generation*, 2024.
- **Adaptive-RAG:** Jeong et al., *Adaptive-RAG: Learning to Adapt Retrieval-Augmented Large Language Models through Question Complexity*, 2024.
