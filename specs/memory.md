# Spec: Memory Module (SQLite Persistence)

**Versão:** 1.1
**Status:** v1.0 Aprovada · v1.1 (memória resumida) Em Revisão
**Autor:** AgroMinds Agent
**Data:** 2026-03-06 (v1.0) · 2026-10-19 (v1.1)

---

## Changelog

| Versão | Data | Mudança |
|--------|------|---------|
| 1.0 | 2026-03-06 | Persistência em SQLite, WAL e janela fixa de `MEMORY_WINDOW_SIZE` mensagens. |
| 1.1 | 2026-10-19 | **Memória em camadas:** resumo incremental da conversa, janela recente menor, compactação de respostas longas no contexto, eliminação de pedidos repetidos e fatos duradouros do usuário (G-04 a G-07, RF-04 a RF-12). |

---

## 1. Resumo

O módulo de persistência de estado do AgroMinds gerencia tanto as conversas de longo prazo em banco de dados SQLite (`better-sqlite3`) quanto atua como manager da janela de contexto para impedir que o limite maximo do envelope de tokens da IA (Context Window) estoure.

**v1.1:** o contexto enviado ao LLM deixa de ser "as últimas N mensagens completas" e passa a ser montado em camadas: **resumo estruturado da conversa** + **mensagens recentes** (com respostas longas compactadas) + **fatos duradouros do usuário**. O histórico completo continua intacto no banco.

---

## 2. Contexto e Motivação

**Problema:**
LLMs são stateless - eles esquecem tudo que foi dito na interação anterior de uma API REST call.
Sem armazenamento persistente, o robô perde a utilidade primária de um "Agente Pessoal".

**Problema adicional (v1.1):** a janela fixa de 20 mensagens completas causa dois efeitos opostos:
- **Desperdício de tokens:** respostas longas (documentos, ideias refinadas) e pedidos repetidos ou confusos são reenviados integralmente a cada nova mensagem, até saírem da janela.
- **Esquecimento abrupto:** tudo que fica além da 20ª mensagem some do contexto, inclusive decisões importantes tomadas no início da conversa.

**Evidências:**
Tentativas de armazenar arrays in-memory no Node.js funcionam apenas até o app ser encerrado/reiniciado (hot-reload da infra ou npm dev reload). O histórico vaporizava.
- (v1.1) Em 2026-10-17, uma resposta da skill `idealizador-analisador` com 6.931 caracteres passou a ser reenviada em todas as 20 mensagens seguintes da conversa.
- (v1.1) O usuário relatou que costuma pedir coisas de forma confusa ou repetida, inflando o histórico sem acrescentar informação.

**Por que agora:**
A adoção do SQLite é veloz, serverless (um arquivo físico único), suporta chamadas síncronas rápidas (bloqueios impercetiveis para volumes unicos de acesso Telegram) e não consome infra adicional.
(v1.1) Com o fallback para modelos locais (Ollama, contexto de 4k–8k tokens), um contexto enxuto deixou de ser economia e virou requisito de funcionamento.

---

## 3. Goals (Objetivos)

- [ ] G-01: Prover Storage fixo e rápido de mensagens do Telegram para recriar as conversas ativas.
- [ ] G-02: Possuir um `MemoryManager` central (Facade) que decide automaticamente quando as mensagens velhas deverão ser ignoradas (Truncamento nativo) sem apagar sua versão persistente histórica.
- [ ] G-03: Ranquear requisições de SQLite usando Repository Pattern, desacoplando SQL views puro do Agent Loop principal.
- [ ] G-04 (v1.1): Manter um **resumo incremental e estruturado** de cada conversa, que represente o mesmo conteúdo com muito menos tokens.
- [ ] G-05 (v1.1): **Compactar no contexto** respostas e documentos longos, sem alterar o original no banco.
- [ ] G-06 (v1.1): **Unificar pedidos repetidos ou confusos** numa única intenção clara no resumo.
- [ ] G-07 (v1.1): Guardar **fatos duradouros** do usuário (preferências, dados de projetos) válidos entre conversas.

**Métricas de sucesso:**
| Métrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Tempo de Write Sync | N/A | < 10ms | Constante |
| Limite de Arquivo DB | 0.0 MB | Manter sob 500 MB (Vacuum ocasional) | 1 Ano |
| (v1.1) Tokens de contexto por mensagem numa conversa de 50 trocas | Últimas 20 mensagens completas | ≤ 1/3 do baseline | v1.1 |
| (v1.1) Acerto em perguntas sobre algo dito há mais de 20 mensagens | ~0% (fora da janela) | ≥ 90% | v1.1 |
| (v1.1) Latência adicional na resposta ao usuário | — | 0 ms (resumo roda depois da resposta) | v1.1 |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: Não criará banco distribuído de Grafos ou Chroma Vector Database. A intenção é ter memória conversacional direta, sem Sematic Search Complexo inicialmente.
- NG-02: ORMs como Prisma, TypeORM etc. Usaremos SQL nativo `better-sqlite3` por leveza e clareza.
- NG-03 (v1.1): Busca semântica (embeddings) no histórico. O resumo e os fatos cobrem o caso de uso sem banco vetorial.
- NG-04 (v1.1): Apagar ou reescrever mensagens originais. Resumo e compactação são apenas **representações** para o contexto.

