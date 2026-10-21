# Spec: Orquestração de LLMs Gratuitos (Catálogo, Ranking e Roteamento)

**Versão:** 1.0
**Status:** Implementada (v1.0) — 2026-10-20
**Autor:** AgroMinds Agent
**Data:** 2026-10-19
**Reviewers:** Agro

---

## 1. Resumo

Um **orquestrador** escolhe, para cada tarefa, o melhor LLM **entre fontes exclusivamente gratuitas**: modelos gratuitos do OpenCode Zen, OpenRouter e NVIDIA, os planos gratuitos de Gemini e Groq, e o Ollama local. A descoberta dos modelos é automática, a partir do catálogo aberto [models.dev](https://models.dev); a ordenação por tarefa é **medida** com testes próprios; e quando um provedor esgota a cota gratuita, o orquestrador **reveza** para o próximo. Uma trava garante que **nenhum modelo pago** seja chamado.

---

## 2. Contexto e Motivação

**Problema:**
- A cadeia de LLMs é fixa no `.env` (`LLM_PROVIDER=gemini`, `LLM_FALLBACK_PROVIDERS=ollama`). Adicionar um modelo exige editar configuração e código.
- O plano gratuito do Gemini esgota (HTTP 429 "You exceeded your current quota", observado em 2026-10-18), e a única saída hoje é o modelo local, mais fraco em perguntas factuais.
- Não há critério de "qual modelo é melhor para qual tarefa": a mesma cadeia atende conversa, código, visão e resumo de memória.

**Evidências:**
- O catálogo `models.dev/api.json` (consultado em 2026-10-19) tem 232 provedores, com metadados por modelo: `tool_call`, `reasoning`, `attachment`, `modalities` (imagem, PDF, áudio), `limit` (contexto e saída), `cost`, `knowledge` e `release_date`.
- O **OpenCode Zen** (OpenAI-compatível) lista 128 modelos, **45 gratuitos e todos com suporte a ferramentas** (sufixo `-free`, mais `big-pickle` e `grok-code`) ([docs](https://dev.opencode.ai/docs/zen)).
- No catálogo, **custo zero não significa gratuito:** provedores `*-coding-plan`, `*-token-plan` e GitLab Duo aparecem com custo zero por estarem incluídos em assinaturas pagas. Já Gemini e Groq aparecem com preço, mas são gratuitos na conta do usuário enquanto não houver faturamento ativo.

**Por que agora:**
O usuário definiu como requisito **não gastar tokens pagos**. Com várias fontes gratuitas e limitadas, revezar entre elas é a única forma de ter qualidade e disponibilidade a custo zero.

---

## 3. Goals (Objetivos)

- [ ] G-01: **Custo zero garantido:** só fontes da lista fechada de gratuitas; qualquer modelo com custo é recusado antes da chamada.
- [ ] G-02: **Descoberta automática** de modelos gratuitos a partir do models.dev, sem cadastro manual de cada modelo.
- [ ] G-03: **Classificação da tarefa** e escolha do modelo pelos requisitos (ferramentas, visão, contexto) e pela qualidade medida.
- [ ] G-04: **Revezamento de cotas:** ao receber 429 ou cota esgotada, desvia para o próximo modelo gratuito e respeita o tempo de espera.
- [ ] G-05: **Privacidade por tarefa:** dados pessoais (memória, documentos, voz) não vão para modelos gratuitos que usam os dados para treino.

**Métricas de sucesso:**
| Métrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Gasto com LLM | R$ 0 (só gratuito hoje) | R$ 0, garantido pela trava | Sempre |
| Respostas que caem no modelo local por cota esgotada | Frequentes quando o Gemini esgota | < 10% | MVP |
| Acerto no conjunto de referência por tarefa (ex.: 20 perguntas factuais) | Variável por modelo | O modelo nº 1 de cada tarefa ≥ 90% | MVP |
| Esforço para adicionar um modelo gratuito novo | Editar código/.env | Zero: aparece no próximo sync do catálogo | MVP |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: **Qualquer modelo ou plano pago**, inclusive assinaturas (`coding-plan`, `token-plan`, GitLab Duo).
- NG-02: **Reutilizar logins de assinaturas do OpenCode** (Claude Pro, Copilot etc.) em outro programa. Viola os termos desses serviços. O acesso ao Zen é apenas pela chave de API.
- NG-03: Benchmarks públicos como fonte única de qualidade. Servem de ponto de partida; quem decide é a medição própria.
- NG-04: Delegar tarefas de programação ao OpenCode (`opencode serve`). Fica para uma versão futura.
- NG-05: **Hermes Agent** como fonte de modelos. O Hermes é um agente (como o Claude Code), não um provedor; o plano gratuito dele é uma identidade anônima da Nous emitida para o próprio app (modelo único `nous/welcome`, `hermes_cli/anon_auth.py`). Usar esse token em outro programa seria se passar pelo Hermes. Nenhum provedor do catálogo oferece modelos Hermes gratuitos.

---

## 5. Usuários e Personas

**Usuário primário:** Agro, que quer respostas boas pelo Telegram e pelo terminal **sem nenhum custo**, e aceita que conversas genéricas passem por modelos gratuitos de terceiros, mas não seus dados pessoais.

---

## 6. Requisitos Funcionais

### 6.1 Requisitos Principais

| ID | Requisito | Prioridade | Critério de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | **Lista fechada de fontes gratuitas** (`FREE_SOURCES`), cada uma com a regra que define "gratuito": `opencode` (ids com `-free`, `big-pickle`, `grok-code`; liga/desliga com `OPENCODE_ENABLED`), `openrouter` (ids com `:free`), `nvidia` (API gratuita do build.nvidia.com), `gemini` e `groq` (planos gratuitos da conta do usuário), `ollama` (local, na GPU) e `ollama-cloud` (modelos `:cloud` do Ollama, plano gratuito da conta ollama.com; exigem `ollama signin`). | Must | Modelo fora dessas regras nunca entra no ranking. |
| RF-02 | **Trava de custo** (`LLM_COST_POLICY=free-only`): antes de cada chamada, o orquestrador confere a fonte e o custo no catálogo; se o modelo não for gratuito, a chamada é **bloqueada** e logada. Provedores `*-plan` e GitLab Duo são sempre excluídos. | Must | Teste: forçar um modelo pago gera erro de política, sem requisição externa. |
| RF-03 | **Sincronização do catálogo:** baixa `models.dev/api.json` no startup e a cada 24 h, salva em cache local e extrai os modelos gratuitos das fontes do RF-01 com seus metadados. Sem internet, usa o último cache. | Must | Um modelo `-free` novo no Zen aparece no ranking no dia seguinte, sem mudança de código. |
| RF-04 | **Classificação da tarefa** no passo zero (junto do SkillRouter, numa única chamada barata): `conversa`, `raciocinio`, `codigo`, `visao`, `pesquisa`, `resumo_memoria`, `roteamento`. | Must | "Explique este erro de TypeScript" → `codigo`; foto com pergunta → `visao`. |
| RF-05 | **Filtro por requisitos** do catálogo: o AgentLoop exige `tool_call`; `visao` exige imagem em `modalities.input`; o contexto exige `limit.context` maior que o contexto montado + margem. | Must | Uma imagem nunca vai para modelo sem visão. |
| RF-06 | **Ranking por tarefa**, numa tabela local: nota de qualidade (dos testes do RF-07), taxa de sucesso, latência e frescor (`release_date`). Com avaliação, a nota é **só a medição**; sem avaliação, uma estimativa pelos metadados (tamanho, recência). **GPU × nuvem:** o modelo local só passa à frente se a nota dele for igual ou maior que a do melhor gratuito da nuvem; em empate vence o local (privado, sem cota). Modelos locais que não cabem na VRAM são penalizados (rodariam na CPU). | Must | `/modelos codigo` mostra o top 8 com as notas e onde roda (local/GPU, local/CPU ou fonte). |
| RF-07 | **Avaliação própria:** conjuntos de referência por tarefa (`evals/<tarefa>.yaml`, com perguntas e critério de acerto) rodados por `npm run eval` nos candidatos gratuitos. A nota alimenta o ranking. Respeita as cotas e roda devagar. | Must | Depois de `npm run eval -- pesquisa`, o ranking de `pesquisa` reflete os acertos medidos. |
| RF-08 | **Revezamento de cotas:** HTTP 429 ou erro de cota coloca o modelo/provedor em *cooldown* (o `Retry-After` ou um padrão crescente: 1 min, 10 min, até a virada do dia nas cotas diárias) e passa para o próximo do ranking. | Must | Com o Gemini em cooldown, a próxima mensagem vai para o 2º colocado, não para o Ollama. |
| RF-09 | **Privacidade por tarefa** (`PRIVACY_LEVEL`): `publico` (pode usar gratuitos que treinam com dados), `pessoal` (só fontes sem treino declarado, ou o Ollama) e `local` (só o Ollama). Padrão: `resumo_memoria`, anexos e voz clonada = `pessoal`; conversa genérica e pesquisa = `publico`. | Must | O resumo de memória nunca vai para um modelo `-free` que usa dados para treino. |
| RF-10 | **Feedback do usuário:** reações 👍/👎 na resposta (Telegram) ou `/bom` e `/ruim` (terminal) ajustam a nota do modelo naquela tarefa. | Should | Três 👎 seguidos rebaixam o modelo no ranking da tarefa. |
| RF-11 | **Transparência:** cada resposta registra no `metadata` o modelo, a tarefa e o motivo da escolha; `/modelo` mostra qual respondeu a última mensagem e por quê. | Must | O usuário sabe quem respondeu, sem precisar olhar o log. |
| RF-12 | **Compatibilidade:** sem `LLM_ORCHESTRATOR=on`, vale a cadeia atual do `.env` (v1). Os providers do RF-01 reutilizam o `OpenAICompatibleProvider` (todos falam o formato OpenAI). | Must | Desligar o orquestrador restaura exatamente o comportamento de hoje. |

### 6.2 Fluxo Principal (Happy Path)

1. Mensagem: "Qual time da Série A tem menos títulos?" (texto, sem anexos).
2. Passo zero: skill = `pesquisador-web`, tarefa = `pesquisa`, privacidade = `publico`.
3. Filtro: gratuitos com `tool_call` e contexto suficiente → 60+ candidatos.
4. Ranking de `pesquisa`: 1º `opencode/kimi-k2.5-free` (nota 0,92), 2º `gemini-3.8-flash` (0,90, em cooldown até 00:00), 3º `openrouter/...:free`...
5. Trava de custo confirma o 1º como gratuito → AgentLoop roda com ele.
6. Resposta entregue; `metadata` registra o modelo, a tarefa e a latência; a estatística do modelo é atualizada.

### 6.3 Fluxos Alternativos

- **Todos os gratuitos em cooldown:** cai para o Ollama local (sempre disponível) e avisa no log; se a tarefa exigir visão e não houver modelo de visão local, avisa o usuário.
- **Catálogo indisponível e sem cache:** usa a cadeia v1 do `.env` (RF-12).

---

## 7. Requisitos Não-Funcionais

| ID | Requisito | Valor alvo | Observação |
|----|-----------|-----------|------------|
| RNF-01 | Custo adicional da classificação | 0 chamadas extras | A tarefa sai na mesma chamada do SkillRouter. |
| RNF-02 | Latência da escolha | < 5 ms | Ranking e cooldowns em memória (SQLite como persistência). |
| RNF-03 | Gasto | R$ 0 | Trava RF-02 + chaves criadas **sem forma de pagamento cadastrada**. |

---

## 8. Design e Interface

```
mensagem ─► passo zero (SkillRouter + tarefa + privacidade)
              │
              ▼
        ModelOrchestrator
          ├── FreeCatalog (models.dev + FREE_SOURCES)   → candidatos gratuitos
          ├── RequirementsFilter (tools, visão, contexto, privacidade)
          ├── RankingStore (notas por tarefa, sucesso, latência, feedback)
          ├── QuotaManager (cooldowns por provedor/modelo)
          └── CostGuard (free-only: bloqueia antes da chamada)
              │
              ▼
        OpenAICompatibleProvider (base URL + modelo escolhidos) ─► AgentLoop
```

Comandos novos: `/modelos [tarefa]`, `/modelo`, `/bom`, `/ruim`.

---

## 9. Modelo de Dados

```sql
model_catalog   { source, model_id, name, tool_call, vision, context, released, free_rule, synced_at }
model_scores    { task, source, model_id, quality, success_rate, latency_p50_ms, samples, updated_at }
model_cooldowns { source, model_id, until, reason }
```

---

## 10. Integrações e Dependências

| Fonte gratuita | Como acessar | Limites e cuidados |
|----------------|--------------|--------------------|
| OpenCode Zen (`-free`) | Chave de API do Zen; OpenAI-compatível | Os dados do período gratuito **podem ser usados para melhorar os modelos** → só `publico`. Confirmar no cadastro se a conta gratuita exige cartão. |
| OpenRouter (`:free`) | Chave do OpenRouter | Cota diária baixa sem créditos comprados; varia por modelo. |
| NVIDIA (build.nvidia.com) | Chave gratuita | Limite de requisições por minuto; disponibilidade para uso contínuo a confirmar. |
| Gemini (plano gratuito) | Chave atual (`GEMINI_API_KEY`) | Cota esgota (429 observado). No plano gratuito, os dados podem ser usados pelo Google → `publico`. |
| Groq (plano gratuito) | `GROQ_API_KEY` (já suportado) | Limites por minuto e por dia. |
| Ollama (local) | Já integrado | Ilimitado e privado; qualidade menor; único destino de `local`. |
| models.dev | `https://models.dev/api.json` (público) | Sem ele, usa o cache ou a cadeia v1. |

**Novas variáveis de ambiente:**

```env
LLM_ORCHESTRATOR=on
LLM_COST_POLICY=free-only
FREE_SOURCES=opencode,openrouter,nvidia,gemini,groq,ollama
OPENCODE_API_KEY=
OPENROUTER_API_KEY=
NVIDIA_API_KEY=
MODELS_CATALOG_URL=https://models.dev/api.json
MODELS_CATALOG_REFRESH_HOURS=24
```

---

## 11. Edge Cases e Tratamento de Erros

| Cenário | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: Modelo deixa de ser gratuito | O Zen remove o `-free` ou o catálogo passa a ter preço | No próximo sync, sai do ranking; a trava RF-02 bloqueia mesmo antes do sync, se o catálogo em cache já indicar custo. |
| EC-02: Modelo gratuito descontinuado | HTTP 404 / "model not found" | Remove do ranking até o próximo sync e segue para o próximo. |
| EC-03: Conta com faturamento ativo por engano | Usuário ativa o billing no Gemini | A trava não detecta billing de conta: o README orienta a criar as chaves **sem cartão**; o orquestrador só usa os modelos e fontes da lista. |
| EC-04: Modelo gratuito com qualidade ruim | Respostas erradas ou fora do formato | O feedback (RF-10) e as falhas de formato (tool calls inválidas) rebaixam a nota automaticamente. |
| EC-05: Todas as cotas esgotadas ao mesmo tempo | Uso intenso no mesmo dia | Ollama local; `/modelos` mostra quando cada cooldown termina. |
| EC-06: Catálogo com dados errados | Metadado diz `tool_call` mas o modelo falha com ferramentas | Três falhas de ferramenta marcam o modelo como "sem tools" localmente. |

---

## 12. Segurança e Privacidade

- **Custo:** trava `free-only` + chaves sem forma de pagamento. Nenhuma credencial de assinatura é usada (NG-02).
- **Dados:** RF-09 impede que memória, anexos e voz cheguem a modelos gratuitos que treinam com dados; `PRIVACY_LEVEL=local` força tudo para o Ollama.
- **Chaves:** ficam no `.env` (fora do Git) e nunca aparecem em logs ou respostas.

---

## 13. Plano de Rollout

1. `FreeCatalog` + `CostGuard` + providers Zen, OpenRouter e NVIDIA (sem ranking: ordem fixa por fonte). Já resolve o 429 do Gemini.
2. `QuotaManager` (cooldowns e revezamento, RF-08).
3. Classificação da tarefa + filtro por requisitos (RF-04, RF-05) + ranking inicial pelos metadados.
4. `npm run eval` com os conjuntos de referência (RF-07) e o feedback do usuário (RF-10).
5. Privacidade por tarefa (RF-09) — **obrigatória antes de ativar o Zen gratuito para resumo de memória e anexos**.

**Impacto em outras specs:** `PRD.md` (G-02: troca dinâmica passa a ser automática), `architecture.md` §2.6 (models.dev e orquestrador), `memory.md` v1.1 (o `MEMORY_SUMMARY_PROVIDER` passa a ser escolhido pelo orquestrador, com privacidade `pessoal`).

---

## 14. Open Questions

- OQ-01: Para conversa genérica (`publico`), aceita que as mensagens passem por modelos gratuitos que **usam os dados para treino** (Zen `-free`, Gemini gratuito)? Se não, sobram principalmente o Groq, a NVIDIA e o Ollama.
- OQ-02: Quais tarefas devem ter conjunto de avaliação primeiro? Proposta: `pesquisa` (factual) e `conversa`.
- OQ-03: Mostrar o nome do modelo no fim de cada resposta (ex.: "— kimi-k2.5-free"), ou só no `/modelo`?
