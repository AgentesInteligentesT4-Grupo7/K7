# Spec: Personas (agentes com memória própria) e Estilos de Texto

**Versão:** 1.0
**Status:** Implementada (v1.0)
**Autor:** ParreiraClaw Agent
**Data:** 2026-10-22
**Reviewers:** Parreira

---

## 1. Resumo

Três conceitos com papéis distintos, todos declarativos (Markdown com frontmatter) e em camadas tocador → fita:

| Conceito | Responde a | Exemplo | Onde fica |
|---|---|---|---|
| **Skill** | *o que fazer* (procedimento) | `roteirista`, `pesquisador-web` | `skills/<nome>/SKILL.md` |
| **Persona** | *quem fala* (identidade, personalidade, memória própria) | Kael, a narradora, um consultor | `personas/<nome>.md` (fita) |
| **Estilo** | *como escrever* (tom e registro) | formal, infantil, jornalístico | `estilos/<nome>.md` (tocador e fita) |

Combinam livremente: a persona **Kael**, usando a skill `roteirista`, no estilo **infantil**.

## 2. Contexto e Motivação

- Pedido do usuário (2026-10-22): "múltiplos agentes onde cada agente poderia ter memória específica… 1 agente poderia ter 1 persona… talvez até skills"; "cada texto poderia ser de uma categoria específica… formal, ou de outra forma".
- Fazer isso com skills duplicaria conteúdo (uma skill por tom) e misturaria "o que fazer" com "quem fala".

## 3. Goals

- [x] G-01: Personas declaradas pela fita, com memória (conversas, resumo e fatos) **isolada por persona**.
- [x] G-02: Falar com uma persona (`/persona kael` ou `@kael ...`) e voltar ao agente (`/persona sair`).
- [x] G-03: **Vários agentes** colaborando: o agente principal consulta uma persona (`falar_com_persona`) ou encena um diálogo entre personas (`dialogo_entre_personas`), cada uma com a própria memória.
- [x] G-04: Persona pode restringir as skills que usa e ter um estilo padrão.
- [x] G-05: Estilos de texto prontos no tocador, extensíveis pela fita, escolhidos por pedido ("em tom formal"), por comando (`/estilo formal`), pela persona ou pelo padrão da fita.

## 4. Non-Goals

- NG-01: Voz própria por persona (fica para a próxima versão, junto do módulo de voz).
- NG-02: Personas executando ferramentas por conta própria dentro do diálogo (no v1.0 elas só falam).

## 5. Design

### 5.1 Persona (`personas/kael.md`)

```markdown
---
name: kael
description: Mecânico de 19 anos, protagonista de Neon Rain.
estilo: informal            # opcional: estilo padrão quando a persona fala
skills: [roteirista]        # opcional: só estas skills ficam disponíveis com ela ativa
---
Você é Kael, 19 anos, mecânico numa cidade chuvosa iluminada por neon. Teimoso, leal, fala pouco e direto…
```

- **Memória isolada:** a conversa e os fatos da persona usam o usuário `"<usuário>#persona:<nome>"` no banco.
  Resumo, fatos, `/memoria`, `/esquecer` e `/nova` valem para a persona ativa.
- **Ativar:** `/persona <nome>` (fica salvo por usuário), `@<nome> mensagem` (só aquela mensagem),
  `/persona sair` (volta ao agente), `/persona` (lista).
- **Multiagente** (ferramentas, presentes quando a fita tem personas):
  - `falar_com_persona(persona, mensagem)`: a persona responde em personagem, com a memória dela, e guarda a troca.
  - `dialogo_entre_personas(personas, situacao, turnos ≤ 8)`: as personas falam em turnos alternados; cada fala
    vê a cena e o que já foi dito; a transcrição fica registrada na memória de cada participante.

### 5.2 Estilo (`estilos/formal.md`)

```markdown
---
name: formal
description: Registro formal, impessoal, sem gírias.
aliases: [formal, formalmente]
---
Escreva em registro formal…
```

- **Tocador:** `estilos/` com os estilos prontos (formal, informal, técnico, didático, jornalístico, acadêmico,
  infantil, persuasivo, poético, conciso). **Fita:** `estilos/` próprios, que sobrescrevem pelo nome.
- **Precedência:** pedido na mensagem → estilo da persona ativa → `/estilo` do usuário → `estilo_padrao` do `perfil.yaml`.
- **Pedido na mensagem:** um alias do estilo junto de uma palavra de tom ("tom", "estilo", "linguagem",
  "registro", "escreva", "reescreva", "texto", "versão", "forma", "jeito", "modo").
- O estilo ativo entra no system prompt como `# Estilo de escrita`.

### 5.3 Preferências por usuário

Tabela `user_settings(user_id, key, value)`: `persona`, `estilo` e `controles` (JSON) ativos.

### 5.4 Controles do texto (níveis 1–10)

Ajuste fino que se soma ao estilo, em dimensões com nível de 1 a 10 (perspectiva: 1 a 3):
`complexidade`, `entonacao` (apelido `tom`), `sentimento`, `perspectiva` (1ª, 2ª ou 3ª pessoa), `foco`,
`surpresa`, `detalhe`, `originalidade`, `abstracao`.

- **Onde se define:** frontmatter `controles: { detalhe: 2, foco: 9 }` no estilo ou na persona;
  `/estilo formal detalhe=3 tom=2` (grava para o usuário); `detalhe=8` dentro da mensagem (só ela; o token sai do texto).
- **Precedência:** estilo → persona → `/estilo` → mensagem (o mais específico vence, por dimensão).
- **Sintaxe:** `nome=N` colado, para não confundir com texto comum ("meu foco: 2 coisas" não é controle).
- No system prompt vira `# Controles do texto`, com as âncoras de cada ponta (1 = …; 10 = …), e prevalece sobre o
  estilo em conflito. `/estilo padrao` zera estilo e níveis.

## 6. Edge Cases

| Cenário | Comportamento |
|---|---|
| Persona inexistente em `/persona x` ou `@x` | Lista as disponíveis; `@x` vira texto normal |
| Persona apagada da fita, mas ativa no usuário | Volta ao agente e avisa no log |
| Dois estilos citados na mesma mensagem | Vale o primeiro citado |
| `dialogo_entre_personas` com persona inexistente | Erro com a lista de personas |