---

## 5. Usuários e Personas

**Módulos primários:**
- `TelegramInputHandler` e `TerminalChat` (gravam a entrada via `AgentController`).
- `AgentController` → `MemoryManager` (lê o contexto e grava as respostas).
- (v1.1) `ConversationSummarizer`: lê o histórico e grava o resumo, em segundo plano.
- (v1.1) O usuário, que consulta e corrige a memória pelos comandos `/memoria` e `/esquecer`.

---

## 6. Requisitos Funcionais

### 6.1 Requisitos Principais

| ID | Requisito | Prioridade | Critério de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | O Singleton de DB deve criar a tabela de histórico (`conversations` e `messages`) sozinho no startup se não existirem. | Must | Excluir db antigo; reiniciar app; arquivo data/ db.sqlite reaparece limpo. |
| RF-02 | O Storage deve usar WAL (Write-Ahead Logging) ativo pra manter leitura sem block | Must | Múltiplas msgs via Telegram não congelam o bot por locks do sqlite3 nativo. |
| RF-03 | ~~A classe abstrata repassará ao Agent Loop somente o número `MEMORY_WINDOW_SIZE` de mensagens recentes.~~ **(substituído na v1.1 por RF-05)** | Must | Uma chamada REST pro Gemini não falhará por estouro de token via histórico inchado (1M text words). |
| RF-04 | **Resumo incremental:** quando houver `MEMORY_SUMMARY_TRIGGER` (padrão 10) mensagens fora da janela recente e ainda não resumidas, o `ConversationSummarizer` gera um novo resumo a partir do **resumo anterior + essas mensagens** e registra até qual mensagem o resumo cobre. | Must | Após 30 trocas, existe um resumo cobrindo as mensagens anteriores à janela recente; nenhuma mensagem fica sem cobertura (nem no resumo nem na janela). |
| RF-05 | **Montagem do contexto:** System Prompt + bloco `# Memória da conversa` (resumo) + bloco `# Fatos sobre o usuário` + as últimas `MEMORY_RECENT_MESSAGES` (padrão 8) mensagens, respeitando `MEMORY_TOKEN_BUDGET` (padrão 6.000 tokens estimados). | Must | Conversa de 50 trocas gera contexto ≤ 1/3 dos tokens da janela de 20 mensagens completas. |
| RF-06 | **Formato estruturado do resumo** (máximo de `MEMORY_SUMMARY_MAX_CHARS`, padrão 2.000): `Assunto`, `Pedidos do usuário` (intenções deduplicadas), `Decisões e fatos`, `Entregas` (documentos, arquivos e áudios gerados), `Pendências`, `Anexos citados`. | Must | O resumo é legível por humanos e cada seção vazia é omitida. |
| RF-07 | **Deduplicação de intenções:** pedidos repetidos, reformulados ou corrigidos viram uma única linha com a versão final ("quer PRD de app de finanças, com foco em controle de gastos"), e correções do usuário substituem a versão anterior. | Must | Três pedidos parecidos geram 1 item em `Pedidos do usuário`. |
| RF-08 | **Compactação na janela recente:** mensagens `assistant` acima de `MEMORY_COMPACT_THRESHOLD` (padrão 2.000 caracteres) entram no contexto como início do texto (~400 caracteres) + marcador `[resposta longa compactada: N caracteres, mensagem #id]`; conteúdo de `<arquivo nome="x">` vira `[documento gerado: x]`. O original permanece no banco. | Must | A resposta de 6.931 caracteres ocupa < 600 caracteres no contexto. |
| RF-09 | **Assíncrono e tolerante a falha:** o resumo é gerado **depois** que a resposta foi entregue, com o provider de `MEMORY_SUMMARY_PROVIDER` (padrão: o do router, ou seja, o mais barato). Se falhar, o contexto usa o último resumo válido mais a janela recente; se não houver resumo, usa a janela da v1.0. | Must | Com o LLM de resumo fora do ar, o bot continua respondendo normalmente. |
| RF-10 | **Fatos duradouros:** o resumidor também extrai fatos estáveis ditos pelo usuário ("prefiro respostas curtas", "meu projeto X usa Postgres") para a tabela `user_facts`, válidos em todas as conversas do usuário. Fato novo que contradiz um antigo o substitui. | Should | Após "prefiro respostas curtas", uma conversa nova (`/nova`) já respeita a preferência. |
| RF-11 | **Transparência e controle:** `/memoria` mostra o resumo atual e os fatos numerados; `/esquecer <n>` remove um fato; `/esquecer tudo` limpa fatos e resumo da conversa ativa. | Must | O usuário vê e corrige o que o bot "lembra". |
| RF-12 | `/nova` arquiva a conversa com o resumo dela; a nova conversa começa sem resumo, mas mantém os fatos duradouros. | Must | Fatos sobrevivem a `/nova`; o resumo antigo não vaza para a conversa nova. |

