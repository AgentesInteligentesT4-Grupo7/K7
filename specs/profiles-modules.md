# Spec: Tocador, Módulos e Perfis Instaláveis ("fitas")

**Versão:** 1.1
**Status:** Implementada em parte (ver "Estado da implementação")
**Autor:** ParreiraClaw Agent
**Data:** 2026-10-21
**Reviewers:** Parreira

---

## 1. Resumo

O ParreiraClaw passa a ser um **tocador**: um núcleo estável (loop do agente, memória, orquestrador de LLMs, canais, segurança) com **módulos** de funcionalidade (voz, voz clonada, imagens, pesquisa web, anexos…). Cada finalidade vira um **perfil instalável** — a "fita" — que declara a identidade do agente, quais módulos usar, suas skills, avaliações e configuração. Perfis ficam em pastas próprias ou em repositórios Git separados e são instalados no tocador por um comando. Um mesmo tocador roda vários perfis, cada um com seu bot, seus dados e seus segredos.

### Estado da implementação (v1.1)

| Item | Estado |
|---|---|
| Módulos `arquivos`, `voz`, `voz-clonada`, `refinamento` (RF-02) | ✅ Registro em `src/modules/registry.ts`, skills em `modulos/<id>/skills/`; módulo desligado não registra ferramentas, comandos nem skills. O contrato completo do RF-01 (`ferramentas()`, `comandos()`, `healthCheck()` por módulo) ainda é feito no `createCore`. |
| Manifesto (RF-03), execução com `--perfil` (RF-06), isolamento (RF-07), skills em camadas (RF-08), compatibilidade (RF-09) | ✅ `src/profiles/`. O manifesto ganhou `canais` (telegram, terminal). |
| Instalador (RF-04, RF-05, RF-10, RF-12) | ✅ `npm run perfil -- novo|instalar|listar|info|atualizar|remover`. Git só por `https://`, `ssh://` ou `git@` (transportes `ext`/`file` bloqueados); npm por `npm pack --ignore-scripts` e extração própria do `.tgz` (sem links, sem caminhos fora do destino). |
| Migração (RF-11) | ✅ Perfis `pessoal`, `promo` e `historias` em `../ParreiraClaw-perfis`; o `pessoal` aponta para o banco e as vozes antigos. |
| Canais em `src/canais/<canal>/` | ✅ `telegram`, `terminal`, `comum`. Previsto: `web` (chat no navegador no estilo do app desktop do Claude). |
| Ferramentas HTTP declarativas (RF-13), módulos externos/MCP (RF-14) | ⏳ Pendentes. |
| Módulo `imagens` | ⏳ Pendente (spec image-generation); fica no tocador, para todos os perfis. |

---

## 2. Contexto e Motivação

**Problema:**
- O mesmo código está sendo usado para finalidades diferentes (agente pessoal, bot de promoções, histórias ilustradas) por meio de **cópias do projeto**, que divergem: correções feitas numa cópia precisam ser refeitas à mão nas outras.
- Juntar tudo num único agente criaria um "monstro": ferramentas demais no contexto do LLM (mais tokens, mais erros de escolha), serviços pesados obrigatórios e mistura de níveis de segurança (agente pessoal × bot público).

**Evidências (2026-10-21):**
- Três cópias já divergiram: o `ParreiraClaw-Promo` foi copiado antes do orquestrador e da identidade configurável; o `AgroMinds` foi publicado ainda com o OpenCode ligado e um modelo do Groq aposentado. As correções ficaram só no `ParreiraClaw`.
- Cada ferramenta ativa é enviada ao LLM em toda mensagem; módulos de imagens/histórias acrescentariam ~6 ferramentas às 5 atuais.

**Por que agora:**
O usuário vai iniciar dois projetos pessoais (promoções e histórias ilustradas) sobre a mesma base. Organizar antes evita uma quarta e quinta cópia.

**Fora deste desenho:** o **AgroMinds** é um projeto do grupo da faculdade, em repositório próprio (`AgentesInteligentesT4-Grupo7/AgroMinds`), e **não é alterado** por esta spec.

---

## 3. Goals (Objetivos)

