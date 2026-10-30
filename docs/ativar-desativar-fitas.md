# Fitas: criar, ativar, desativar e remover (roteiro para vídeo)

Este guia mostra, passo a passo, como cada parte de uma fita liga e desliga no K7, usando como exemplo a
**Rebobina** (a fita do YouTube, que tem código próprio, painel web e um serviço em Docker) e uma fita simples.
Cada cena tem: **o que mostrar**, **o comando**, **o que aparece** e **como desfazer**.

> **Situação hoje (v1):** instalar, ativar, desativar e remover fitas é feito **pelo terminal**
> (`npm run perfil`, `npm run fita`, `npm run site`) e editando o `perfil.yaml`. No navegador já existem o
> **site do K7** (vitrine com as fitas liberadas) e o **chat web** de cada fita. A **página de administração** (instalar,
> ligar e desligar fitas clicando, só em `127.0.0.1`) e o **`/fitas` no Telegram** (um bot só, trocando de fita) estão
> planejados, mas ainda não existem: a seção 11 diz o que muda quando chegarem. Grave o vídeo com o fluxo de hoje.

Para criar o conteúdo de uma fita (identidade, skills, guardrails, extensão), veja [criar-fita.md](criar-fita.md).

---

## 1. As estruturas de uma fita

| Estrutura | Onde fica | Liga com | Desliga com |
|---|---|---|---|
| **Pasta da fita** | `PERFIS_DIR/<fita>` (aqui `../ParreiraClaw-perfis/<fita>`) | `npm run perfil -- novo` ou `instalar` | `npm run perfil -- remover` |
| **Canal terminal** | processo `npm run chat` | `npm run chat -- --perfil <fita>` | `/sair` ou Ctrl+C |
| **Canal web** (chat no navegador) | processo `npm run web` | `npm run web -- --perfil <fita>` | Ctrl+C |
| **Vitrine do site** | `vitrine: true` no `perfil.yaml` + `npm run site` | `vitrine: true` | `vitrine: false` |
| **Canal Telegram** | processo `npm run dev`, bot próprio da fita | `telegram` em `canais` + token no `.env` da fita | Ctrl+C, ou tirar `telegram` de `canais` |
| **Módulos do tocador** (voz, anexos, pesquisa…) | `modulos:` no `perfil.yaml` | acrescentar o módulo | tirar o módulo |
| **Extensão** (código da fita) | `extensao: extensao/index.ts` | a linha `extensao:` | comentar a linha |
| **Serviços** (containers da fita) | `<fita>/servicos/...` | `docker compose ... up -d` | `docker compose ... down` |
| **Dados** gerados | `dados/<fita>` e `workspace/<fita>` no K7 | criados ao usar | `remover --apagar-dados` (ou apagar as pastas) |

Regra que vale para tudo: **mudou o `perfil.yaml` ou o `.env` da fita, reinicie o processo dela** (chat, web, bot
ou o site). A única exceção é a vitrine: o site relê a lista a cada acesso.

## 2. Antes de gravar

- Docker Desktop aberto (só para a cena da Rebobina).
- No `.env` do K7: `PERFIS_DIR=../ParreiraClaw-perfis`.
- Um terminal na pasta do K7, o explorador de arquivos na pasta das fitas, o navegador e o Telegram (celular ou
  desktop).
- Para não aparecerem chaves na tela: nunca abra os arquivos `.env` no vídeo. Use os `.env.example`.
- Dica: aumente a fonte do terminal e deixe o log mais limpo com `LOG_LEVEL=info`.

---

## Cena 1 — O que são as fitas (1 min)

**Mostrar:** a pasta `ParreiraClaw-perfis` com uma pasta por fita, e o terminal.

```bash
npm run perfil -- listar
```

**Aparece:** cada fita com emoji, versão, descrição, módulos e canais. Fita com erro no `perfil.yaml` aparece com
❌ e o motivo (bom para mostrar que o tocador valida tudo).

**Fala sugerida:** "O K7 é o tocador; cada fita transforma ele num agente diferente. A fita é uma pasta: identidade,
skills, e, se precisar, o próprio código."