### 6.2 Fluxo Principal (Happy Path)

1. Usuário envia "Oi agente".
2. `ConversationRepository` localiza UUID conversacional ativo do User_ID.
3. `MessageRepository` persiste a nova mensagem `role="user"` com texto associado ao ID.
4. (v1.1) `MemoryManager.buildContext()` monta: resumo da conversa + fatos do usuário + últimas `MEMORY_RECENT_MESSAGES` mensagens (com compactação RF-08), dentro do orçamento de tokens.
5. Devolve o contexto montado para o AgentLoop atuar.
6. A resposta do bot com `role="assistant"` ou `role="tool"` é persistida analogamente pelas mesmas classes.
7. (v1.1) Depois da entrega, se o gatilho RF-04 for atingido, o `ConversationSummarizer` atualiza o resumo e os fatos em segundo plano.

### 6.3 Fluxos Alternativos

Falhas de Banco - Vide [11. Edge Cases e Tratamento de Erros](#11-edge-cases-e-tratamento-de-erros)

**(v1.1) A. Usuário pergunta sobre algo antigo** ("qual nome tínhamos decidido pro app?"): a resposta sai do resumo (`Decisões e fatos`), mesmo que a mensagem original esteja a 40 mensagens de distância.

**(v1.1) B. Usuário corrige a memória** ("não, o projeto usa MySQL"): o fato é atualizado no próximo ciclo do resumidor, ou na hora, com `/esquecer <n>` seguido da nova informação.

---

## 7. Requisitos Não-Funcionais

| ID | Requisito | Valor alvo | Observação |
|----|-----------|-----------|------------|
| RNF-01 | Transações Seguras | Auto-commit nativo | WAL ativo resolve concorrencia Single thread node. |
| RNF-02 (v1.1) | Custo do resumo | ≤ 1 chamada de LLM a cada `MEMORY_SUMMARY_TRIGGER` mensagens | Provider barato (router) por padrão. |
| RNF-03 (v1.1) | Estimativa de tokens | `caracteres / 4` | Suficiente para orçamento; não exige tokenizer por modelo. |
| RNF-04 (v1.1) | Concorrência | Um resumo por conversa por vez | Novo gatilho durante um resumo em andamento é ignorado (o próximo ciclo cobre). |

---

## 8. Design e Interface

Pura estrutura sem interface visual (ver `sqlite-viewer` VSCode extensão para debbug interno).

**(v1.1) Contexto enviado ao LLM:**

```
[system]  System Prompt (identidade, ferramentas, skills, skill ativa)
          # Memória da conversa      ← resumo estruturado (RF-06), cobre msgs #1..#k
          # Fatos sobre o usuário    ← user_facts (RF-10)
[user/assistant]  últimas MEMORY_RECENT_MESSAGES mensagens (#k+1..#n), longas compactadas (RF-08)
```

**Novos componentes:** `ConversationSummarizer` (gera resumo e fatos com um prompt fixo de saída estruturada), `ContextBuilder` (monta as camadas e aplica o orçamento), `SummaryRepository` e `UserFactRepository`.

---

## 9. Modelo de Dados

`conversations`
`messages`

Sem foreign keys restritas ativadas com pragma foreign_keys=ON pra priorizar inserts mais leves sem checks, apenas referências programáticas via Node.

**(v1.1) Novas tabelas** (criadas no startup, sem alterar as existentes):

```sql
conversation_summaries {
  id: integer             -- autoincremento
  conversation_id: string
  summary: text           -- formato estruturado (RF-06)
  covers_until_message_id: integer  -- última mensagem incluída no resumo
  created_at: datetime
}
-- A versão vigente é a de maior id por conversa; versões anteriores ficam como histórico.

user_facts {
  id: integer
  user_id: string
  fact: text
  source_message_id: integer   -- de onde o fato foi extraído
  created_at, updated_at: datetime
}
```

---

## 10. Integrações e Dependências

| Dependência | Tipo | Impacto se indisponível |
|-------------|------|------------------------|
| `better-sqlite3` | Obrigatória | O agente vai quebrar a Main.ts na instancialização. |
| Filesystem (`fs`) | Obrigatório | DB path tem que ser gerido e gravado via Node FS Perms. |
| (v1.1) Provider de LLM para resumo | Secundária | Sem resumo novo; usa o último válido + janela recente (RF-09). |

**(v1.1) Novas variáveis de ambiente:**

```env
MEMORY_RECENT_MESSAGES=8
MEMORY_SUMMARY_TRIGGER=10
MEMORY_SUMMARY_MAX_CHARS=2000
MEMORY_COMPACT_THRESHOLD=2000
MEMORY_TOKEN_BUDGET=6000
MEMORY_SUMMARY_PROVIDER=        # vazio = mesmo do SKILL_ROUTER_PROVIDER / principal
USER_FACTS_ENABLED=true
```

`MEMORY_WINDOW_SIZE` continua valendo como fallback quando não existe resumo.

---

## 11. Edge Cases e Tratamento de Erros

| Cenário | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: Arquivo Lock file corrupto | Desligamento forçado de energia no Write SQLite local. | SQLite reabre do journaling automático e read de forma íntegra sem interrupções maiores. |
| EC-02: Null Bytes na Mensagem do Usuário | Receber bytes invisíveis no TG causando Erro de syntax DB. | Stripping na entrada `content.replace(/\u0000/g, '')`. O DB não engole a query suja. |
| EC-03: Memória Enorme de Resposta de LLM | O modelo decide cuspir 16k tokens em Output. | Limite o SQLite max text de String e truncate se estourar Max Byte (fallback). |
| EC-04 (v1.1): Resumo inventando fatos | O LLM de resumo alucina uma decisão | O prompt exige apenas fatos presentes nas mensagens; cada decisão cita o nº da mensagem de origem (`#id`). O usuário corrige com `/memoria` e `/esquecer`. |
| EC-05 (v1.1): Resumo crescendo sem limite | Conversa muito longa | Acima de `MEMORY_SUMMARY_MAX_CHARS`, o resumidor recondensa priorizando decisões e pendências; pedidos já entregues viram uma linha em `Entregas`. |
| EC-06 (v1.1): Dados sensíveis | Usuário envia senha, token ou documento pessoal | O resumidor nunca copia segredos para o resumo ou para `user_facts` (instrução do prompt + filtro regex para padrões de chaves, tokens e senhas). |
| EC-07 (v1.1): Resumo em idioma ou formato errado | Modelo local pequeno responde fora do formato | A validação exige as seções do RF-06; se inválido, descarta e mantém o resumo anterior. |
| EC-08 (v1.1): Orçamento estourado mesmo com resumo | Janela recente com várias mensagens grandes | Reduz a janela recente até caber, sempre mantendo a última mensagem do usuário inteira. |

---

## 12. Segurança e Privacidade

- **Arquivos DB Sensíveis:** O `Agrominds.db` jamais pode ir pro Git (Adicionar no `.gitignore` /data).
- **Sem senhas cruas no prompt:** O DB grava as msgs do usuário. Não logaremos APIs ali como System Prompts secretos pra evitar persistencia indevida.
- **(v1.1) Resumo e fatos são dados pessoais:** ficam apenas no SQLite local e o usuário pode consultá-los e apagá-los a qualquer momento (`/memoria`, `/esquecer`).
- **(v1.1) Provider de resumo na nuvem:** quando o resumo usar um provider remoto (ex.: Gemini), o trecho resumido é enviado a ele, o mesmo nível de exposição das próprias mensagens. Para privacidade máxima: `MEMORY_SUMMARY_PROVIDER=ollama`.

---

## 13. Plano de Rollout

Rollout instantâneo para DB Version 1. Scripts de Migration explícitos não são escopo inicial, pra reset bastando apagar e reinjetar no DB_PATH local de DEV.

**(v1.1):**
1. Criar as tabelas novas com `CREATE TABLE IF NOT EXISTS` (as conversas existentes continuam funcionando; o primeiro resumo é gerado no próximo gatilho).
2. Implementar a compactação RF-08 primeiro: ganho imediato, sem LLM.
3. Implementar o resumidor (RF-04, RF-06, RF-07 e RF-09) e os comandos (RF-11 e RF-12).
4. Fatos duradouros (RF-10) por último, atrás de `USER_FACTS_ENABLED`.
5. Validar as métricas da seção 3 numa conversa real longa.

---

## 14. Open Questions

- OQ-01 (v1.1): Gerar o resumo também ao encerrar o dia ou ao ficar X horas sem mensagens, além do gatilho por quantidade?
- OQ-02 (v1.1): Os fatos duradouros devem ser compartilhados entre canais (Telegram e terminal) do mesmo usuário? A proposta é sim, quando o terminal usar `--usuario <id>`.