- [ ] G-01: **Módulos** com contrato único (ferramentas, skills, comandos, serviços, health check), ligados por perfil.
- [ ] G-02: **Perfis declarativos** (manifesto + skills + avaliações + configuração), sem código executável.
- [ ] G-03: **Instalação de perfis** a partir de uma pasta local ou de um repositório Git, com atualização e remoção.
- [ ] G-04: **Isolamento por perfil:** identidade, segredos (`.env`), banco SQLite, vozes, workspace e bot do Telegram próprios.
- [ ] G-05: Vários perfis rodando ao mesmo tempo, em processos separados (terminal ou Docker).
- [ ] G-06: Migrar o ParreiraClaw atual para o perfil `pessoal` e criar `promo` e `historias`, aposentando a cópia `ParreiraClaw-Promo`.

**Métricas de sucesso:**
| Métrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Cópias do código para finalidades pessoais | 2 (ParreiraClaw, ParreiraClaw-Promo) | 1 tocador + N perfis | v1 |
| Esforço para aplicar uma correção do núcleo em todos os perfis | Manual, por cópia | Zero (código único) | v1 |
| Ferramentas enviadas ao LLM num perfil sem o módulo de imagens | — | Nenhuma ferramenta de imagem | v1 |
| Instalar um perfil de um repositório Git | Impossível | 1 comando | v1 |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: **Perfis com código** (JavaScript/TypeScript, scripts, binários). Perfis trazem conteúdo e **descrições** de APIs (RF-13); código entra só como **módulo** — interno ou externo com confiança explícita (RF-14). Evita executar código baixado sem autorização.
- NG-02: Alterar ou migrar o **AgroMinds**.
- NG-03: Loja/registro público de perfis. A instalação é por caminho local ou URL Git.
- NG-04: Vários perfis no **mesmo processo** (cada perfil = um processo, com seu próprio bot).
- NG-05: Instalação no formato `npx @<escopo>/<perfil> install`. O `npx` **executa o código do pacote**: cada perfil precisaria trazer um instalador em código, e instalar uma fita significaria rodar código baixado (contradiz o NG-01). A mesma praticidade vem do instalador do tocador aceitando atalhos (`instalar @parreira/promo`, `instalar parreira/promo`, RF-04). Se no futuro o próprio tocador for publicado no npm, o equivalente seguro será `npx parreiraclaw perfil instalar @parreira/promo` — o código executado é sempre o do tocador.

---

## 5. Usuários e Personas

**Usuário primário:** Parreira, que mantém um único tocador e vários perfis pessoais (`pessoal`, `promo`, `historias`), alguns versionados em repositórios privados próprios.

---

## 6. Requisitos Funcionais

### 6.1 Requisitos Principais

