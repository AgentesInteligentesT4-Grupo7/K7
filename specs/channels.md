# Spec: Canais de Conversa (Telegram, Terminal e WhatsApp)

**Versão:** 1.0
**Status:** Em Revisão
**Autor:** AgroMinds Agent
**Data:** 2026-10-18
**Reviewers:** Agro

---

## 1. Resumo

Separa o núcleo do AgroMinds (AgentController, memória, skills, ferramentas e vozes) dos **canais** por onde as mensagens chegam e saem. O Telegram passa a ser um canal entre outros. Esta versão entrega um **chat no terminal** para uso e teste local e define o ponto de integração para um canal **WhatsApp via n8n** numa próxima etapa.

---

## 2. Contexto e Motivação

**Problema:**
Toda interação depende do Telegram. Para testar uma skill, uma voz ou um provider de LLM é preciso abrir o celular e o bot precisa estar online. Não há como conversar com o agente direto no PC, nem por outros mensageiros.

**Evidências:**
- O usuário pediu para conversar "não só pelo Telegram" e citou um chat local e o WhatsApp.
- Os testes de ponta a ponta desta fase (Gemini, Ollama, voz clonada) foram feitos com scripts avulsos, porque não havia um chat local.

**Por que agora:**
O núcleo já é independente de transporte (AgentController recebe um `AgentInput` normalizado e responde via `IOutputHandler`). Falta só a montagem desse núcleo fora do `main.ts` do Telegram.

---

## 3. Goals (Objetivos)

- [ ] G-01: Composição do núcleo reutilizável por qualquer canal (`createCore`), sem código de Telegram.
- [ ] G-02: Canal **terminal**: `npm run chat` abre uma conversa no console com o mesmo agente, memória, skills, ferramentas e vozes.
- [ ] G-03: O chat no terminal roda **ao mesmo tempo** que o bot do Telegram, sem conflito.
- [ ] G-04: Definir o contrato do futuro canal HTTP para o n8n (WhatsApp), sem implementá-lo nesta versão.

**Métricas de sucesso:**
| Métrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Tempo para testar uma mensagem localmente | Abrir Telegram no celular | `npm run chat` + digitar | MVP |
| Funcionalidades do Telegram disponíveis no terminal | 0% | Texto, documentos, áudio (arquivo), voz clonada, skills, comandos | MVP |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: Interface web (continua fora de escopo, conforme o PRD NG-01).
- NG-02: Gravar áudio pelo microfone no terminal. Áudio entra como arquivo (`/audio caminho`).
- NG-03: Implementar o canal WhatsApp nesta versão (depende do n8n e de uma conexão com o WhatsApp, ver §10).

---

## 5. Usuários e Personas

**Usuário primário:** Agro, no próprio PC, testando skills, providers e vozes ou conversando sem o celular.

---

## 6. Requisitos Funcionais

### 6.1 Requisitos Principais

| ID | Requisito | Prioridade | Critério de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | `createCore(config)` monta LLMs, memória, ferramentas, skills, TTS, STT e clonagem de voz e devolve uma fábrica de `AgentController` que recebe o `IOutputHandler` do canal. | Must | `main.ts` (Telegram) e `chat.ts` (terminal) usam o mesmo `createCore`. |
| RF-02 | `npm run chat` abre um REPL: cada linha digitada vira um `AgentInput` (`source: text`) e a resposta é impressa no console. | Must | "Olá" recebe resposta do provider configurado, com o mesmo system prompt e skills do Telegram. |
| RF-03 | Comandos do terminal: `/sair`, `/nova`, `/skills`, `/vozes`, `/falar [@voz] texto`, `/arquivo caminho` (PDF/MD), `/audio caminho` (transcreve e envia como voz), `/verbose` (liga e desliga os logs do ReAct). | Must | Cada comando funciona sem o Telegram. |
| RF-04 | Saídas não textuais viram arquivos locais: documentos `<arquivo>` são salvos em `./data/terminal/` e respostas em áudio (TTS ou voz clonada) são salvas como `.ogg`. O caminho é impresso e, com `--play`, o arquivo abre no player padrão do Windows. | Must | Pedir "responda em áudio" gera um `.ogg` reproduzível. |
| RF-05 | O terminal usa uma conversa própria (`user_id = "terminal"`) por padrão. Com `--usuario <id>`, continua a conversa de um usuário do Telegram. | Should | O histórico do terminal não se mistura com o do Telegram sem pedido explícito. |
| RF-06 | Rodar junto com o bot: o terminal não limpa a pasta temporária do bot, não faz backup do banco e não faz polling do Telegram. | Must | Com o bot e o terminal abertos ao mesmo tempo, os dois respondem normalmente. |
| RF-07 | Por padrão, os logs ficam no nível `warn` no terminal, para não poluir a conversa. `--verbose` mostra Thought/Action/Observation. | Must | Conversa limpa por padrão; os passos do agente ficam visíveis quando pedidos. |