## Cena 2 — Criar uma fita nova (3 min)

```bash
npm run perfil -- novo demonstracao
```

**Aparece:** a pasta `ParreiraClaw-perfis/demonstracao` com `perfil.yaml`, `skills/exemplo/SKILL.md`,
`ferramentas/exemplo.yaml.off`, `.env.example` e `README.md`.

**Mostrar no editor:** o `perfil.yaml`. Troque o nome, o emoji e as instruções (identidade). Os módulos começam
vazios e o canal começa só com o terminal (`canais: [terminal]`).

**Testar:**

```bash
npm run chat -- --perfil demonstracao
```

Pergunte "quem é você?": ela responde com a identidade que você escreveu. `/skills` lista as skills; `/sair` fecha.

**Desfazer:** cena 8 (remover).

## Cena 3 — Ligar no navegador (2 min)

```bash
npm run web -- --perfil demonstracao --abrir
```

**Aparece:** o chat no navegador, com o nome e o emoji da fita. Sem `WEB_PUBLIC`, o endereço leva um token depois do
`#` e só abre no próprio computador.

**Desligar:** Ctrl+C no terminal.

Para a fita aceitar o canal web pelo site, `web` precisa estar em `canais` (próxima cena).

## Cena 4 — Colocar e tirar da vitrine do site (3 min)

**Ativar:** no `perfil.yaml` da fita:

```yaml
canais: [terminal, web]
privacidade: publico
vitrine: true
```

```bash
npm run site
```

**Aparece:** `http://127.0.0.1:8780` com a animação da fita sendo encaixada e a vitrine. Clique na fita: o site liga o
chat dela por baixo (porta interna, só no computador) e abre o chat em `/fita/<nome>/`. No modo do site, o chat é
sempre público (sem token), com limite de mensagens por visitante.

**Desativar:** `vitrine: false` (ou apague a linha) e recarregue a página do site: a fita some da vitrine e o endereço
`/fita/<nome>/` responde "Essa fita não está disponível no site". O chat que já estava ligado só para quando o site
reinicia (Ctrl+C e `npm run site` de novo).

**Abrir na rede** (para outra pessoa acessar na apresentação): `SITE_HOST=0.0.0.0` no `.env` do K7; o terminal mostra
os endereços da rede.

## Cena 5 — Ligar e desligar o Telegram (4 min)

Cada fita usa **um bot próprio** (dois processos com o mesmo bot brigam: erro 409).

1. No Telegram, fale com o **@BotFather** → `/newbot` → escolha nome e usuário → copie o token. **Não mostre o
   token no vídeo** (corte ou desfoque).
2. Na pasta da fita: copie `.env.example` para `.env` e preencha `TELEGRAM_BOT_TOKEN` e
   `TELEGRAM_ALLOWED_USER_IDS` (seu ID do Telegram, por exemplo pelo @userinfobot).
3. No `perfil.yaml`: `canais: [telegram, terminal, web]`.
4. Ligue:

```bash
npm run dev -- --perfil demonstracao
```

**Aparece:** no log, a fita carregada e o bot conectado. Mande "oi" para o bot: responde com a identidade da fita.

**Desligar:** Ctrl+C (o bot para de responder). Para desativar de vez, tire `telegram` de `canais`. Se faltar
alguma variável, o K7 não sobe e diz exatamente o que preencher e em qual `.env`.

## Cena 6 — Uma fita com código: a Rebobina (6 min)

**Mostrar a pasta:** `extensao/` (o código: ferramenta `baixar_youtube`, biblioteca, nivelar, padronizar), `web/`
(painel com biblioteca e player), `servicos/ytdlp/` (container com yt-dlp e ffmpeg), `skills/`, `testes/`, e no
`perfil.yaml` a linha `extensao: extensao/index.ts`.

**Fala sugerida:** "Tudo o que é do YouTube mora na fita. O K7 não tem uma linha disso: se eu não uso a Rebobina, nada
dela é carregado."

**6.1 Ligar o serviço (na pasta da fita):**