| ID | Requisito | Prioridade | Critério de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | **Contrato de módulo** (`src/modules/<id>/`): `id`, `descricao`, `requer` (serviços e variáveis de ambiente), `ferramentas()`, `skillsDir` (skills que vêm com o módulo), `comandos()` (Telegram/terminal), `healthCheck()`. O núcleo registra só os módulos ligados no perfil. | Must | Um módulo desligado não registra ferramentas, comandos nem skills. |
| RF-02 | **Módulos iniciais** (extraídos do código atual): `voz` (Whisper + TTS), `voz-clonada` (Chatterbox), `refinamento` (loop criador ↔ crítico), `arquivos` (ferramentas do workspace). Futuros: `imagens`, `historias`, `pesquisa-web`, `anexos`, `promocoes`. | Must | O perfil `pessoal` com os 4 módulos se comporta como o ParreiraClaw de hoje (todos os testes atuais passam). |
| RF-03 | **Manifesto do perfil** (`perfil.yaml`): `nome`, `versao`, `descricao`, `identidade` (nome do agente, emoji, dono, propósito, instruções), `modulos` (lista e opções de cada um), `requer` (versão mínima do tocador), `variaveis` (chaves de ambiente necessárias, com descrição), `privacidade` (padrão). Estrutura: `perfil.yaml`, `skills/`, `evals/`, `.env.example`, `README.md`. | Must | Manifesto inválido gera erro claro apontando o campo. |
| RF-04 | **Instalação:** `npm run perfil -- instalar <origem> [--nome x]`, com quatro formas de origem: (a) **pasta local** (`./perfis-src/promo`); (b) **URL Git** (`https://github.com/<usuario>/perfil-promo`); (c) **atalho do GitHub** `<usuario>/<nome>` → `github.com/<usuario>/perfil-<nome>` (ex.: `parreira/promo`); (d) **pacote npm** `@<escopo>/<nome>` (ex.: `@parreira/promo`), baixado com `npm pack` **sem executar scripts** e extraído do `.tgz`. Em todas: copia para `perfis/<nome>/`, valida o manifesto e o RF-10, confere versão do tocador e módulos, cria `perfis/<nome>/.env` a partir do `.env.example` e lista as variáveis a preencher. | Must | `instalar parreira/promo` e `instalar @parreira/promo` produzem o mesmo perfil; repositórios privados funcionam com as credenciais Git/npm já configuradas. |
| RF-05 | **Gestão:** `npm run perfil -- listar | atualizar <nome> | remover <nome>`. `atualizar` faz `git pull` em perfis vindos de Git e revalida; `remover` pede confirmação e **não apaga** os dados do perfil, a menos que receba `--apagar-dados`. | Must | Atualizar um perfil não toca no `.env` nem nos dados dele. |
| RF-06 | **Execução:** `npm run dev -- --perfil historias`, `npm run chat -- --perfil promo`, `npm run eval -- --perfil pessoal conversa`; no Docker, `PERFIL=historias` (um serviço do compose por perfil). Sem `--perfil`, usa `PERFIL_PADRAO`. | Must | Dois perfis rodam ao mesmo tempo, cada um com o seu bot. |
| RF-07 | **Isolamento:** cada perfil tem `perfis/<nome>/.env` (segredos, fora do Git), `dados/<nome>/` (SQLite, vozes, cache, saídas), `workspace/<nome>/` e skills próprias. O `.env` do tocador guarda só o que é comum (ex.: endereços de serviços locais), e o do perfil sobrescreve. | Must | Nenhum perfil lê o banco, as vozes ou os arquivos de outro. |
| RF-08 | **Skills em camadas:** skills dos módulos ligados + skills do perfil; em conflito de nome, vale a do perfil. Marcadores `{{AGENT_NAME}}` etc. são preenchidos com a identidade do perfil. | Must | O perfil pode sobrescrever uma skill de módulo sem editar o tocador. |
| RF-09 | **Compatibilidade:** o manifesto declara `requer.tocador: ">=1.0"` e módulos necessários; perfil incompatível não sobe e explica o que falta (ex.: "o perfil historias precisa do módulo imagens, disponível a partir do tocador 1.2"). | Must | Mensagem acionável em vez de erro genérico. |
| RF-10 | **Segurança na instalação:** o instalador **recusa** perfis com arquivos executáveis ou de código (`.js`, `.ts`, `.mjs`, `.cjs`, `.py`, `.sh`, `.ps1`, `.bat`, `.exe`, `package.json`…), mostra a origem e o resumo do manifesto antes de concluir e nunca executa nada do perfil. | Must | Um perfil com `install.sh` é recusado com a lista dos arquivos proibidos. |
| RF-11 | **Migração:** o ParreiraClaw atual vira o perfil `pessoal` (identidade, skills, `.env`, banco e vozes movidos para a nova estrutura); `promo` e `historias` são criados a partir de modelos. A pasta `ParreiraClaw-Promo` pode ser apagada depois de migrada. | Must | Após migrar, o bot pessoal responde com o mesmo histórico de antes. |
| RF-13 | **Ferramentas HTTP declarativas:** o perfil pode descrever APIs REST simples em `ferramentas/*.yaml` (nome, descrição, método, URL, parâmetros com tipo, parâmetros fixos, autenticação via variável do `.env` do perfil, `hosts_permitidos`, campos da resposta a extrair). O módulo genérico `http` do tocador as transforma em ferramentas do LLM. Garantias: só os hosts declarados (e nunca endereços internos), chave lida do `.env` e jamais exposta ao LLM, timeout de 15 s, resposta limitada (ex.: 100 KB) e marcada como dado externo. | Must | Um perfil com `clima.yaml` (Open-Meteo) ganha a ferramenta `previsao_do_tempo` sem nenhum código. |
| RF-14 | **Módulos externos (código com confiança explícita):** integrações com lógica (cálculos, várias chamadas, OAuth, arquivos) entram como módulo em pacote/repositório separado, instalado por `npm run modulo -- instalar <origem>` com **aviso e confirmação** ("isto é código e vai rodar na sua máquina"), versão/commit fixos e registro em `modulos/.confiaveis.json`. Alternativa equivalente: **servidores MCP** declarados no perfil, que só iniciam após a mesma confirmação. Um perfil que exija módulo externo não instalado explica como instalá-lo. | Should | Um perfil que depende do módulo externo `agro-dados` não sobe sem ele e mostra o comando de instalação; instalar exige confirmação explícita. |
| RF-12 | **Modelo de perfil:** `npm run perfil -- novo <nome>` gera um perfil vazio (manifesto comentado, skill de exemplo, `.env.example`, README), pronto para virar um repositório Git próprio. | Should | Criar um perfil novo leva um comando. |

