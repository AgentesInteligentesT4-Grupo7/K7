# Spec: Gerente de fitas pelo Telegram

**Versão:** 0.1 (plano de implementação, para o grupo revisar)
**Status:** Proposta. Nada implementado ainda; reaproveita o que já existe (bot gerente, página de administração,
instalador de fitas, criação de bot por fita, convites).
**Autor:** Grupo 7 (rascunho: K7 Agent)
**Data:** 2026-10-30
**Reviewers:** Parreira, Grupo 7

---

## 1. Resumo

Hoje o **bot gerente** do K7 só cria os bots das fitas, e quem comanda é a página de administração
(`npm run admin`) ou o terminal. A proposta é o gerente virar um **bot de conversa para os donos**: pelo Telegram,
eles listam, ligam e desligam fitas, criam fitas novas, pedem funcionalidades novas a uma fita, dão um bot próprio
a cada fita e recebem o link (e o QR) para usar e compartilhar com outras pessoas.

```
Dono no Telegram ──► @K7Gerente_bot ──► K7 Central (processo do `npm run admin`)
                                          ├─ fitas: criar, ligar, desligar, log (FitaRunner, ProfileTemplate)
                                          ├─ bots: criar pelo gerente, configurar, convite (FitaTelegram)
                                          └─ funcionalidades: agente que edita só a pasta da fita
                                                  (sem código: aplica; com código: branch + testes + aprovação)
Bot da fita (@agrominds_bot, @receitas_bot...) ◄── link/QR de convite ──► pessoas
```

**Fica no K7 (projeto principal), não numa fita:** o gerente cuida de todas as fitas, precisa funcionar com
nenhuma fita ligada e usa peças que já moram no tocador (token do gerente, FitaRunner, instalador, FitaTelegram).

## 2. Goals

- G-01: tudo o que a página de administração faz com fitas e bots, também pelo Telegram, de qualquer lugar.
- G-02: fita nova pronta para uso num só fluxo: entrevista curta → fita criada → bot próprio → ligada → link e QR.
- G-03: compartilhar com um toque: link de convite (entra direto), QR e o botão "Compartilhar" do Telegram.
- G-04: funcionalidade nova a pedido ("na fita receitas, crie uma skill de lista de compras"), com pré-visualização,
  testes e desfazer.
- G-05: foco restrito: assunto fora de fitas e bots recebe "sou o gerente do K7, cuido das fitas e dos bots".
- G-06: seguro por padrão: só donos; código novo só com aprovação explícita; nenhum token aparece no chat.

## 3. Non-Goals

- Gerente aberto ao público ou multiusuário com contas (fase futura: "operadores", §9).
- Hospedar fora do computador do K7 (continua precisando dele ligado).
- Editar o código do próprio K7 pelo gerente (só as fitas).
- Publicar fita em loja/registro (o instalador já instala de GitHub/npm; publicar é manual).

## 4. Onde roda: K7 Central