```bash
cd ../ParreiraClaw-perfis/rebobina
docker compose -f servicos/ytdlp/docker-compose.yml up -d --build
curl http://127.0.0.1:8899/health
cd ../../ParreiraClaw
```

**6.2 Testes e comandos da fita (na pasta do K7):**

```bash
npm run fita -- rebobina testes       # os testes da fita, sem depender do tocador
npm run fita -- rebobina              # lista os comandos que a extensão oferece
npm run fita -- rebobina padronizar   # exemplo de comando da fita
```

**6.3 Ver funcionando:** `npm run site` → Rebobina. No log: `🧩 Extensão da fita carregada: baixar_youtube · 10
rota(s) web` e `⬇️ Downloads do YouTube: yt-dlp ... em http://127.0.0.1:8899`. Na página: o botão **🎵 Biblioteca**,
a barra lateral e o player, que vêm do painel da fita. Mande um link de vídeo **seu** ou com licença livre.

**6.4 Mostrar a separação:** abra outra fita (ex.: Tempero) pelo site: nada de biblioteca nem player.

**6.5 Desativar por partes:**

| O que desligar | Como | Efeito |
|---|---|---|
| Só o serviço | `docker compose -f servicos/ytdlp/docker-compose.yml stop` (na pasta da fita) | O chat abre; o log avisa "serviço de downloads fora do ar" e os pedidos de download dizem como subir |
| A extensão inteira | Comente `extensao:` no `perfil.yaml` e reinicie | A fita vira só conversa: sem `baixar_youtube`, sem painel; o K7 não carrega nenhum código dela |
| Da vitrine | `vitrine: false` | Some do site (cena 4) |
| Tudo do serviço | `docker compose -f servicos/ytdlp/docker-compose.yml down --rmi local -v` | Remove container, imagem e o volume temporário |

## Cena 7 — Instalar uma fita de outra origem (3 min)

```bash
npm run perfil -- instalar AgentesInteligentesT4-Grupo7/agrominds   # GitHub: tenta perfil-agrominds e agrominds
npm run perfil -- instalar https://github.com/<usuario>/<repo>.git  # URL Git
npm run perfil -- instalar ../outra-pasta/minha-fita                # pasta local
npm run perfil -- info agrominds                                    # manifesto e variáveis pendentes
npm run perfil -- atualizar agrominds                               # versão nova (mantém .env e dados)
```

**Aparece:**
- O instalador **não executa nada** da fita e recusa links simbólicos ou fitas acima de 100 MB.
- Se a fita traz **código** (extensão, scripts, Dockerfile), ele **lista os arquivos e pede para digitar "sim"**, porque o
  código roda com o mesmo acesso do K7. Atualizar pergunta de novo, já que o código pode ter mudado.
- No fim, ele cria o `.env` a partir do `.env.example` e diz o que falta preencher.

**Para o vídeo, sem mexer nas fitas reais:** instale uma **cópia** com outro nome,
`npm run perfil -- instalar ../ParreiraClaw-perfis/cozinha --nome cozinha-demo`.

## Cena 8 — Remover (2 min)

```bash
npm run perfil -- remover cozinha-demo                  # pede para digitar o nome; os dados ficam
npm run perfil -- remover cozinha-demo --apagar-dados   # também apaga dados/cozinha-demo
```

**Aparece:** a confirmação com o caminho que vai ser apagado e onde ficam os dados.

> ⚠️ **Remover apaga a pasta da fita.** As pastas em `ParreiraClaw-perfis` são os repositórios onde as fitas são
> editadas: no vídeo, remova só a cópia da cena 7 (ou uma fita criada na cena 2), nunca a `rebobina` original. Se a
> fita tinha serviço em Docker, desligue antes (tabela 6.5).

---

## 9. Resumo para a tela final