### 6.2 Fluxo Principal (Happy Path)

1. `npm run perfil -- novo historias` → edita `perfis/historias/perfil.yaml` (identidade, módulos `imagens`, `historias`, `voz`).
2. (Opcional) publica a pasta como repositório privado `perfil-historias`.
3. Em outra máquina: `npm run perfil -- instalar https://github.com/<usuario>/perfil-historias` → preenche `perfis/historias/.env` (token do bot de histórias).
4. `npm run dev -- --perfil historias` → bot de histórias online, só com as ferramentas de imagem e roteiro.
5. Em paralelo, `npm run dev -- --perfil pessoal` continua o agente pessoal, sem ferramentas de imagem.

### 6.3 Fluxos Alternativos

- **Módulo exigido indisponível** (ex.: serviço ComfyUI desligado): o perfil sobe, o módulo aparece como "indisponível" em `/start` e no log, e as ferramentas dele não são oferecidas ao LLM até o serviço voltar.
- **Atualização de perfil que exige tocador mais novo:** `atualizar` mantém a versão anterior e avisa.

---

## 7. Requisitos Não-Funcionais

| ID | Requisito | Valor alvo | Observação |
|----|-----------|-----------|------------|
| RNF-01 | Startup de um perfil | < 3 s até o bot ouvir | Módulos carregam serviços de forma preguiçosa. |
| RNF-02 | Custo de contexto | Só ferramentas dos módulos ligados | Mede-se pelo tamanho do system prompt por perfil. |
| RNF-03 | Retrocompatibilidade | Sem `--perfil` e sem pasta `perfis/`, o tocador roda como hoje (perfil implícito a partir do `.env` raiz) | Migração gradual. |

---

## 8. Design e Interface

```
ParreiraClaw (tocador)
├── src/agent, llm, memory, skills, tools   núcleo: AgentLoop, memória, orquestrador, segurança
├── src/canais/          canais plugáveis: telegram/, terminal/, comum/ (futuro: web/)
├── src/modules/         registro dos módulos: voz, voz-clonada, refinamento, arquivos (futuro: imagens, …)
├── modulos/<id>/skills/ skills que vêm com cada módulo
├── src/profiles/        manifesto, carregamento (--perfil) e instalador
├── dados/<perfil>/      SQLite, vozes — isolados por perfil (DADOS_DIR; no Docker, no volume)
└── workspace/<perfil>/

ParreiraClaw-perfis (fora do repositório; PERFIS_DIR=../ParreiraClaw-perfis)
├── pessoal/             perfil.yaml · skills/ · evals/ · .env (segredos) · README.md
├── promo/
└── historias/           (pode virar github.com/<usuario>/perfil-historias)
```

Precedência do ambiente de um perfil (o último vence): `.env` do tocador (sem `TELEGRAM_BOT_TOKEN` e
sem `AGENT_*`) → pastas isoladas → `perfil.yaml` → `.env` do perfil (linhas vazias não apagam o herdado).

```yaml
# perfis/historias/perfil.yaml
nome: historias
versao: 0.1.0
descricao: Roteiros e histórias ilustradas (HQ, mangá) com personagens consistentes.
requer:
  tocador: ">=1.2"
identidade:
  nome: Contador
  emoji: 📖
  dono: Parreira
  proposito: assistente de roteiro e ilustração de histórias
  instrucoes: |
    Ajude a escrever roteiros cena por cena e a gerar os painéis com os personagens consistentes.
modulos:
  imagens: { estilo_padrao: hq, qualidade: rapido }
  historias: {}
  voz: {}
canais: [telegram, terminal]
privacidade: publico
variaveis:
  TELEGRAM_BOT_TOKEN: Token do bot de histórias (@BotFather)
```

