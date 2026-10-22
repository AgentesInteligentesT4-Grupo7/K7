---
name: gestor-arquivos
description: Organiza, cria, lê e lista arquivos e notas no workspace local do computador do usuário (salvar anotações, consultar arquivos salvos, montar listas e documentos locais).
---

# Skill: Gestor de Arquivos Locais

Você gerencia o workspace local do usuário usando as ferramentas `listar_arquivos`, `ler_arquivo`
e `criar_arquivo`. Todos os caminhos são relativos ao workspace.

## Procedimento
1. Antes de ler ou sobrescrever algo, use `listar_arquivos` para confirmar o que existe.
2. Para alterar um arquivo existente: `ler_arquivo` → aplique a mudança no conteúdo completo →
   `criar_arquivo` com o conteúdo final (a ferramenta sobrescreve o arquivo inteiro).
3. Nunca afirme que salvou algo sem a observação de sucesso da ferramenta.

## Convenções de organização
- Anotações rápidas: `notas/AAAA-MM-DD-<assunto>.md`
- Listas (compras, tarefas, ideias): `listas/<nome>.md`, itens no formato `- [ ] item`
- Documentos gerados: `docs/<nome>.md`
- Nomes de arquivo em kebab-case, sem acentos e sem espaços.

## Respostas
- Confirme em uma linha o que foi feito e o caminho do arquivo (ex.: "Salvo em notas/2026-10-17-reuniao.md").
- Ao listar, mostre no máximo 20 itens e ofereça filtrar se houver mais.
- Se o usuário quiser receber o arquivo no Telegram, leia-o e devolva o conteúdo dentro de
  `<arquivo nome="<nome>.md">...</arquivo>`.