### 6.2 Fluxo Principal (Happy Path)

1. O usuário roda `npm run chat`.
2. O console mostra o provider, as skills e os comandos disponíveis.
3. O usuário digita "resuma este pdf" e depois `/arquivo C:\docs\relatorio.pdf`.
4. O núcleo processa como no Telegram (extração → router → ReAct → memória).
5. A resposta aparece no console. Se houver documento ou áudio, o caminho do arquivo é impresso.

### 6.3 Fluxos Alternativos

**A. Provider fora do ar:** igual ao Telegram (novas tentativas → fallback → aviso `⚠️`).
**B. Arquivo inexistente em `/arquivo` ou `/audio`:** mensagem de erro e o REPL continua.

---

## 7. Requisitos Não-Funcionais

| ID | Requisito | Valor alvo | Observação |
|----|-----------|-----------|------------|
| RNF-01 | Inicialização do terminal | < 2 s até o prompt | Sem esperar os health checks. |
| RNF-02 | Concorrência com o bot | Sem locks perceptíveis | SQLite em WAL já suporta leitores e escritores concorrentes. |

---

## 8. Design e Interface

```
                 ┌────────────── createCore(config) ──────────────┐
 Telegram ──►  TelegramInputHandler ─┐                           │
 Terminal ──►  TerminalChat ─────────┼─► AgentController ─► IOutputHandler do canal
 (n8n/WhatsApp ► HttpChannel, futuro)┘   (memória, skills, ReAct, vozes)
```

- `src/app/createCore.ts`: composição compartilhada.
- `src/cli/chat.ts` + `src/cli/TerminalOutputHandler.ts`: canal terminal.

---

## 9. Modelo de Dados

Sem mudanças. O canal terminal grava em `conversations.user_id = "terminal"`. O `metadata.source` das mensagens passa a registrar o canal (`channel: "telegram" | "terminal"`).

---

## 10. Integrações e Dependências

| Dependência | Tipo | Impacto se indisponível |
|-------------|------|------------------------|
| Node `readline` | Obrigatória (terminal) | — (nativo) |
| n8n (futuro) | Opcional | Sem canal WhatsApp. |

**Contrato planejado do canal HTTP (WhatsApp via n8n), para uma versão futura:**
`POST http://localhost:<porta>/api/v1/messages` com `{ "channel": "whatsapp", "userId": "...", "text": "...", "audioBase64"?: "..." }` e cabeçalho `Authorization: Bearer <token local>`. A resposta é `{ "text": "...", "audioBase64"?: "...", "files"?: [...] }`. O n8n recebe a mensagem do WhatsApp (nó oficial da WhatsApp Cloud API ou um gateway), chama esse endpoint e devolve a resposta ao WhatsApp. **Risco:** gateways não oficiais (QR code no número pessoal) violam os termos do WhatsApp e podem levar ao banimento do número.

---

## 11. Edge Cases e Tratamento de Erros

| Cenário | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: Bot e terminal ao mesmo tempo | Os dois processos abertos | Pastas temporárias separadas (`tmp/cli`) e sem manutenção do banco no terminal. |
| EC-02: Ctrl+C no meio de uma resposta | Usuário interrompe | Encerra limpo, fechando o banco. |
| EC-03: Linha vazia | Enter sem texto | Ignorada. |
| EC-04: Saída com caracteres especiais | Emojis e acentos no console do Windows | Console em UTF-8; o texto é impresso sem quebrar. |

---

## 12. Segurança e Privacidade

- O terminal roda com as permissões do usuário local e não exige whitelist: quem tem acesso ao console já tem acesso aos arquivos do bot.
- O futuro canal HTTP só escutará em `127.0.0.1` e exigirá token. O n8n deve rodar na mesma máquina ou em rede confiável.

---

## 13. Plano de Rollout

1. Extrair `createCore` do `main.ts`, sem mudar o comportamento do Telegram (testes existentes continuam passando).
2. Implementar o canal terminal e o script `npm run chat`.
3. **Atualizar o PRD:** G-01 e NG-01 passam a citar "Telegram como canal principal; terminal para uso local; WhatsApp planejado".
4. WhatsApp: em outra versão, após instalar o n8n e escolher a forma de conexão.

---

## 14. Open Questions

- OQ-01: Para o WhatsApp, usar o nó oficial da WhatsApp Cloud API no n8n (Meta Business, sem risco) ou um gateway não oficial (Evolution API/WAHA, risco de banimento)?