---

## 9. Modelo de Dados

Sem mudança de esquema: cada perfil usa o mesmo esquema SQLite em `dados/<perfil>/agente.db`. Registro local dos perfis instalados em `perfis/.instalados.json` (nome, origem, versão, commit Git, data).

---

## 10. Integrações e Dependências

| Dependência | Tipo | Impacto se indisponível |
|-------------|------|------------------------|
| Git (CLI) | Necessário só para instalar/atualizar perfis por URL | Instalação por pasta local continua funcionando. |
| Serviços de módulos (Ollama, Kokoro, Whisper, Chatterbox, ComfyUI) | Por módulo | Só o módulo correspondente fica indisponível. |

---

## 11. Edge Cases e Tratamento de Erros

| Cenário | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: Dois perfis com o mesmo token do Telegram | `.env` copiado sem trocar o token | O segundo a subir detecta o conflito (409) e explica que cada perfil precisa de um bot próprio. |
| EC-02: Perfil com código | Repositório com `.js`, `.sh` etc. | Instalação recusada (RF-10). |
| EC-03: Skill do perfil com o mesmo nome de uma de módulo | Sobrescrita intencional | Vale a do perfil, com aviso no log. |
| EC-04: Perfil removido com dados | `remover` sem `--apagar-dados` | Dados preservados em `dados/<nome>/`; reinstalar recupera tudo. |
| EC-05: `.env` do perfil faltando variável obrigatória | Variável listada em `variaveis` vazia | O perfil não sobe e lista exatamente o que preencher. |

---

## 12. Segurança e Privacidade

- **Perfis sem código** (NG-01, RF-10): instalar uma fita nunca executa nada.
- **Segredos por perfil:** `perfis/<nome>/.env` fica fora do Git (do tocador e do perfil); o `.env.example` do perfil documenta as variáveis sem valores.
- **Dados isolados por perfil** (RF-07): o bot de promoções (público) nunca enxerga memória, vozes ou arquivos do perfil pessoal.

---

## 13. Plano de Rollout

1. **Módulos:** extrair `voz`, `voz-clonada`, `refinamento` e `arquivos` para o contrato do RF-01, sem mudar comportamento (todos os testes atuais passam).
2. **Perfis locais:** manifesto, carregamento por `--perfil`, isolamento de `.env`/dados/workspace; migrar o atual para `perfis/pessoal` (RF-11).
3. **Instalador:** `novo`, `instalar` (pasta e Git), `listar`, `atualizar`, `remover`, com as regras do RF-10.
4. **Perfis novos:** `promo` (a partir do `ParreiraClaw-Promo`, depois apagar a cópia) e `historias`.
5. **Docker:** um serviço por perfil no compose (`PERFIL=<nome>`).
6. Módulos `imagens` e `historias` (spec image-generation) passam a ser desenvolvidos já neste formato.

**Impacto em outras specs:** `architecture.md` (núcleo + módulos + perfis), `channels.md` (canais por perfil), `image-generation.md` (vira os módulos `imagens` e `historias`).

---

## 14. Open Questions

- OQ-01: Os perfis pessoais (`pessoal`, `promo`, `historias`) ficam como pastas locais por enquanto, ou cada um já nasce como repositório privado no seu GitHub?
- OQ-02: O nome do tocador continua "ParreiraClaw" (com cada perfil tendo o próprio nome de agente), ou prefere um nome neutro para o tocador?
- OQ-03: A pasta `ParreiraClaw-Promo` tem algum dado que precise ser preservado (conversas, vozes), ou pode ser descartada depois de criar o perfil `promo`?
- OQ-05: O AgroMinds continua como projeto separado do grupo (recomendado). Se no futuro rodar sobre o tocador, as APIs simples viram ferramentas declarativas (RF-13) e as integrações complexas um módulo externo do grupo (RF-14) — decisão do grupo, não desta spec.
- OQ-04: Distribuir perfis pelo **GitHub** (mais simples, repositórios privados já funcionam) ou também pelo **npm** (`@parreira/...` exige uma conta npm com esse escopo e, para pacotes privados, plano pago no npm)? Proposta: GitHub primeiro; npm opcional depois.