| Quero… | Comando ou mudança |
|---|---|
| Ver as fitas | `npm run perfil -- listar` |
| Criar | `npm run perfil -- novo <nome>` |
| Instalar | `npm run perfil -- instalar <origem>` (código → confirmar com "sim") |
| Conversar no terminal | `npm run chat -- --perfil <nome>` |
| Abrir no navegador | `npm run web -- --perfil <nome> --abrir` |
| Mostrar no site | `vitrine: true` + `canais` com `web` → `npm run site` |
| Ligar no Telegram | token no `.env` da fita + `telegram` em `canais` → `npm run dev -- --perfil <nome>` |
| Ligar o serviço da fita | `docker compose -f servicos/<serviço>/docker-compose.yml up -d` (na pasta da fita) |
| Comandos e testes da fita | `npm run fita -- <nome> [comando \| testes]` |
| Desligar o código da fita | comentar `extensao:` no `perfil.yaml` |
| Tirar do site | `vitrine: false` |
| Atualizar | `npm run perfil -- atualizar <nome>` |
| Remover | `npm run perfil -- remover <nome> [--apagar-dados]` |

## 10. Problemas comuns (bom ter à mão durante a gravação)

| Sintoma | Causa e solução |
|---|---|
| "Porta em uso" | Outro processo do K7 aberto: feche-o, ou use `--porta` (web) ou `SITE_PORT` (site). |
| Telegram: erro 409 | O mesmo bot ligado em dois lugares (ex.: `npm run dev` e o Docker): deixe um só. |
| "Preencha em …/.env" | Falta variável da fita; a mensagem diz qual e para quê. |
| A fita não aparece na vitrine | `vitrine` não está `true`, falta `web` em `canais` ou o `perfil.yaml` tem erro (`perfil -- listar` mostra o ❌). |
| Mudei o `perfil.yaml` e nada mudou | Reinicie o processo da fita (ou o site). |
| Extensão não carregou | O log diz o motivo (arquivo não encontrado, falta `export default function ativar`). |
| "Serviço de downloads fora do ar" | Suba o container da fita (cena 6.1). |

## 11. O que vem depois (e muda o vídeo)

- **Página de administração** (só em `127.0.0.1`): lista das fitas com botões para instalar (com a mesma confirmação
  de código), ligar e desligar canais, vitrine e extensão, e remover, sem editar arquivo nem usar o terminal. As cenas
  2, 4, 5, 7 e 8 passam a ter a versão "clicando".
- **Convite por QR code, por fita** (no lugar de copiar o ID para `TELEGRAM_ALLOWED_USER_IDS`):
  - Cada fita continua com o **seu próprio bot** e a **sua própria lista de acesso** (em `dados/<fita>`). Liberar
    alguém na AgroMinds não libera a Cozinha.
  - `npm run perfil -- convite <fita>` gera o link `https://t.me/<bot da fita>?start=<código>` e o QR dele. A pessoa
    escaneia, toca em **Iniciar**, e o bot recebe o ID dela sozinho. O código é de uso único e expira.
  - Quem chega sem código vira "pedido de acesso": o dono recebe no Telegram os botões **Aprovar** e **Recusar**.
  - Liga por fita no `perfil.yaml` (`telegram: { acesso: convite }`). Sem isso, a fita segue com a lista do `.env`.
  - Na cena 5, o passo 2 passa a ser "gere o convite e mostre o QR para a pessoa escanear".
- **Bot da fita criado pelo sistema** (bots gerenciados, Bot API 9.6):
  - **Uma vez só:** um bot "gerente" do K7, criado no @BotFather com o modo de gerenciar bots ligado.
  - **Para cada fita:** `npm run perfil -- bot <fita>` gera o link `https://t.me/newbot/<gerente>/<sugestão>?name=<Nome>`.
    O dono confirma no Telegram com um toque, o K7 recebe o token e grava no `.env` da fita.
  - **Configuração automática:** nome, descrição, menu de comandos e foto, a partir do `perfil.yaml`.
  - **Sem o gerente:** colar o token do BotFather e o K7 configura o resto.
  - Na cena 5, os passos 1 e 2 viram "gerar o bot da fita e confirmar no celular".
- **Painel próprio de cada fita** (ex.: o painel da AgroMinds em Angular, para usuários e gráficos do tempo),
  descrito na spec da fita.