O gerente sobe **no mesmo processo da página de administração** (`npm run admin`, que passa a se chamar "K7
Central" na tela). Motivos:

- **Um só programa por token:** o Telegram entrega as atualizações de um bot a um processo só. O gerente faz
  long polling no `TELEGRAM_GERENTE_TOKEN` e recebe ali também os avisos `managed_bot` (bot criado). Hoje
  `npm run perfil -- bot <fita> --gerente` e a página fazem o próprio polling: com a Central ligada, eles passam a
  pedir à Central (rota local) em vez de disputar o token; sem a Central, continuam como hoje.
- **Reuso direto:** `FitaRunner` (liga/desliga e log), `createProfile` (fita nova), `ProfileInstaller`,
  `ManifestEditor` (canais, acesso), `FitaTelegram` (criar bot, configurar, convites, acessos).
- Comando novo opcional `npm run central` = `npm run admin` sem abrir o navegador (para deixar rodando).

## 5. Quem usa

- **Donos:** `TELEGRAM_ALLOWED_USER_IDS` do `.env` do K7. Só eles conversam com o gerente.
- Qualquer outra pessoa recebe uma resposta fixa ("Este é o gerente do K7, só os donos usam. Procure o bot da
  fita que te indicaram.") e nada é registrado além de uma linha no log.
- Toda ação que muda algo fica num **histórico** (quem, quando, o quê, resultado), visível na página da Central.

## 6. Conversa e comandos

| Comando | O que faz | Reaproveita |
| --- | --- | --- |
| `/fitas` | Lista as fitas: ligada ou não, bot (@), modo de acesso; botões Ligar, Desligar, Link | `listProfiles`, `FitaRunner.state` |
| `/ligar <fita>` · `/desligar <fita>` | Liga ou desliga (recusa ligar se o bot for de outra fita ligada) | `FitaRunner`, `checkOwnBot` |
| `/log <fita>` | Últimas linhas do log da fita | `FitaRunner.log` |
| `/nova <nome>` | Entrevista curta e cria a fita (sem código), já com bot e ligada | `createProfile`, skill `criador-de-fitas` |
| `/bot <fita>` | Cria o bot próprio da fita pelo gerente; devolve link, QR e Compartilhar | `FitaTelegram.managedLink/completeManaged` |
| `/convite <fita> [nome] [usos] [dias]` | Link de convite + QR + Compartilhar | `FitaTelegram.invite` |
| `/acesso <fita> lista\|convite\|aberto` | Muda quem pode usar e reinicia a fita | `ManifestEditor`, `FitaRunner` |
| `/pessoas <fita>` | Quem tem acesso, pedidos esperando; bloquear/liberar por botão | `FitaTelegram.overview/setStatus` |
| Texto livre | "na fita receitas, crie uma skill de lista de compras" → funcionalidade (§7) | agente da Central |

**Link para usar e compartilhar.** Depois de criar o bot ou um convite, o gerente responde com:

- o **link de convite** `https://t.me/<bot>?start=<código>` (entra direto; padrão 1 pessoa e 7 dias, ou o que o dono pedir);
- o **QR** do mesmo link (foto);
- o botão **Compartilhar**, que abre o seletor de conversas do Telegram
  (`https://t.me/share/url?url=<link>&text=<frase da fita>`);
- se a fita estiver em `aberto`, o link simples `https://t.me/<bot>` (qualquer pessoa entra).

**Foco restrito.** O gerente usa o mesmo mecanismo das fitas (`foco: restrito`): assunto fora de fitas, bots e
pessoas recebe "Sou o gerente do K7: cuido das fitas e dos bots. Para tempo e plantio, fale com o AgroMinds
(@…)." com o link do bot certo quando der para saber.

### Exemplo: fita nova do zero

1. Dono: `/nova receitas`
2. Gerente: 3 perguntas numa mensagem (para quê e para quem; o que precisa saber fazer; público: só convidados ou aberto).
3. Dono responde. Gerente monta a fita sem código (perfil, skills, `foco: restrito`, `telegram: { acesso: convite }`),
   valida com o instalador e mostra o resumo: "Fita receitas: 2 skills, canais Telegram e web. [Criar o bot] [Ajustar]".
4. Dono toca em **Criar o bot**: chega o link de criação do Telegram; ele confirma (um toque, exigência do Telegram).
5. A Central recebe o `managed_bot`, grava o token no `.env` da fita, configura nome, descrição, comandos e liga a fita.
6. Gerente: "✅ @receitas_k7_bot pronto e ligado." + link de convite + QR + **Compartilhar**.

## 7. Funcionalidades novas numa fita

Um **agente da Central** recebe o pedido em linguagem natural e trabalha **só dentro da pasta da fita**
(ferramentas de arquivo limitadas a `PERFIS_DIR/<fita>`; nada fora dela, nada de rede além da LLM).

| Tipo | Exemplos | Como é aplicado |
| --- | --- | --- |
| Sem código | skill nova, persona, estilo, ferramenta HTTP (YAML), documentos de conhecimento, instruções e módulos no `perfil.yaml` | Escreve, valida (`readManifest`, `inspectProfile`), mostra o resumo (arquivos e o que muda) e aplica com **[Aplicar]**; reinicia a fita |
| Com código | comando novo de Telegram, tarefa periódica, integração com API, mudança na extensão | Trabalha num **branch** do Git da fita, roda `tsc` e os testes da fita, mostra o resumo do diff e só liga com **[Aprovar e ligar]** de um dono |

- Cada mudança vira **um commit** na fita ("gerente: skill lista-de-compras, pedida por <dono>"); **[Desfazer]**
  faz `git revert` e reinicia.
- Código só com aprovação explícita, porque roda com o mesmo acesso do K7 (a mesma regra do instalador).
- A LLM de código é configurável (`GERENTE_MODELO`): os modelos gratuitos do K7 servem para texto; para código, o
  recomendado é um modelo forte. Sem ele, o gerente só oferece funcionalidades sem código.

## 8. Implementação (arquivos)

| Arquivo | O que é |
| --- | --- |
| `src/canais/gerente/GerenteBot.ts` | grammy no token do gerente: só donos, comandos da §6, botões, `managed_bot` |
| `src/canais/gerente/GerenteAcoes.ts` | Ações sobre fitas e bots, chamadas pelo bot e pela página (uma só implementação) |
| `src/canais/gerente/GerenteAgente.ts` | Agente das funcionalidades: ferramentas de arquivo presas à pasta da fita, branch, testes, resumo |
| `src/canais/gerente/Historico.ts` | Histórico de ações (SQLite em `dados/k7/gerente.db`) |
| `src/canais/admin/admin.ts` | Sobe o gerente junto da página quando há `TELEGRAM_GERENTE_TOKEN` |
| `src/canais/admin/AdminServer.ts` | Criação de bot pela Central (sem segundo polling); aba "Histórico" |
| `src/cli/telegramFita.ts` | `bot --gerente` pede à Central se ela estiver ligada |
| `tests/Gerente.test.ts` | Telegram de mentira: só donos, `/fitas`, `/ligar`, `/bot` com `managed_bot`, convite com link e QR, foco restrito |

## 9. Fases

| Fase | Entrega | Pronta quando |
| --- | --- | --- |
| 1 — Central | Gerente no processo da página; só donos; `/fitas`, `/ligar`, `/desligar`, `/log`; foco restrito | Ligar a AgroMinds pelo celular |
| 2 — Bots e convites | `/bot`, `/convite`, `/acesso`, `/pessoas`; link, QR e Compartilhar; CLI sem disputar o token | Criar o bot da Rebobina pelo celular e mandar o convite |
| 3 — Fita nova | `/nova` com entrevista, fita sem código, bot e ligada num fluxo | "receitas" criada do zero em menos de 5 min |
| 4 — Sem código | Funcionalidades sem código com resumo, Aplicar e Desfazer (commit por mudança) | Skill nova numa fita pelo chat, com desfazer |
| 5 — Com código | Branch, testes, resumo do diff, Aprovar e ligar | Comando novo numa extensão aprovado pelo chat |
| 6 — Operadores (opcional) | Pessoas que gerenciam só algumas fitas | Decisão do grupo |

## 10. Riscos e perguntas para o grupo

- **Código gerado por LLM roda com acesso ao computador.** Mitigação: só donos, branch, testes, aprovação, desfazer.
  Pergunta: a fase 5 entra no trabalho ou fica para depois?
- **Qual modelo para código** (`GERENTE_MODELO`) e quem paga.
- **Limite de bots por conta do Telegram:** conferir quantos bots o gerente pode criar antes de distribuir muitas fitas.
- **Um token, um programa:** com a Central ligada, `npm run perfil -- bot --gerente` passa a pedir a ela.
- **Computador ligado:** gerente e fitas param se o computador do K7 desligar.
