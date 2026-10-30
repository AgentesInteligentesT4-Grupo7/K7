# Fitas: criar, ativar, desativar e remover (roteiro para vídeo)

Este guia mostra, passo a passo, como cada parte de uma fita liga e desliga no K7, usando como exemplo a
**Rebobina** (a fita do YouTube, que tem código próprio, painel web e um serviço em Docker) e uma fita simples.
Cada cena tem: **o que mostrar**, **o comando**, **o que aparece** e **como desfazer**.

> **Dois jeitos de fazer tudo:** pela **página de administração** (`npm run admin`, só no próprio computador),
> clicando, ou pelo **terminal** (`npm run perfil`, `npm run fita`, `npm run site`). Cada cena mostra os dois; para o
> vídeo, a página é o caminho mais visual. Cada fita tem o **seu bot do Telegram** e a **sua lista de acesso**.

## 0. A página de administração

```bash
npm run admin -- --abrir
```

Abre `http://127.0.0.1:8770/#t=<token>` (o token muda a cada início; o endereço completo aparece no terminal). A página
só aceita o próprio computador e só funciona com o token: ninguém da rede consegue usar.

| Na página | Faz o mesmo que |
|---|---|
| **+ Nova fita** | `npm run perfil -- novo <nome>` |
| **⬇ Instalar fita** (mostra os arquivos de código e pede confirmação) | `npm run perfil -- instalar <origem>` |
| Fita → **Geral → Ligar / Desligar** (roda a fita com os canais dela; link do chat web) | `npm run dev -- --perfil <nome>` |
| Fita → **Geral → Canais e vitrine** | editar `canais` e `vitrine` no `perfil.yaml` |
| Fita → **Geral → Ligar / Desligar o código** | comentar ou descomentar `extensao:` |
| Fita → **Geral → Atualizar** | `npm run perfil -- atualizar <nome>` |
| Fita → **Telegram**: criar o bot (gerente ou token), quem pode usar, convites com QR, pessoas | `npm run perfil -- bot / convite / acessos` |
| Fita → **Serviços → Subir / Parar** (containers da fita) | `docker compose -f servicos/<s>/docker-compose.yml up -d` / `stop` |
| Fita → **Log** (atualiza sozinho) | a saída do terminal da fita |
| Fita → **Remover** (digitar o nome; opção de apagar os dados) | `npm run perfil -- remover <nome> [--apagar-dados]` |

Mudou canais, vitrine, código ou acesso com a fita ligada? A página avisa: desligue e ligue de novo para valer.
Fechar a página de administração (Ctrl+C no terminal) desliga as fitas que ela ligou.

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

Cada fita usa **um bot próprio** e **uma lista de acesso própria** (liberar alguém numa fita não libera nas outras;
dois processos com o mesmo bot brigam: erro 409).

**5.1 Criar o bot da fita (sem digitar token):**

```bash
npm run perfil -- bot demonstracao --gerente
```

O terminal mostra um QR code. Escaneie com o celular: o Telegram abre já com o nome e o @ sugeridos; toque para
criar. O K7 recebe o token sozinho, grava no `.env` da fita e aplica nome, descrição, menu de comandos e foto
(`bot/foto.jpg`). Precisa do bot gerente uma vez (seção "Ajustes manuais" do fim). Sem gerente: crie no @BotFather e
rode `npm run perfil -- bot demonstracao --token` (cole o token; **não mostre no vídeo**).

**5.2 Ligar:** no `perfil.yaml`, `canais: [telegram, terminal, web]` e, para convidar outras pessoas:

```yaml
telegram:
  acesso: convite
```

```bash
npm run dev -- --perfil demonstracao
```

**Aparece:** no log, `🔒 Acesso "convite": 1 dono(s) + 0 liberado(s)` e o bot conectado. Mande "oi": responde com a
identidade da fita.

**5.3 Convidar alguém:** no Telegram, mande `/convite Maria` para o bot. Ele devolve o **QR code**. A outra pessoa
escaneia, toca em **Iniciar** e já conversa; você recebe "Maria entrou pelo convite". Quem chega sem convite vira
**pedido**: você recebe os botões **Aprovar** e **Recusar**. `/acessos` mostra todo mundo. (No terminal:
`npm run perfil -- convite demonstracao --nome Maria` e `npm run perfil -- acessos demonstracao`.)

**Desligar:** Ctrl+C (o bot para de responder). Para desativar de vez, tire `telegram` de `canais`. Para tirar alguém:
`npm run perfil -- acessos demonstracao bloquear <id>`. Se faltar alguma variável, o K7 não sobe e diz exatamente o
que preencher e em qual `.env`.

**5.4 Trocar a fita do bot:** um bot do Telegram toca uma fita por vez. Na página de administração, o cartão
**📻 Bots do Telegram** (no topo da lista) mostra cada bot e a fita que está tocando nele. Escolha outra fita e clique
em **⇄ Trocar**: o K7 desliga a fita que estava no bot, dá o token e o canal Telegram à nova (se ela não tiver), troca o
nome, a descrição, os comandos e a foto do bot pelos dela e a liga. **Aparece:** no Telegram, o menu de comandos muda
(ex.: `/clima` some e entram os da Rebobina). Com `foco: restrito` no perfil.yaml, pedir "temperatura" à Rebobina
responde que esse bot não faz isso, o que ele faz e exemplos. Quem tem acesso e os dados são de cada fita: quem foi
convidado para a AgroMinds precisa de convite na Rebobina.

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
| Criar o bot da fita | `npm run perfil -- bot <nome> --gerente` (ou `--token`) |
| Ligar no Telegram | `telegram` em `canais` → `npm run dev -- --perfil <nome>` |
| Convidar alguém | `/convite <nome>` no bot (QR) ou `npm run perfil -- convite <nome>` |
| Ver e tirar acessos | `/acessos` no bot ou `npm run perfil -- acessos <nome> [bloquear <id>]` |
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

## 11. O que vem depois

- **Painel próprio de cada fita** (ex.: o painel da AgroMinds em Angular, para usuários e gráficos do tempo),
  descrito na spec da fita.
